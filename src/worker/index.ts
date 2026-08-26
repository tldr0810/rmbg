/**
 * The Worker: a Hono app under /api, static assets for everything else.
 *
 * Route map (all responses JSON unless noted):
 *   GET    /api/health                      open   deploy-verification contract
 *   GET    /api/state                       open   bootstrap: agents + handshake + admin flags
 *   POST   /api/connect                     admin  start a Manyfold handshake
 *   POST   /api/connect/:id/poll            admin  poll it (2s cadence from the browser)
 *   DELETE /api/connect/:id                 admin  cancel it
 *   GET    /api/agents                      admin  connected agents (never tokens)
 *   POST   /api/agents/:agentId/verify      admin  re-run the non-billing auth probe
 *   DELETE /api/agents/:agentId             admin  disconnect + drop its conversation
 *   GET    /api/agents/:agentId/messages    admin  chat history
 *   DELETE /api/agents/:agentId/messages    admin  reset the conversation
 *   POST   /api/agents/:agentId/chat        admin  one chat turn (text/event-stream)
 *   POST   /api/remove-bg                   open   background removal (202 on the agent path)
 *   PUT    /api/job/:jobId/output           ticket the agent uploads its cutout here
 *   POST   /api/job/:jobId/note             ticket the agent reports having nothing to upload
 *   GET    /api/job/:jobId/status           open   poll a 202'd job: status + agent's note
 *
 * "admin" routes require the x-admin-password header — but only when the
 * ADMIN_PASSWORD secret is set. Without it the app is open, which is what makes
 * zero-config deploys work; set the secret before sharing the URL.
 */

import { Hono } from 'hono';
import type { AppState } from '../shared/types';
import { HttpError, type Env } from './types';
import { ensureSchema } from './db';
import { ConfigError, safeEqual } from './crypto';
import { A2AError } from './a2a';
import {
  cancelConnect,
  disconnectAgent,
  getConnectSession,
  listConnectedAgents,
  pollConnect,
  startConnect,
  verifyAgent,
} from './connect';
import { getConversation, handleChatTurn, resetConversation } from './chat';
import { assertUsableCutoutBytes, handleRemoveBg, type RemoveBgRequest } from './remove-bg';
import {
  MAX_NOTE_CHARS,
  MAX_OUTPUT_BYTES,
  consumeJobTicket,
  getJobNote,
  getJobStatus,
  inputDigestFor,
  jobIdFromInputKey,
  markInputFetched,
  outputKeyFor,
  setJobNote,
  verifyJobTicket,
} from './job';
import { loadAppSettings, saveAppSettings } from './settings-manager';

const SERVICE = 'cloudflare-worker-starter';

/** Upper bound on a posted failure note before it is refused outright, rather than truncated. */
const MAX_NOTE_BODY_CHARS = 64 * 1024;

const app = new Hono<{ Bindings: Env }>();

/**
 * The two routes the agent itself calls — its cutout, or its reason for not having one.
 * Both are authorized by the job ticket rather than by the admin password or an Origin.
 */
const isAgentJobLeg = (method: string, path: string): boolean =>
  (method === 'PUT' && /^\/api\/job\/[a-f0-9]{32}\/output$/.test(path)) ||
  (method === 'POST' && /^\/api\/job\/[a-f0-9]{32}\/note$/.test(path));

/** GET /api/job/:jobId/status — public for the same reason /api/remove-bg is. */
const isJobStatus = (method: string, path: string): boolean =>
  method === 'GET' && /^\/api\/job\/[a-f0-9]{32}\/status$/.test(path);

/**
 * `c.executionCtx.waitUntil`, or undefined where there is no execution context — Hono
 * throws rather than returning null when a request is dispatched without one, which is how
 * every unit test calls `app.request`. Work scheduled through this is best-effort by
 * definition, so having none is a degradation, not an error.
 */
const waitUntilOf = (c: {
  executionCtx: { waitUntil: (promise: Promise<unknown>) => void };
}): ((promise: Promise<unknown>) => void) | undefined => {
  try {
    const ctx = c.executionCtx;
    return (promise: Promise<unknown>) => ctx.waitUntil(promise);
  } catch {
    return undefined;
  }
};

/* ───────── middleware ───────── */

app.use('/api/*', async (c, next) => {
  await ensureSchema(c.env.DB);
  await next();
});

// Same-origin check on every mutation: browsers always send Origin on cross-site
// POSTs, so this shuts down CSRF without cookies or tokens.
app.use('/api/*', async (c, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
    // The agent's own legs are exempt: the caller is an agent running curl, not a browser, so
    // it has no Origin to send. CSRF is about ambient credentials being replayed by a browser,
    // and these routes have none — they are authorized solely by an unguessable job ticket.
    if (isAgentJobLeg(c.req.method, new URL(c.req.url).pathname)) {
      return next();
    }
    const origin = c.req.header('origin');
    if (!origin) {
      throw new HttpError(403, 'origin_required', 'Mutation requests must include a same-origin Origin header.');
    }
    if (origin !== new URL(c.req.url).origin) {
      throw new HttpError(403, 'invalid_origin', 'Cross-origin requests are not allowed.');
    }
  }
  await next();
});

