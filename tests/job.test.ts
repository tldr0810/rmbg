import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import {
  INPUT_DIGEST_METADATA,
  createJobTicket,
  getJobNote,
  outputKeyFor,
  pruneJobTickets,
  redeemJobTicket,
  setJobNote,
  setJobNoteUnlessFailed,
  sha256Hex,
} from '../src/worker/job';
import type { Env } from '../src/worker/types';
import { CUTOUT_PNG_BASE64, makeJobDb as makeDb } from './fixtures';

interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
  metadata?: Record<string, string>;
}

function makeR2() {
  const store = new Map<string, StoredObject>();
  const bucket = {
    async put(
      key: string,
      bytes: Uint8Array,
      opts?: {
        httpMetadata?: { contentType?: string };
        customMetadata?: Record<string, string>;
      },
    ) {
      store.set(key, {
        bytes,
        contentType: opts?.httpMetadata?.contentType ?? 'image/png',
        metadata: opts?.customMetadata,
      });
    },
    async get(key: string) {
      const hit = store.get(key);
      if (!hit) return null;
      return {
        arrayBuffer: async () => hit.bytes.buffer,
        body: hit.bytes,
        httpEtag: 'test-etag',
        writeHttpMetadata: (headers: Headers) => headers.set('content-type', hit.contentType),
        httpMetadata: { contentType: hit.contentType },
      };
    },
    async head(key: string) {
      const hit = store.get(key);
      return hit ? { size: hit.bytes.byteLength } : null;
    },
    // The upload route finds a job's staged input by prefix, because the key's extension
    // follows whatever image type the browser sent.
    async list(opts?: { prefix?: string; limit?: number }) {
      const objects = [...store.entries()]
        .filter(([key]) => !opts?.prefix || key.startsWith(opts.prefix))
        .slice(0, opts?.limit ?? 1000)
        .map(([key, value]) => ({ key, customMetadata: value.metadata }));
      return { objects, truncated: false };
    },
  } as unknown as R2Bucket;
  return { bucket, store };
}

describe('job tickets', () => {
  let db: D1Database;
  let env: Env;

  beforeEach(() => {
    db = makeDb().db;
    env = { DB: db } as Env;
  });

  it('accepts the issued token exactly once', async () => {
    const ticket = await createJobTicket(env, 'png');
    await expect(redeemJobTicket(env, ticket.jobId, ticket.token)).resolves.toBeUndefined();
    // A replay must not overwrite a result that was already delivered.
    await expect(redeemJobTicket(env, ticket.jobId, ticket.token)).rejects.toThrow(
      'already received its result',
    );
  });

  it('rejects a wrong token', async () => {
    const ticket = await createJobTicket(env, 'png');
    await expect(redeemJobTicket(env, ticket.jobId, 'f'.repeat(64))).rejects.toThrow(
      'Invalid or expired upload ticket',
    );
  });

  it('gives an unknown job the same error as a wrong token', async () => {
    // Identical wording on purpose: probing must not reveal whether a job exists.
    await expect(redeemJobTicket(env, 'a'.repeat(32), 'b'.repeat(64))).rejects.toThrow(
      'Invalid or expired upload ticket',
    );
  });

  it('issues 256 bits of token and a key that is not derived from the clock', async () => {
    const a = await createJobTicket(env, 'png');
    const b = await createJobTicket(env, 'png');
    expect(a.token).toMatch(/^[a-f0-9]{64}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.jobId).not.toBe(b.jobId);
    expect(a.inputKey).toBe(`job_${a.jobId}_input.png`);
    expect(a.outputKey).toBe(outputKeyFor(a.jobId));
  });
});

/**
 * The other half of the agent's delivery story. The turn outlives the A2A stream it runs
 * under, so a turn that ends with nothing to upload has no channel back: the browser is
 * polling a job row, and this side can only ever observe that no upload arrived. Six images
 * were submitted, four errored, and all four were reported to the user as an expired wait —
 * the actual reasons (three rejected attempts, an unconverted patch, a generation that
 * returned no image) existed only in a sandbox nobody was watching.
 */
