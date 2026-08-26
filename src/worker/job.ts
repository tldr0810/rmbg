/**
 * Job tickets: how a text-only agent hands an image back.
 *
 * The service agent's card declares `defaultOutputModes: ["text/plain"]` and a single
 * `general-chat` skill. It cannot attach a file artifact, and a full-size PNG is far too
 * large to spell out as base64 in a chat reply. So the image never travels over A2A at all:
 *
 *   worker  --> R2 (input)              public GET /api/r2/:key, the agent downloads it
 *   agent   --> Gemini 3.6              the actual background removal
 *   agent   --> PUT /api/job/:id/output the agent uploads the cutout straight to R2
 *   worker  <-- R2 (output)             read back once the agent's turn ends
 *
 * A2A carries only instructions and the agent's prose. That is exactly what a text-only
 * agent is good at, and it is why this indirection exists rather than a bigger prompt.
 *
 * The upload route is reachable without the admin password — the agent has no password —
 * so the ticket is the only thing guarding it: 256 bits of randomness, one job, one use,
 * ten minutes. Nothing here is derived from the request, so a caller cannot guess a ticket
 * by knowing when a job ran.
 *
 * Because a turn takes minutes, `POST /api/remove-bg` answers 202 with a job id and runs
 * the A2A stream in `waitUntil`. The ticket row is therefore the record of the job, and
 * `GET /api/job/:id/status` is how the browser learns it finished. The upload is what
 * settles a job, not the stream: the agent has been seen uploading long after the stream
 * dropped, so nothing here may treat a lost stream as a verdict.
 *
 * `bg_job_notes` carries the *reason* the status alone cannot: with no synchronous
 * response left to throw into, the agent's own words are the only explanation of a job
 * that will never finish. Status wins over note — a note is prose, the upload is fact.
 */

import { safeEqual } from './crypto';
import { now } from './db';
import { HttpError, type Env } from './types';

/** Long enough to outlive a slow agent turn, short enough that a leaked ticket is stale. */
const TICKET_TTL_MS = 10 * 60 * 1000;

/** An agent that uploads more than this is not returning a cutout of a web upload. */
export const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;