const adminPassword = (env: Env): string | null => {
  const value = (env.ADMIN_PASSWORD ?? '').trim();
  return value.length > 0 ? value : null;
};

const adminHeaderOk = (c: { env: Env; req: { header: (name: string) => string | undefined } }): boolean => {
  const required = adminPassword(c.env);
  if (!required) return true;
  return safeEqual(c.req.header('x-admin-password') ?? '', required);
};

// Everything except /api/health, /api/state, /api/remove-bg, the agent's own job legs, and
// GET /api/r2/* image fetching needs the password (when one is set).
app.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const isPublicR2Image = path.startsWith('/api/r2/') && path !== '/api/r2/list' && c.req.method === 'GET';
  if (
    path !== '/api/health' &&
    path !== '/api/state' &&
    path !== '/api/remove-bg' &&
    !isAgentJobLeg(c.req.method, path) &&
    !isJobStatus(c.req.method, path) &&
    !isPublicR2Image &&
    !adminHeaderOk(c)
  ) {
    throw new HttpError(401, 'admin_password_invalid', 'This deployment requires the admin password.');
  }
  await next();
});

/* ───────── error mapping ───────── */

app.onError((error, c) => {
  if (error instanceof HttpError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
  }
  if (error instanceof ConfigError) {
    return c.json({ error: { code: 'misconfigured', message: error.message } }, 400);
  }
  if (error instanceof A2AError) {
    return error.retryable
      ? c.json({ error: { code: 'manyfold_unavailable', message: error.message } }, 502)
      : c.json({ error: { code: 'manyfold_rejected', message: error.message } }, 400);
  }
  console.error('unhandled', error);
  return c.json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500);
});

/* ───────── routes ───────── */

app.get('/api/health', (c) =>
  c.json({ status: 'ok', service: SERVICE, time: new Date().toISOString() }),
);

app.get('/api/state', async (c) => {
  const [session, agents] = await Promise.all([
    getConnectSession(c.env),
    listConnectedAgents(c.env),
  ]);
  const state: AppState = {
    service: SERVICE,
    adminRequired: adminPassword(c.env) !== null,
    adminOk: adminHeaderOk(c),
    connect: { session },
    agents,
  };
  return c.json(state);
});

app.post('/api/connect', async (c) => {
  const session = await startConnect(c.env, c.req.url);
  return c.json({ connect: session }, 201);
});

app.post('/api/connect/:connectId/poll', async (c) => {
  const outcome = await pollConnect(c.env, c.req.param('connectId'));
  return c.json(outcome);
});

app.delete('/api/connect/:connectId', async (c) => {
  await cancelConnect(c.env, c.req.param('connectId'));
  return c.json({ ok: true });
});

app.get('/api/agents', async (c) => c.json({ agents: await listConnectedAgents(c.env) }));

app.post('/api/agents/:agentId/verify', async (c) =>
  c.json({ agent: await verifyAgent(c.env, c.req.param('agentId')) }),
);

app.delete('/api/agents/:agentId', async (c) => {
  await disconnectAgent(c.env, c.req.param('agentId'));
  return c.json({ ok: true });
});

app.get('/api/agents/:agentId/messages', async (c) =>
  c.json(await getConversation(c.env, c.req.param('agentId'))),
);

app.delete('/api/agents/:agentId/messages', async (c) => {
  await resetConversation(c.env, c.req.param('agentId'));
  return c.json({ ok: true });
});

app.post('/api/agents/:agentId/chat', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { message?: unknown } | null;
  if (!body || typeof body.message !== 'string') {
    throw new HttpError(400, 'bad_request', 'Body must be JSON with a string "message".');
  }
  return handleChatTurn({
    env: c.env,
    agentId: c.req.param('agentId'),
    message: body.message,
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  });
});

/**
 * Background removal.
 *
 * Answers 202 with `{ jobId, statusUrl }` whenever the request goes to a Manyfold agent: a
 * turn takes about five minutes, the A2A stream dies at 126 seconds, and a browser will
 * not hold a fetch open that long anyway. The agent's turn continues in `waitUntil` and
 * the result arrives through PUT /api/job/:jobId/output, so the response the caller waits
 * for is only the acknowledgement. Poll `statusUrl` for the rest.
 *
 * The direct-Gemini fallback has no such problem and still answers 200 with the image.
 *
 * An optional `subject` ("the pink plush pig") names what to cut out. Worth sending whenever
 * the caller knows: which object is the subject cannot be recovered from the image, so left
 * out it is guessed, and a photo with a second plausible subject in it can be guessed wrong.
 */