describe('POST /api/job/:jobId/note', () => {
  const post = (env: Env, jobId: string, body: string, token?: string) =>
    app.request(
      `/api/job/${jobId}/note`,
      {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          ...(token ? { 'x-job-token': token } : {}),
        },
        body,
      },
      env,
    );

  it('records the reason, on the ticket alone and with no Origin header', async () => {
    const { db } = makeDb();
    const env = { DB: db } as Env;
    const ticket = await createJobTicket(env, 'png');

    const res = await post(env, ticket.jobId, 'GIVING UP after 3 attempts: unconverted=127399px');

    expect(res.status).toBe(403);

    const ok = await post(
      env,
      ticket.jobId,
      'GIVING UP after 3 attempts: unconverted=127399px',
      ticket.token,
    );
    expect(ok.status).toBe(200);

    const note = await getJobNote(env, ticket.jobId);
    expect(note?.kind).toBe('failed');
    expect(note?.note).toContain('unconverted=127399px');
  });

  it('reaches the browser through the status route, which is the whole point', async () => {
    const { db } = makeDb();
    const env = { DB: db } as Env;
    const ticket = await createJobTicket(env, 'png');
    await post(env, ticket.jobId, 'STEP 2 failed: NO IMAGE for white.png', ticket.token);

    const res = await app.request(`/api/job/${ticket.jobId}/status`, {}, env);
    const body = (await res.json()) as { note: { kind: string; note: string } | null };
    expect(body.note?.kind).toBe('failed');
    expect(body.note?.note).toContain('NO IMAGE for white.png');
  });

  it('does not spend the ticket, so a job that recovers can still upload', async () => {
    // Reporting a failure is not a verdict on the job. If the agent tries once more and
    // succeeds, the upload has to be accepted — status beats note.
    const { db } = makeDb();
    const { bucket, store } = makeR2();
    const env = { DB: db, R2_IMAGE: bucket } as Env;
    const ticket = await createJobTicket(env, 'png');
    await post(env, ticket.jobId, 'GIVING UP after 3 attempts', ticket.token);

    const upload = await app.request(
      `/api/job/${ticket.jobId}/output`,
      {
        method: 'PUT',
        headers: { 'content-type': 'image/png', 'x-job-token': ticket.token },
        body: Uint8Array.from(atob(CUTOUT_PNG_BASE64), (ch) => ch.charCodeAt(0)),
      },
      env,
    );

    expect(upload.status).toBe(200);
    expect(store.has(outputKeyFor(ticket.jobId))).toBe(true);
  });

  it('refuses an empty note and an oversized one', async () => {
    const { db } = makeDb();
    const env = { DB: db } as Env;
    const ticket = await createJobTicket(env, 'png');

    expect((await post(env, ticket.jobId, '   ', ticket.token)).status).toBe(400);
    expect((await post(env, ticket.jobId, 'x'.repeat(70 * 1024), ticket.token)).status).toBe(413);
    expect(await getJobNote(env, ticket.jobId)).toBeNull();
  });

  it('stores a long reason truncated rather than refusing it', async () => {
    const { db } = makeDb();
    const env = { DB: db } as Env;
    const ticket = await createJobTicket(env, 'png');

    await post(env, ticket.jobId, `${'y'.repeat(5000)}`, ticket.token);

    const note = await getJobNote(env, ticket.jobId);
    expect(note?.note.length).toBe(2000);
  });
});

describe('setJobNoteUnlessFailed', () => {
  /**
   * Both parties write the same row and the agent's note lands first: it posts its reason at
   * the moment it gives up, while this side only concludes "no upload arrived" once the grace
   * period runs out, minutes later. Without the guard the useful reason is overwritten by the
   * generic one on its way to the browser.
   */
  it('leaves a reported failure alone', async () => {
    const { db } = makeDb();
    const env = { DB: db } as Env;
    await setJobNote(env, 'job1', 'failed', 'GIVING UP after 3 attempts: unconverted=127399px');

    await setJobNoteUnlessFailed(env, 'job1', 'failed', 'did not upload the result');
    await setJobNoteUnlessFailed(env, 'job1', 'progress', 'still waiting');

    expect((await getJobNote(env, 'job1'))?.note).toContain('unconverted=127399px');
  });

  it('writes when there is no note, or only progress so far', async () => {
    const { db } = makeDb();
    const env = { DB: db } as Env;

    await setJobNoteUnlessFailed(env, 'job2', 'progress', 'handed to the agent');
    expect((await getJobNote(env, 'job2'))?.note).toBe('handed to the agent');

    await setJobNoteUnlessFailed(env, 'job2', 'failed', 'the agent never started');
    const note = await getJobNote(env, 'job2');
    expect(note?.kind).toBe('failed');
    expect(note?.note).toBe('the agent never started');
  });

  it('still lets a result overrule a reported failure', async () => {
    // A cutout that turns up after the agent gave up is still a cutout.
    const { db } = makeDb();
    const env = { DB: db } as Env;
    await setJobNote(env, 'job3', 'failed', 'GIVING UP after 3 attempts');

    await setJobNote(env, 'job3', 'done', 'Background removal complete.');

    expect((await getJobNote(env, 'job3'))?.kind).toBe('done');
  });
});