export interface JobTicket {
  jobId: string;
  token: string;
  inputKey: string;
  outputKey: string;
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function outputKeyFor(jobId: string): string {
  return `job_${jobId}_output.png`;
}

/**
 * The custom-metadata field on a staged input holding the SHA-256 of its bytes.
 *
 * The agent sends the same digest back, computed from the file it actually opened, and the
 * upload route refuses a result whose digest does not match. It lives on the R2 object rather
 * than in `bg_jobs` because the schema is applied with CREATE TABLE IF NOT EXISTS on every
 * cold start, so a new column could not be added idempotently — the same reason `bg_job_notes`
 * is a side table.
 */
export const INPUT_DIGEST_METADATA = 'sha256';

/** Lowercase hex SHA-256, matching what `sha256sum` prints on the agent's side. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return hex(new Uint8Array(digest));
}

/**
 * The digest recorded for this job's staged input, or null if there is nothing to compare to.
 *
 * The key's extension follows the uploaded image's type, so it is found by prefix rather than
 * reconstructed. A miss is not an error: inputs are pruned, and older jobs were staged before
 * the digest was recorded at all. Verification is a guard, not a gate — it must never turn a
 * good cutout into a failure just because the input is gone.
 */
export async function inputDigestFor(env: Env, jobId: string): Promise<string | null> {
  if (!env.R2_IMAGE) return null;
  const listed = await env.R2_IMAGE.list?.({
    prefix: `job_${jobId}_input.`,
    limit: 1,
    include: ['customMetadata'],
  }).catch(() => null);
  const object = listed?.objects?.[0];
  return object?.customMetadata?.[INPUT_DIGEST_METADATA] ?? null;
}

export async function createJobTicket(env: Env, extension: string): Promise<JobTicket> {
  const jobId = crypto.randomUUID().replace(/-/g, '');
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = new Date(Date.now() + TICKET_TTL_MS).toISOString();

  await env.DB.prepare(
    'INSERT INTO bg_jobs (job_id, token, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(jobId, token, 'pending', now(), expiresAt)
    .run();

  return {
    jobId,
    token,
    inputKey: `job_${jobId}_input.${extension}`,
    outputKey: outputKeyFor(jobId),
  };
}

/**
 * Check a ticket without spending it.
 *
 * Split from consumption so the upload can be *validated* before the ticket dies. A
 * rejected upload — wrong format, empty body, too large — should leave the agent able to
 * fix it and try again within the ten minutes, rather than killing the job on its first
 * mistake. Only a stored result spends the ticket.
 */
export async function verifyJobTicket(env: Env, jobId: string, presented: string): Promise<void> {
  const row = await env.DB.prepare(
    'SELECT token, status, expires_at AS expiresAt FROM bg_jobs WHERE job_id = ?',
  )
    .bind(jobId)
    .first<{ token: string; status: string; expiresAt: string }>();

  // Same error for "no such job" and "wrong token": a probe learns nothing either way.
  if (!row || !safeEqual(presented, row.token)) {
    throw new HttpError(403, 'job_token_invalid', 'Invalid or expired upload ticket.');
  }
  // 'fetched' is still an unredeemed ticket — it only records that the agent got as far as
  // downloading the input. Only 'uploaded' means the result already arrived.
  if (row.status !== 'pending' && row.status !== 'fetched') {
    throw new HttpError(409, 'job_already_uploaded', 'This job already received its result.');
  }
  if (Date.parse(row.expiresAt) < Date.now()) {
    throw new HttpError(403, 'job_token_invalid', 'Invalid or expired upload ticket.');
  }
}

/** Spend the ticket. Only call this once the result is known-good and about to be stored. */
export async function consumeJobTicket(env: Env, jobId: string): Promise<void> {
  await env.DB.prepare('UPDATE bg_jobs SET status = ? WHERE job_id = ?')
    .bind('uploaded', jobId)
    .run();
}

/** Verify and spend in one step. */
export async function redeemJobTicket(env: Env, jobId: string, presented: string): Promise<void> {
  await verifyJobTicket(env, jobId, presented);
  await consumeJobTicket(env, jobId);
}

/** `job_<32 hex>_input.<ext>` — the staged input for a job. Returns the job id, or null. */
export function jobIdFromInputKey(key: string): string | null {
  const match = key.match(/^job_([a-f0-9]{32})_input\.[a-z0-9]+$/i);
  return match ? match[1] : null;
}

/**
 * Record that the agent downloaded the input.
 *
 * This is the only observable the agent gives us for free — it requires no cooperation
 * from the agent, no extra prompt step, and no schema change. It answers the one question
 * that a silent failure otherwise leaves open: did the agent reach the network at all, or
 * did it fall over before step 1? Best-effort, so serving the image never fails on it.
 */
export async function markInputFetched(env: Env, jobId: string): Promise<void> {
  await env.DB.prepare("UPDATE bg_jobs SET status = ? WHERE job_id = ? AND status = 'pending'")
    .bind('fetched', jobId)
    .run()
    .catch(() => undefined);
}

/**
 * What the agent said, kept where the browser can still read it.
 *
 * `progress` means keep waiting — a lost A2A stream is the usual cause, and the agent
 * finishes the upload regardless. `failed` means stop: the turn ended, or the agent said
 * it could not do the work. The distinction is the whole point of the kind column, because
 * the two look identical from the outside — no result, yet.
 */
export type JobNoteKind = 'progress' | 'failed' | 'done';

export interface JobNote {
  kind: JobNoteKind;
  note: string;
  updatedAt: string;
}

/** An agent's failure text can be a whole transcript. Enough to diagnose, not to store. */
export const MAX_NOTE_CHARS = 2000;

/** Best-effort: a note that fails to save must never fail the job it describes. */
export async function setJobNote(
  env: Env,
  jobId: string,
  kind: JobNoteKind,
  note: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO bg_job_notes (job_id, kind, note, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (job_id) DO UPDATE SET
       kind = excluded.kind, note = excluded.note, updated_at = excluded.updated_at`,
  )
    .bind(jobId, kind, note.slice(0, MAX_NOTE_CHARS), now())
    .run()
    .catch(() => undefined);
}

/**
 * Write a note, unless the agent has already reported a failure of its own.
 *
 * The agent is the only party that knows *why* a job produced nothing — which check rejected
 * the frames, which import was missing, which call came back empty. This side finds out only
 * that no upload arrived, minutes later, and phrases it as such. Both write to the same row,
 * and the agent's note lands first, so without this guard the useful reason is routinely
 * overwritten by "did not upload the result" on its way to the browser.
 *
 * A `failed` note is therefore final: the turn is over and no later observation improves on
 * it. `done` bypasses this entirely — a result that arrives after a reported failure is still
 * a result, and status wins over note regardless.
 */
export async function setJobNoteUnlessFailed(
  env: Env,
  jobId: string,
  kind: JobNoteKind,
  note: string,
): Promise<void> {
  const existing = await getJobNote(env, jobId);
  if (existing?.kind === 'failed') return;
  await setJobNote(env, jobId, kind, note);
}

export async function getJobNote(env: Env, jobId: string): Promise<JobNote | null> {
  const row = await env.DB.prepare(
    'SELECT kind, note, updated_at AS updatedAt FROM bg_job_notes WHERE job_id = ?',
  )
    .bind(jobId)
    .first<JobNote>()
    .catch(() => null);
  return row ?? null;
}

/** What a caller may know about a job. Deliberately never includes the token. */
export async function getJobStatus(
  env: Env,
  jobId: string,
): Promise<{ status: string; createdAt: string; expiresAt: string } | null> {
  return await env.DB.prepare(
    'SELECT status, created_at AS createdAt, expires_at AS expiresAt FROM bg_jobs WHERE job_id = ?',
  )
    .bind(jobId)
    .first<{ status: string; createdAt: string; expiresAt: string }>();
}

/** Best-effort cleanup of expired tickets. Failure here must never fail a request. */
export async function pruneJobTickets(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM bg_jobs WHERE expires_at < ?')
    .bind(new Date(Date.now() - TICKET_TTL_MS).toISOString())
    .run()
    .catch(() => undefined);
  // Notes outlive nothing: a note whose job is gone can never be read again.
  await env.DB.prepare('DELETE FROM bg_job_notes WHERE job_id NOT IN (SELECT job_id FROM bg_jobs)')
    .run()
    .catch(() => undefined);
}