app.post('/api/remove-bg', async (c) => {
  const body = (await c.req.json().catch(() => null)) as RemoveBgRequest | null;
  if (!body || !body.image) {
    throw new HttpError(400, 'bad_request', 'Body must be JSON with a string property "image".');
  }
  const result = await handleRemoveBg(c.env, body, new URL(c.req.url).origin, waitUntilOf(c));
  return result.jobId ? c.json(result, 202) : c.json(result);
});

/**
 * The agent's upload leg. Authorized by the single-use ticket in x-job-token — the agent
 * has no admin password and no browser origin, so the ticket is the whole access story.
 *
 * `x-input-sha256` is a separate question from authorization: the ticket proves the uploader
 * is entitled to answer *this* job, and the digest proves the answer was computed from this
 * job's image. They fail differently and are checked separately.
 */
app.put('/api/job/:jobId/output', async (c) => {
  if (!c.env.R2_IMAGE) {
    throw new HttpError(404, 'r2_not_configured', 'Cloudflare R2 is not configured.');
  }
  const jobId = c.req.param('jobId');
  // Verify now, spend later: a malformed upload should leave the agent able to retry.
  await verifyJobTicket(c.env, jobId, c.req.header('x-job-token') ?? '');

  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > MAX_OUTPUT_BYTES) {
    throw new HttpError(413, 'output_too_large', 'Result exceeds the maximum upload size.');
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new HttpError(400, 'empty_output', 'Uploaded body was empty.');
  }
  // content-length is the agent's claim; byteLength is the fact. Check both.
  if (bytes.byteLength > MAX_OUTPUT_BYTES) {
    throw new HttpError(413, 'output_too_large', 'Result exceeds the maximum upload size.');
  }

  const contentType = (c.req.header('content-type') ?? 'image/png').split(';')[0].trim();
  if (!contentType.startsWith('image/')) {
    throw new HttpError(415, 'not_an_image', 'Result must be uploaded with an image content-type.');
  }

  // Judge the bytes, not the header. The agent has already once declared image/png while
  // uploading a JPEG; telling it so here, at the moment of upload, is far more useful than
  // failing the job minutes later.
  assertUsableCutoutBytes(bytes, 'uploader');

  // Is this a cutout of the image we staged, or of somebody else's? The agent runs every
  // delegation in one sandbox, so a batch used to have several turns writing the same
  // scratch paths and uploading each other's pictures — a valid PNG of the wrong subject,
  // which every other check here passes. Per-job working directories fixed that; this is
  // what notices if it ever comes back.
  //
  // Only an actual disagreement is fatal. A missing header (an agent that has not been
  // told to send one) or a missing digest (an input already pruned) leaves the upload
  // alone, because refusing a good cutout over an absent guard is the worse failure.
  const claimed = (c.req.header('x-input-sha256') ?? '').trim().toLowerCase();
  if (claimed) {
    const expected = await inputDigestFor(c.env, jobId);
    if (expected && !safeEqual(claimed, expected)) {
      // Deliberately not spending the ticket: the agent can reprocess the right file and
      // upload again inside the ten minutes.
      throw new HttpError(
        409,
        'input_mismatch',
        `This result was produced from a different image (sent ${claimed.slice(0, 12)}…, ` +
          `expected ${expected.slice(0, 12)}…). Re-download this job's input to its own ` +
          `working directory, redo the removal from that file, and upload again.`,
      );
    }
  }

  await consumeJobTicket(c.env, jobId);
  await c.env.R2_IMAGE.put(outputKeyFor(jobId), bytes, {
    httpMetadata: { contentType: 'image/png' },
    customMetadata: { label: 'agent cutout', createdAt: new Date().toISOString() },
  });
  return c.json({ ok: true, bytes: bytes.byteLength });
});

/**
 * POST /api/job/:jobId/note — the agent's other leg: why there is nothing to upload.
 *
 * The turn runs in `waitUntil` after a 202, and the A2A stream it runs under dies at 126
 * seconds while the turn itself runs for minutes. Whatever the agent finally says therefore
 * reaches nobody: the browser is polling a job row, and all this side can observe is that no
 * upload arrived. Four failures in one batch were reported to the user as an expired wait,
 * with the agent's actual reasons — three rejected attempts, an unconverted patch, a model
 * call that returned no image — visible only in a sandbox nobody was looking at.
 *
 * So the failure gets the same treatment as the result: its own plain HTTPS request, on the
 * same ticket, independent of the stream and of whether `waitUntil` survived. The ticket is
 * deliberately *not* spent — a job that reports a failure and then recovers may still upload,
 * and `status` beats `note` when it does.
 */