describe('PUT /api/job/:jobId/output', () => {
  const png = Uint8Array.from(atob(CUTOUT_PNG_BASE64), (ch) => ch.charCodeAt(0));

  it('stores the upload when the ticket is valid, without an Origin header', async () => {
    const { db } = makeDb();
    const { bucket, store } = makeR2();
    const env = { DB: db, R2_IMAGE: bucket } as Env;
    const ticket = await createJobTicket(env, 'png');

    // No Origin: the uploader is curl inside an agent, not a browser.
    const res = await app.request(
      `/api/job/${ticket.jobId}/output`,
      {
        method: 'PUT',
        headers: { 'content-type': 'image/png', 'x-job-token': ticket.token },
        body: png,
      },
      env,
    );

    expect(res.status).toBe(200);
    expect(store.get(outputKeyFor(ticket.jobId))?.bytes.byteLength).toBe(png.byteLength);
  });

  it('rejects an upload with no ticket', async () => {
    const { db } = makeDb();
    const { bucket, store } = makeR2();
    const env = { DB: db, R2_IMAGE: bucket } as Env;
    const ticket = await createJobTicket(env, 'png');

    const res = await app.request(
      `/api/job/${ticket.jobId}/output`,
      { method: 'PUT', headers: { 'content-type': 'image/png' }, body: png },
      env,
    );

    expect(res.status).toBe(403);
    expect(store.size).toBe(0);
  });

  it('rejects a non-image content-type', async () => {
    const { db } = makeDb();
    const { bucket, store } = makeR2();
    const env = { DB: db, R2_IMAGE: bucket } as Env;
    const ticket = await createJobTicket(env, 'png');

    const res = await app.request(
      `/api/job/${ticket.jobId}/output`,
      {
        method: 'PUT',
        headers: { 'content-type': 'text/html', 'x-job-token': ticket.token },
        body: png,
      },
      env,
    );

    expect(res.status).toBe(415);
    expect(store.size).toBe(0);
  });

  it('rejects an empty body', async () => {
    const { db } = makeDb();
    const { bucket } = makeR2();
    const env = { DB: db, R2_IMAGE: bucket } as Env;
    const ticket = await createJobTicket(env, 'png');

    const res = await app.request(
      `/api/job/${ticket.jobId}/output`,
      {
        method: 'PUT',
        headers: { 'content-type': 'image/png', 'x-job-token': ticket.token },
        body: new Uint8Array(0),
      },
      env,
    );

    expect(res.status).toBe(400);
  });

  it('rejects a JPEG upload and leaves the ticket usable for a retry', async () => {
    // The agent's first real result was a JPEG sent as content-type image/png. Reject it
    // at the door — and do not spend the ticket, so the same job can still succeed.
    const { db } = makeDb();
    const { bucket, store } = makeR2();
    const env = { DB: db, R2_IMAGE: bucket } as Env;
    const ticket = await createJobTicket(env, 'png');

    const jpeg = new Uint8Array(2048);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0], 0);

    const bad = await app.request(
      `/api/job/${ticket.jobId}/output`,
      {
        method: 'PUT',
        headers: { 'content-type': 'image/png', 'x-job-token': ticket.token },
        body: jpeg,
      },
      env,
    );
    expect(bad.status).toBe(502);
    expect(store.size).toBe(0);

    const retry = await app.request(
      `/api/job/${ticket.jobId}/output`,
      {
        method: 'PUT',
        headers: { 'content-type': 'image/png', 'x-job-token': ticket.token },
        body: png,
      },
      env,
    );
    expect(retry.status).toBe(200);
    expect(store.has(outputKeyFor(ticket.jobId))).toBe(true);
  });

  describe('the provenance check', () => {
    // Several removals share one sandbox, and one turn overwriting another's /tmp/input.png
    // delivered a genuine cutout of somebody else's photo under the right job token. Nothing
    // about those bytes looks wrong, so the only way to catch it is to make the agent say
    // which file it read: x-input-sha256, checked against the input this job staged.
    async function stageJob() {
      const { db } = makeDb();
      const { bucket, store } = makeR2();
      const env = { DB: db, R2_IMAGE: bucket } as Env;
      const ticket = await createJobTicket(env, 'png');
      await bucket.put(ticket.inputKey, png, {
        httpMetadata: { contentType: 'image/png' },
        customMetadata: { [INPUT_DIGEST_METADATA]: await sha256Hex(png) },
      });
      return { env, store, ticket };
    }

    function upload(env: Env, jobId: string, token: string, digest?: string) {
      return app.request(
        `/api/job/${jobId}/output`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'image/png',
            'x-job-token': token,
            ...(digest ? { 'x-input-sha256': digest } : {}),
          },
          body: png,
        },
        env,
      );
    }

    it('rejects a cutout made from a different image, and leaves the ticket usable', async () => {
      const { env, store, ticket } = await stageJob();

      const wrong = await upload(env, ticket.jobId, ticket.token, 'a'.repeat(64));
      expect(wrong.status).toBe(409);
      const body = (await wrong.json()) as { error: { code: string } };
      expect(body.error.code).toBe('input_mismatch');
      expect(store.has(outputKeyFor(ticket.jobId))).toBe(false);

      // A mismatch is the agent's mistake to fix, not the end of the job: it can redo the
      // removal from this job's own input and PUT again with the same token.
      const retry = await upload(env, ticket.jobId, ticket.token, await sha256Hex(png));
      expect(retry.status).toBe(200);
      expect(store.has(outputKeyFor(ticket.jobId))).toBe(true);
    });

    it('accepts a cutout whose digest matches the staged input', async () => {
      const { env, store, ticket } = await stageJob();
      const res = await upload(env, ticket.jobId, ticket.token, await sha256Hex(png));
      expect(res.status).toBe(200);
      expect(store.has(outputKeyFor(ticket.jobId))).toBe(true);
    });

    it('accepts an upload that sends no digest at all', async () => {
      // The header is a safety net, not a requirement. An older agent, or one whose shell
      // lacks sha256sum, still delivers — never fail a good cutout over a missing guard.
      const { env, store, ticket } = await stageJob();
      const res = await upload(env, ticket.jobId, ticket.token);
      expect(res.status).toBe(200);
      expect(store.has(outputKeyFor(ticket.jobId))).toBe(true);
    });

    it('accepts a digest when the job has no staged input to compare against', async () => {
      // Jobs created before the digest existed have no metadata on their input. There is
      // nothing to check, so there is nothing to reject.
      const { db } = makeDb();
      const { bucket, store } = makeR2();
      const env = { DB: db, R2_IMAGE: bucket } as Env;
      const ticket = await createJobTicket(env, 'png');
      await bucket.put(ticket.inputKey, png, { httpMetadata: { contentType: 'image/png' } });

      const res = await upload(env, ticket.jobId, ticket.token, 'a'.repeat(64));
      expect(res.status).toBe(200);
      expect(store.has(outputKeyFor(ticket.jobId))).toBe(true);
    });
  });

  it('records that the agent downloaded the input, and still accepts the upload after', async () => {
    // Serving the input is the only free signal that the agent reached step 1. It must not
    // burn the ticket: fetching is progress, not delivery.
    const { db } = makeDb();
    const { bucket, store } = makeR2();
    const env = { DB: db, R2_IMAGE: bucket } as Env;
    const ticket = await createJobTicket(env, 'png');
    await bucket.put(ticket.inputKey, png, { httpMetadata: { contentType: 'image/png' } });

    const before = await app.request(`/api/job/${ticket.jobId}/status`, {}, env);
    expect(((await before.json()) as { status: string }).status).toBe('pending');

    const fetched = await app.request(`/api/r2/${ticket.inputKey}`, {}, env);
    expect(fetched.status).toBe(200);

    const after = await app.request(`/api/job/${ticket.jobId}/status`, {}, env);
    expect(((await after.json()) as { status: string }).status).toBe('fetched');

    const upload = await app.request(
      `/api/job/${ticket.jobId}/output`,
      {
        method: 'PUT',
        headers: { 'content-type': 'image/png', 'x-job-token': ticket.token },
        body: png,
      },
      env,
    );
    expect(upload.status).toBe(200);

    const done = await app.request(`/api/job/${ticket.jobId}/status`, {}, env);
    const body = (await done.json()) as { status: string; output: { size: number } | null };
    expect(body.status).toBe('uploaded');
    expect(body.output?.size).toBe(png.byteLength);
    expect(store.has(outputKeyFor(ticket.jobId))).toBe(true);
  });

  it('does not let a late input download reopen a delivered job', async () => {
    // The agent may re-download after uploading. If that reset the row to 'fetched' the
    // ticket would come back to life and a second upload could overwrite the result.
    const { db } = makeDb();
    const { bucket } = makeR2();
    const env = { DB: db, R2_IMAGE: bucket } as Env;
    const ticket = await createJobTicket(env, 'png');
    await bucket.put(ticket.inputKey, png, { httpMetadata: { contentType: 'image/png' } });

    await redeemJobTicket(env, ticket.jobId, ticket.token);
    await app.request(`/api/r2/${ticket.inputKey}`, {}, env);

    const status = await app.request(`/api/job/${ticket.jobId}/status`, {}, env);
    expect(((await status.json()) as { status: string }).status).toBe('uploaded');
    await expect(redeemJobTicket(env, ticket.jobId, ticket.token)).rejects.toThrow(
      'already received its result',
    );
  });

  it('reports the agent note alongside the status', async () => {
    // The A2A turn now runs in waitUntil, so this note is the only channel by which a
    // reason reaches the browser at all.
    const { db } = makeDb();
    const { bucket } = makeR2();
    const env = { DB: db, R2_IMAGE: bucket } as Env;
    const ticket = await createJobTicket(env, 'png');

    await setJobNote(env, ticket.jobId, 'failed', 'python3: No module named PIL');

    const res = await app.request(`/api/job/${ticket.jobId}/status`, {}, env);
    const body = (await res.json()) as { note: { kind: string; note: string } | null };
    expect(body.note?.kind).toBe('failed');
    expect(body.note?.note).toBe('python3: No module named PIL');
  });

  it('has no note until something writes one', async () => {
    const { db } = makeDb();
    const env = { DB: db, R2_IMAGE: makeR2().bucket } as Env;
    const ticket = await createJobTicket(env, 'png');

    const res = await app.request(`/api/job/${ticket.jobId}/status`, {}, env);
    expect(((await res.json()) as { note: unknown }).note).toBeNull();
  });

  it('keeps one note per job, latest wins', async () => {
    // A job is noted as it moves: a broken stream first, then whatever ended it. Only the
    // last one is worth showing, and an unbounded log of them would outlive the ticket.
    const { db, notes } = makeDb();
    const env = { DB: db } as Env;
    const ticket = await createJobTicket(env, 'png');

    await setJobNote(env, ticket.jobId, 'progress', '連線中斷,繼續等待');
    await setJobNote(env, ticket.jobId, 'failed', 'Agent 沒有上傳結果');

    expect(notes.size).toBe(1);
    expect(await getJobNote(env, ticket.jobId)).toMatchObject({
      kind: 'failed',
      note: 'Agent 沒有上傳結果',
    });
  });

  it('drops notes whose job has been pruned', async () => {
    const { db, rows, notes } = makeDb();
    const env = { DB: db } as Env;
    const ticket = await createJobTicket(env, 'png');
    await setJobNote(env, ticket.jobId, 'failed', 'long gone');

    rows.delete(ticket.jobId);
    await pruneJobTickets(env);

    expect(notes.size).toBe(0);
  });

  it('404s the status of a job that does not exist', async () => {
    const { db } = makeDb();
    const res = await app.request(`/api/job/${'a'.repeat(32)}/status`, {}, { DB: db } as Env);
    expect(res.status).toBe(404);
  });

  it('still demands an Origin on other mutations', async () => {
    // The exemption must be scoped to this one route, not to PUT in general.
    const { db } = makeDb();
    const env = { DB: db } as Env;
    const res = await app.request(
      '/api/settings',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      env,
    );
    expect(res.status).toBe(403);
  });
});