app.post('/api/job/:jobId/note', async (c) => {
  const jobId = c.req.param('jobId');
  await verifyJobTicket(c.env, jobId, c.req.header('x-job-token') ?? '');

  // Generous next to a 2000-char note, small enough that a runaway transcript is refused
  // rather than stored. content-length is the sender's claim and curl does not always make
  // one, so the length of what actually arrived is the check that counts — the header is
  // only a cheap early out, exactly as on the upload route.
  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > MAX_NOTE_BODY_CHARS) {
    throw new HttpError(413, 'note_too_large', 'Failure note exceeds the maximum size.');
  }
  const text = (await c.req.text()).trim();
  if (!text) {
    throw new HttpError(400, 'empty_note', 'Failure note was empty.');
  }
  if (text.length > MAX_NOTE_BODY_CHARS) {
    throw new HttpError(413, 'note_too_large', 'Failure note exceeds the maximum size.');
  }

  // Truncated, not refused: a reason too long to store is still a reason, and losing it
  // would put the job straight back to being reported as an unexplained expired wait.
  await setJobNote(c.env, jobId, 'failed', text.slice(0, MAX_NOTE_CHARS));
  return c.json({ ok: true });
});

/**
 * How far a job got. No token required: the id is 128 random bits, it reveals only a
 * status word, and being able to ask "did my upload work" is what makes a silent agent
 * failure diagnosable at all. This is what the browser polls after a 202.
 *
 *   pending  — ticket issued, the agent has not downloaded the input
 *   fetched  — the agent downloaded the input but has not uploaded a result
 *   uploaded — the result arrived, and `output.key` is readable at /api/r2/:key
 *
 * `note` carries the agent's own words, which since the turn moved into waitUntil have
 * nowhere else to go. Its `kind` is what a poller should branch on: `failed` means stop
 * waiting, `progress` means a hitch worth showing but not a verdict. `status` still wins —
 * a broken stream writes a note while the upload it knows nothing about is still in
 * flight, so a job can be both noted and finished.
 */
app.get('/api/job/:jobId/status', async (c) => {
  const jobId = c.req.param('jobId');
  const [row, note] = await Promise.all([getJobStatus(c.env, jobId), getJobNote(c.env, jobId)]);
  if (!row) {
    throw new HttpError(404, 'job_not_found', 'No such job.');
  }
  const output = c.env.R2_IMAGE ? await c.env.R2_IMAGE.head(outputKeyFor(jobId)) : null;
  return c.json({
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    output: output ? { key: outputKeyFor(jobId), size: output.size } : null,
    note,
  });
});

/* ───────── settings & r2 routes ───────── */

app.get('/api/settings', async (c) => {
  const settings = await loadAppSettings(c.env);
  return c.json({ settings });
});

app.post('/api/settings', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const updated = await saveAppSettings(c.env, body);
  return c.json({ settings: updated });
});

app.get('/api/r2/list', async (c) => {
  if (!c.env.R2_IMAGE) {
    return c.json({ items: [], enabled: false, message: 'Cloudflare R2 bucket R2_IMAGE is not bound.' });
  }
  const objects = await c.env.R2_IMAGE.list({ limit: 100 });
  const items = objects.objects.map((obj) => ({
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded.toISOString(),
    httpMetadata: obj.httpMetadata,
    customMetadata: obj.customMetadata,
    url: `/api/r2/${encodeURIComponent(obj.key)}`,
  }));
  return c.json({ items, enabled: true, truncated: objects.truncated });
});

app.get('/api/r2/:key', async (c) => {
  if (!c.env.R2_IMAGE) {
    throw new HttpError(404, 'r2_not_configured', 'Cloudflare R2 is not configured.');
  }
  const key = c.req.param('key');
  const object = await c.env.R2_IMAGE.get(key);
  if (!object) {
    throw new HttpError(404, 'not_found', 'Image not found in R2 storage.');
  }
  // Serving a job input means the agent got as far as step 1. Nothing else tells us that.
  const inputJobId = jobIdFromInputKey(key);
  if (inputJobId) {
    await markInputFetched(c.env, inputJobId);
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000');
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(object.body, { headers });
});

app.delete('/api/r2/:key', async (c) => {
  if (!c.env.R2_IMAGE) {
    throw new HttpError(404, 'r2_not_configured', 'Cloudflare R2 is not configured.');
  }
  const key = c.req.param('key');
  await c.env.R2_IMAGE.delete(key);
  return c.json({ ok: true, key });
});

app.all('/api/*', () => {
  throw new HttpError(404, 'not_found', 'No such API route.');
});

// Anything else that reaches the Worker is a static asset (or the SPA fallback).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
