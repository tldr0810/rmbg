import { GoogleGenAI } from '@google/genai';
import { HttpError, type AgentCredential, type Env } from './types';
import { listConnectedAgents, credentialFor } from './connect';
import { consumeA2AStream, fetchImageAsDataUrl, type StreamSnapshot } from './a2a';
import { loadAppSettings } from './settings-manager';
import { base64ToBytes, putImageAtKey, saveImageToR2 } from './r2';
import {
  INPUT_DIGEST_METADATA,
  createJobTicket,
  pruneJobTickets,
  setJobNote,
  setJobNoteUnlessFailed,
  sha256Hex,
  type JobTicket,
} from './job';

export interface RemoveBgRequest {
  /** Base64 string or data URL */
  image: string;
  /** Optional agentId if multiple Manyfold agents are connected */
  agentId?: string;
  /**
   * What to cut out, as a short noun phrase ("the pink plush pig").
   *
   * Optional, and the only thing in this request that settles the question for certain.
   * Which object is "the subject" is not a property of the pixels — a toy held up in front
   * of a gallery wall and the mural behind it are both honest readings — so when the caller
   * knows, saying so beats any amount of guessing. Left out, the pipeline names the subject
   * itself; see `agentInstructions`.
   */
  subject?: string;
}

export interface RemoveBgResponse {
  label: string;
  image?: string;
  mimeType?: string;
  svgPath?: string;
  boundingBox?: [number, number, number, number];
  r2Key?: string;
  r2Url?: string;
  /**
   * Set only on the asynchronous agent path. Its presence is the signal to the browser
   * that there is no image in this response and it should poll `statusUrl` instead.
   */
  jobId?: string;
  statusUrl?: string;
}

const REMOVE_BG_TIMEOUT_MS = 180_000;

/**
 * How long to keep watching R2 after the A2A stream *breaks*.
 *
 * The stream is a progress channel; the upload is the delivery channel. A lost stream —
 * seen in production as "Network connection lost" after ~2 minutes — tells us nothing
 * about the upload, so keep looking before calling the job failed. Only a turn that
 * actually reached a terminal state needs no grace: the agent is instructed to reply
 * after its upload returns 200, so a *finished* turn with an empty key never uploaded.
 */
const UPLOAD_GRACE_BROKEN_MS = 60_000;
const UPLOAD_POLL_MS = 2_000;

/**
 * The same grace, once nobody is waiting on the response.
 *
 * A real turn takes about five minutes; the stream dies at 126 seconds. Off the request's
 * critical path there is no reason to give up before the ticket does, so watch almost to
 * its ten-minute expiry. This is best-effort by nature — `waitUntil` work can be evicted —
 * and nothing depends on it: the upload route is what records the result. All this buys is
 * a written reason when the result never comes.
 */
const ASYNC_UPLOAD_GRACE_MS = 6 * 60_000;
const ASYNC_UPLOAD_POLL_MS = 5_000;

/**
 * An agent accepts a limited number of concurrent A2A delegations — measured at 8. Past that
 * the platform rejects the *dispatch* in well under a second:
 *
 *   RPC error -32603: too many concurrent A2A delegations (8/8); retry when one finishes
 *
 * That is categorically different from the stream drops this file otherwise defends against.
 * A dropped stream means the turn is running and we stopped hearing about it, so waiting is
 * right. A rejected dispatch means the turn *never started*: no upload is coming, and waiting
 * for one burns the ticket's whole ten-minute TTL showing a spinner. It is also the most
 * retryable error here — a slot frees as soon as any sibling turn ends.
 *
 * Batch submissions hit this on every run by construction, so the job waits for a slot and
 * only fails once waiting is hopeless.
 */
const DISPATCH_RETRY_BASE_MS = 2_000;
const DISPATCH_RETRY_MAX_MS = 30_000;
const DISPATCH_RETRY_WINDOW_MS = 5 * 60_000;

/** True for a dispatch rejection, which is retryable, not for a stream that died mid-turn. */
export function isDispatchRejection(message: string): boolean {
  return /too many concurrent\b.*\bdelegations/i.test(message);
}

/** Exponential backoff with jitter, so sibling jobs do not all retry on the same tick. */
export function dispatchRetryDelay(attempt: number, random = Math.random): number {
  const capped = Math.min(DISPATCH_RETRY_BASE_MS * 2 ** attempt, DISPATCH_RETRY_MAX_MS);
  return Math.round(capped / 2 + random() * (capped / 2));
}

/** Poll R2 for the agent's upload until it lands or the grace period runs out. */
async function waitForUpload(
  bucket: R2Bucket,
  key: string,
  graceMs: number,
  pollMs = UPLOAD_POLL_MS,
): Promise<R2ObjectBody | null> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    const hit = await bucket.get(key);
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Anything smaller than this is a placeholder, not a cutout. */
const MIN_CUTOUT_BYTES = 512;
const MIN_CUTOUT_EDGE = 16;

function extensionFor(mimeType: string): string {
  const subtype = mimeType.split('/')[1] ?? 'png';
  return subtype === 'jpeg' ? 'jpg' : subtype.replace(/[^a-z0-9]/gi, '') || 'png';
}

/** Chunked because String.fromCharCode(...bytes) blows the stack on a real image. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * The scratch directory this job owns on the agent's filesystem.
 *
 * Every path in the instructions is absolute and job-specific, because the agent runs *all*
 * of its delegations in one sandbox. Verified 2026-08-25 by probing it directly: a single
 * hostname, a single `/tmp`, and after a batch of a dozen images exactly one `/tmp/input.png`,
 * one `/tmp/gen.png` and one `/tmp/output.png` left behind. The client submits six at a time,
 * so six turns were writing those same three paths.
 *
 * The failure that produced was not a crash. A turn would download its own input, have it
 * overwritten by a sibling mid-turn, then key, cut out and upload the *sibling's* picture
 * under its own job token: right destination, wrong image. Nothing downstream can catch it —
 * the bytes are a perfectly valid cutout, just of something else — which is why the fix has
 * to be that two turns never name the same file.
 *
 * A shell variable would not do. Each command here is run as its own tool call with a fresh
 * shell, so anything exported in one is gone by the next. The path has to be a literal, and
 * this is where it is baked in.
 */
export function workDirFor(jobId: string): string {
  return `/tmp/rmbg-${jobId}`;
}

/** How much of a caller-supplied subject phrase survives into the prompt. */
const MAX_SUBJECT_CHARS = 120;

/**
 * Clean a caller-supplied subject phrase, or null if there is nothing usable in it.
 *
 * The result is interpolated into a Python string literal inside a `<<'EOF'` heredoc, so the
 * two things that must not survive are control characters and line breaks: a newline would
 * end the Python statement the phrase sits in and leave the rest of the words loose in the
 * script. Collapsing all whitespace to single spaces also makes it impossible for the phrase
 * to put `EOF` alone on a line and close the heredoc early. Quotes and backslashes need no
 * handling here — the value is emitted with `JSON.stringify`, whose escaping Python reads the
 * same way for every character that gets this far.
 *
 * The cap is not a safety measure, it is a prompt-quality one: this is meant to be a noun
 * phrase, and a caller who pastes an essay gets the first clause of it rather than a prompt
 * that buries the instruction it is embedded in.
 *
 * An unpaired surrogate is dropped last, after the cap, because both the caller and the cap can
 * produce one: JSON permits a lone `\ud800` escape, and slicing at a fixed number of UTF-16 units
 * splits an emoji that straddles the limit. Neither JSON.stringify nor Python objects to one — it
 * survives all the way to the generation call, where encoding the prompt as UTF-8 raises and kills
 * STEP 2 outright, since a caller-supplied subject skips the naming call's try/except. Under /u,
 * `\p{Surrogate}` matches only the unpaired ones: a well-formed pair is a single code point
 * outside the category, so emoji come through intact.
 */
export function sanitizeSubject(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  const capped = cleaned.slice(0, MAX_SUBJECT_CHARS).replace(/\p{Surrogate}/gu, '').trim();
  return capped || null;
}

/**
 * The instruction the agent receives. The image also rides along as an A2A FilePart so the
 * agent can *see* it, but seeing it is not enough: it reported it cannot materialise those
 * bytes onto its filesystem, and its card only allows text back. So the real work is done
 * against URLs, and the prompt spells out the commands rather than describing them.
 *
 * STEP 2 asks for a flat colour background rather than transparency on purpose. Asked for
 * transparency directly, the model painted a grey-and-white checkerboard — the *picture* of
 * transparency — as opaque RGB pixels, because an image generator has no alpha channel to
 * write to. A uniform colour is something it can actually produce, and turning one colour
 * into alpha is arithmetic the agent can do exactly.
 *
 * It asks for that flat colour *twice*, white and then black, because one frame is not enough
 * to recover alpha — it can only be guessed at. Every version of this pipeline up to
 * 2026-08-25 keyed a single frame: alpha from a colour distance to the background, then
 * `(rgb - key*(1-a))/a` to un-mix the spill. Measured against the original on a real
 * production result, that estimate cost the following:
 *
 *              original    single-frame key    two frames
 *   edge ramp     1 px           12-14 px          2 px
 *   partial α    0.04%        7.33-10.02%         0.06%
 *   silhouette      —          IoU 0.9350        IoU 0.9698
 *                             4522 too fat        0 too fat
 *                             1391 eaten       2610 eaten
 *
 * (Both columns measured on the same 2048x2048 image on 2026-08-25, the middle one straight
 * off the deployed Worker. What remains is a ~1 px tight boundary: the model renders the
 * subject about 1700 px short of the original's own silhouette in *both* frames, with
 * centroids agreeing to 0.3 px and bounding boxes to 2 px — so it is the model drawing a
 * slightly tighter edge, not the two frames drifting apart.)
 *
 * and it left an enclosed hole in the middle of the subject fully opaque. None of that was a
 * tuning failure. A distance-to-key threshold flattens the ramp, the un-mix over-subtracts
 * near the edge (the halo) and divides residue by an alpha of ~0.04 out in the background
 * (the confetti of stray coloured pixels). Every artefact was a by-product of estimating.
 *
 * Two frames make it arithmetic instead. With the same subject composited over white and over
 * black, `obs_white - obs_black = (1 - α)·255` for any subject colour whatsoever, so
 * `α = 1 - mean(obs_white - obs_black)/255` and `F = obs_black / α`. That is an identity, not
 * an estimate: no key colour means no spill and no colour fringe, a continuous α means hair,
 * fur, glass and soft edges survive as the fractional values they really are, and no threshold
 * means there is no residue to clean up afterwards. It also handles what chroma-key
 * structurally cannot — a white shirt shot against a white wall — because the subject is never
 * identified by its colour at all.
 *
 * The second call must *edit* the white frame rather than regenerate from the input: the
 * identity holds only where the subject pixels are the same in both frames. Two independent
 * generations drift, and the drift lands in α.
 *
 * The white instruction spells out that an area *enclosed* by the subject is still background.
 * Without that sentence the model reads an enclosed gap as part of the object and paints
 * around it, so both frames agree there and α comes out 1 — which is exactly how the hole in
 * the middle of the bench image survived as 4387 fully opaque pixels, and the whole of the
 * "4505 px too fat" above. Adding it took that region to α=0 across all 4387 pixels and the
 * too-fat count to zero. It is a statement about what background *means*, not a hint about
 * any particular picture.
 *
 * That sentence asks the model for a contract it has no way to guarantee, which is why STEP 3
 * also verifies it. The model is a generator, not an editor: nothing in the API binds the pixels
 * it returns to the pixels it was given. Two of five production images failed on 2026-08-25 in
 * the two ways that follow from that. One came back re-framed — the same subject, zoomed 2.32x
 * and re-centred on the canvas — so the mask was a correct cutout of a picture nobody asked for;
 * laid over the original it opened a subject-shaped window onto the backdrop, 251,428 of 300,033
 * opaque pixels being background. The other left an enclosed gap opaque. Neither was caught,
 * because every check in this pipeline compared the two frames with each other, and since
 * black.png is an edit of white.png they agree by construction — the re-framed pair scored
 * `transparent=92.59% partial=0.26% opaque=7.15%`, which reads as a healthy result. The input
 * was consulted for nothing but its dimensions and its colour values.
 *
 * So the verification is now referred to the input, which is the only artefact in the job that
 * is not model output. Inside the region about to be called opaque, white.png must still show
 * what input.png shows: compared tile by tile (32 px, so a small hole spans several) on mean
 * difference, on correlation where both sides have texture, and on flat-versus-busy. Wholesale
 * disagreement means the frame is of another picture and the attempt is thrown away; a local
 * clump is what a painted-over gap looks like and is reported with its coordinates. Separately,
 * anything pure white in *both* frames where the input is not white is background the second
 * call never converted — the arithmetic makes it alpha 1, and it is the second failure above
 * caught directly. None of this asks what the picture is of, so it holds for a photograph as
 * much as for a drawing on flat paper. Measured against synthesised frame pairs: a faithful
 * redraw with a 1 px shift scores 100% agreement, a 2% zoom 91%, a 5% zoom 75%, the observed
 * 2.33x re-frame 9%.
 *
 * A rejected attempt is not the end of the job. STEP 3 writes retry.json — a sentence naming
 * what went wrong, addressed to whichever of the two calls caused it — and STEP 2 appends it to
 * the prompt on the next run, up to three attempts, keeping each rejected pair as
 * rejected-N-*.png. A frame-wide failure is never delivered; a local one is delivered after
 * three tries with the warning carried into the reply, because a suspicious patch is not worth
 * refusing an otherwise good cutout over.
 *
 * Both calls set `imageConfig.imageSize = '2K'` (capital K; lowercase is rejected). Left
 * unset, the API defaults to 1K and the mask arrives at 1024x1024 to be LANCZOS-stretched to
 * a 2048x2048 input — half the measured edge width was that stretch. Verified on the live
 * agent 2026-08-25: a 1024x1024 input came back 2048x2048 at 1958 candidate tokens against
 * ~1290 for a 1K frame, so the model honours it rather than upscaling a 1K render.
 *
 * Finally, STEP 3 takes the *interior* of the cutout from the original photo and only the
 * partially-transparent edge from the solved frame. It used to take every pixel from the
 * generated frame, with the original consulted for nothing but its dimensions, and every
 * pixel of it was the model's redrawing of the subject rather than the subject. The edge
 * still comes from the solved frame because an anti-aliased boundary is a blend of subject
 * and background that the original cannot supply.
 *
 * Everything above is about solving alpha correctly. STEP 2 also has to settle a question that
 * comes before it: alpha for *which object*. Until 2026-08-25 both prompts said "the subject"
 * and never said which thing that was — a circular definition the model resolved on its own,
 * by salience, once per call. A production job that day photographed a small plush toy held up
 * in front of a gallery wall; the model read the Monet mural filling that wall as the subject,
 * whited out the wall around it and delivered a 47%-opaque painting. Every check here passed
 * it, and correctly: the frames agreed, nothing was re-framed, the opaque pixels matched the
 * input exactly. The alpha was right. The object was wrong, and no amount of checking alpha
 * can see that, because both readings of that photograph are defensible.
 *
 * So the subject is chosen once, up front, and named. Two things follow. The frames stop
 * resolving the referent independently and agree by construction rather than by luck; and the
 * name is printed and carried into the CHECK line, so a wrong pick shows up in the reply
 * instead of shipping in silence. Both hold for any photograph — a single-object shot names
 * that object and the wording is no worse than the bare article it replaces.
 *
 * What it does not do is guarantee the pick is right, and it cannot: which object someone
 * wanted is not in the pixels. Name it "the Monet mural" and this pipeline will cut out the
 * mural, consistently and well. That is what `RemoveBgRequest.subject` is for — a caller who
 * knows says so and no guess is made at all. The naming call is the default for callers who
 * do not, and it defaults in turn to the old wording if it fails, so the floor is where the
 * pipeline already stood.
 *
 * The naming prompt is deliberately about depth and attention rather than area — held, in
 * focus, nearest the camera, over whatever covers the most pixels — because area is the
 * heuristic that lost the toy to the mural. It says a picture or screen behind the subject is
 * backdrop for the same reason. That is a default, not a truth: photograph a painting to sell
 * it and the painting *is* the subject, which is again what the caller-supplied phrase is for.
 */
function agentInstructions(
  workDir: string,
  inputUrl: string,
  uploadUrl: string,
  /** Where a turn with nothing to upload posts its reason. Same ticket as the upload. */
  noteUrl: string,
  token: string,
  model: string,
  /** Text model for the naming call. Unused when `subject` is supplied. */
  textModel: string,
  /** Caller-supplied subject phrase, already sanitized. Null means "work it out". */
  subject: string | null,
): string {
  // Emitted as a Python literal: a JSON string when the caller named the subject, `None` when
  // they did not. `sanitizeSubject` has already removed everything JSON and Python disagree on.
  const subjectLiteral = subject === null ? 'None' : JSON.stringify(subject);
  return `Remove the background from an image. Do the work with shell commands — do not answer from the attached preview alone.

Every path below is inside ${workDir}, which belongs to this job alone. Other background
removals are running in the same sandbox at the same time, writing files of their own. Use
these exact paths and do not shorten them to a bare name directly under /tmp: a shared name
makes two jobs overwrite each other's images, and each one then uploads the other's picture.

STEP 0 — create this job's working directory:
  mkdir -p ${workDir}
  find /tmp -maxdepth 1 -type d -name 'rmbg-*' -mmin +60 -exec rm -rf {} + 2>/dev/null || true

STEP 1 — download the image:
  curl -sS -o ${workDir}/input.png '${inputUrl}'

If you hold a background-removal skill that has you pick a key colour and chroma-key it out of
one generated frame, ignore it for this job: the steps below replace that procedure outright.
There is no key colour here, nothing to choose, and nothing to type in by hand.

STEP 2 — render this subject twice, once over white and once over black. Run this verbatim:

  python3 - <<'EOF'
from google import genai
from google.genai import types
from PIL import Image
import json, os, sys
D = '${workDir}'
client = genai.Client()
# STEP 3 writes retry.json when it rejects an attempt: a sentence naming what went wrong, aimed
# at whichever of the two calls caused it. Absent on the first run, which is the normal case.
try:
    extra = json.load(open(D + '/retry.json'))
except Exception:
    extra = {}
# ...and plan.json naming which frames it wants drawn again. A fault the checks pin on the black
# call alone leaves white.png standing: it has already been measured against input.png and
# passed, so redrawing it spends a 2K generation on a fresh chance to go wrong.
try:
    plan = set(json.load(open(D + '/plan.json')))
except Exception:
    plan = {'white', 'black'}

def gen(src, out, instruction):
    data = open(src, 'rb').read()
    mime = 'image/' + (Image.open(src).format or 'PNG').lower()
    r = client.models.generate_content(
        model='${model}',
        contents=[types.Part.from_bytes(data=data, mime_type=mime), instruction],
        config=types.GenerateContentConfig(
            image_config=types.ImageConfig(image_size='2K'),
        ),
    )
    blob = None
    for p in r.candidates[0].content.parts:
        inline = getattr(p, 'inline_data', None)
        if inline and inline.data:
            blob = inline.data
            break
    if blob is None:
        sys.exit('NO IMAGE for ' + out + ' :: ' + str(r.candidates[0].finish_reason))
    open(out, 'wb').write(blob)
    print('%s %s tokens=%s' % (out.rsplit('/', 1)[-1], Image.open(out).size,
                               r.usage_metadata.candidates_token_count))

# Which object is the subject is settled here, once, before either frame is drawn. Saying
# "the subject" and leaving it at that is circular, and each call resolves it on its own: a
# plush toy held up in front of a gallery wall lost to the Monet mural behind it, which was
# whited out around and delivered as a 47%-opaque painting. The alpha was solved correctly
# for the wrong object, so no check downstream could see it.
#
# SUBJECT_HINT is what the caller asked for. Only the caller can actually know, so it wins
# outright and no naming call is made. Otherwise ask once, cache it, and fall back to the old
# generic wording if the call fails - a job whose naming step is unavailable is then exactly
# as good as it was before, never worse.
SUBJECT_HINT = ${subjectLiteral}
S = SUBJECT_HINT
if S is None:
    try:
        S = json.load(open(D + '/subject.json'))['subject']
    except Exception:
        S = None
if S is None:
    try:
        data = open(D + '/input.png', 'rb').read()
        mime = 'image/' + (Image.open(D + '/input.png').format or 'PNG').lower()
        r = client.models.generate_content(
            model='${textModel}',
            contents=[types.Part.from_bytes(data=data, mime_type=mime),
                      'Name the subject of this photograph: the thing the photographer is '
                      'presenting. Prefer what is held, in focus, nearest the camera or placed '
                      'at the centre of attention over whatever merely covers the most pixels. '
                      'A picture, poster, screen, mural or window behind it is backdrop however '
                      'large it looms. If several things are equally the point, name them '
                      'together. Answer with a short noun phrase starting with "the", naming '
                      'what it is - no sentence, no explanation.'],
        )
        S = ' '.join((r.text or '').split())[:120].strip('. ') or None
    except Exception as e:
        print('SUBJECT could not be named (%s), using the generic wording' % e)
        S = None
if S is None:
    S = 'the subject'
json.dump({'subject': S}, open(D + '/subject.json', 'w'))
print('subject=%s' % S)

WHITE = (f"Replace the entire background with solid pure white, RGB exactly 255,255,255. "
         f"The subject of this photograph is {S}. "
         f"The background is everything that is not {S}, and that includes any area "
         f"fully enclosed by {S}: a hole through it, a gap between its parts, the "
         f"space inside a handle, a loop or a ring. If the backdrop is visible through it, it "
         f"is background and it must come out white too. Anything else in the picture is "
         f"background however much of the frame it fills, including a picture, poster, screen "
         f"or mural behind it. "
         f"One flat colour: no gradient, no shadow, no reflection, no vignette, no texture. "
         f"Keep {S} pixel-for-pixel identical: same position, same size, same framing, "
         f"same colours, same lighting, same edge detail. Change only the background.")
BLACK = (f"Keep this image exactly as it is and change only the background colour: every pixel "
         f"that is currently pure white background becomes solid pure black, RGB exactly 0,0,0. "
         f"Do not move, resize, recolour, relight or redraw {S} - every pixel of it "
         f"must stay exactly where it is and keep its exact colour. Only the background changes.")

if extra:
    print('RETRY hints in effect: ' + ', '.join(sorted(extra)))
if 'white' in plan or not os.path.exists(D + '/white.png'):
    gen(D + '/input.png', D + '/white.png', WHITE + extra.get('white', ''))
else:
    print('white.png kept from the previous attempt - it matched the input, only the black '
          'frame was at fault')
gen(D + '/white.png', D + '/black.png', BLACK + extra.get('black', ''))
EOF

Four things about that script are load-bearing, so run it as written rather than calling the
model your own way:

  - The second call edits ${workDir}/white.png. It does NOT start again from input.png. STEP 3
    subtracts one frame from the other, and that subtraction only means anything if the subject
    is in the same place with the same colours in both. Two independent generations drift, and
    the drift lands in the alpha channel as a ruined edge.
  - imageConfig.imageSize is '2K', capital K. Lowercase is rejected. Left unset the API gives
    you 1K, and a 1024-wide mask stretched over a 2048-wide photo is a blurred edge you cannot
    get back.
  - Do NOT ask for transparency, and do NOT accept a grey-and-white checkerboard. A
    checkerboard is a drawing of transparency, not transparency, and it will be rejected.

  - The subject is named before either frame is drawn, and both prompts then refer to that
    name instead of saying "the subject". Do not put the generic wording back. Two calls each
    deciding for themselves what the subject is will happily disagree, and when they disagree
    the arithmetic in STEP 3 still returns a confident answer — for whichever object the second
    call settled on.

It prints \`subject=...\` and then one line per frame it drew, e.g. \`white.png (2048, 2048)
tokens=1958\`. Include every line it prints in your final reply. The subject line is the only
place the choice of what to cut out is visible, so it matters even when the frames look healthy.
On a retry it may say it kept white.png instead of drawing it: that is STEP 3 telling it the
white frame was fine and only the black call went wrong, and it is correct — do not draw the
white frame again by hand.

STEP 3 — solve for the alpha channel, at the original size:

  python3 - <<'EOF'
from PIL import Image
import numpy as np, json, os, shutil, sys
D = '${workDir}'
MAX_ATTEMPTS = 3
src = Image.open(D + '/input.png').convert('RGB')
# What STEP 2 decided it was cutting out. Reported below rather than checked: no measurement
# here can tell a correct choice from a wrong one, so the job of this line is to put the choice
# in front of a person.
try:
    S = json.load(open(D + '/subject.json'))['subject']
except Exception:
    S = 'the subject'

def frame(name):
    im = Image.open(D + '/' + name).convert('RGB')
    if abs(im.size[0] / im.size[1] - src.size[0] / src.size[1]) > 0.01:
        print('WARNING %s is %s but the input is %s, so the model changed the shape of the '
              'frame and the mask has to be stretched to fit.' % (name, im.size, src.size))
    if im.size != src.size:
        im = im.resize(src.size, Image.LANCZOS)
    return np.array(im).astype(np.float32)

# input.png is the only thing in this job that is not model output, so it is the reference the
# tile test below measures against. Set up once: every attempt is judged on the same grid.
srcf = np.array(src, dtype=np.float32)
T = 32
h, w = (srcf.shape[0] // T) * T, (srcf.shape[1] // T) * T

def tiles(a):
    return a[:h, :w].reshape(h // T, T, w // T, T).swapaxes(1, 2).reshape(h // T, w // T, T * T)

def measure(white, black):
    # The same subject over two known backgrounds is two equations in one unknown:
    #   obs_white = alpha * F + (1 - alpha) * 255
    #   obs_black = alpha * F + (1 - alpha) * 0
    # Subtracting cancels the subject entirely, whatever colour it is:
    #   obs_white - obs_black = (1 - alpha) * 255
    d = np.clip((white - black).mean(axis=2), 0.0, 255.0)
    alpha = 1.0 - d / 255.0
    # Two model calls never return byte-identical subject pixels, so d wobbles a few counts
    # either side of zero across solid parts of the subject. Snap only those last few counts at
    # each end; every fractional alpha in between is the identity above, left exactly as solved.
    alpha[d <= 8.0] = 1.0
    alpha[d >= 247.0] = 0.0
    a8 = np.round(alpha * 255).astype(np.uint8)
    opaque = a8 == 255
    opaque_px = max(int(opaque.sum()), 1)

    # Everything so far compares the two frames with each other, and black.png is an edit OF
    # white.png, so they agree by construction even when both are wrong about this photo. The
    # two checks below compare the answer with input.png instead. Neither looks at what the
    # picture is of, so both hold for any photograph.
    #
    # (a) Background the second call never converted. Pure white in BOTH frames makes d = 0, so
    # alpha solves to 1 and the patch is delivered as subject; if the input is not white there,
    # it was background, and it is about to go out opaque.
    unconv = (opaque & (white.min(axis=2) >= 244.0) & (black.min(axis=2) >= 244.0)
              & (np.abs(srcf - 255.0).mean(axis=2) > 12.0))

    # (b) white.png is meant to be this photo with its background replaced, so wherever the mask
    # is about to call a pixel opaque, the frame must still show what the input shows there. Tile
    # by tile, because a hole is small and a frame-wide average would swallow it. Judge a tile
    # only if it is mostly inside the silhouette; call it off if the mean difference is large, if
    # both sides have texture that does not correlate, or if one side is flat where the other is
    # busy.
    m = tiles(opaque[:h, :w].astype(np.float32))
    n = m.sum(axis=2)
    judged = n >= T * T * 0.5
    nz = np.maximum(n, 1.0)
    gs, gw = tiles(srcf.mean(axis=2)), tiles(white.mean(axis=2))
    mad = (m * tiles(np.abs(srcf - white).mean(axis=2))).sum(axis=2) / nz
    mu_s, mu_w = (m * gs).sum(axis=2) / nz, (m * gw).sum(axis=2) / nz
    ds, dw = gs - mu_s[..., None], gw - mu_w[..., None]
    sd_s = np.sqrt(np.maximum((m * ds * ds).sum(axis=2) / nz, 0.0))
    sd_w = np.sqrt(np.maximum((m * dw * dw).sum(axis=2) / nz, 0.0))
    corr = (m * ds * dw).sum(axis=2) / nz / np.maximum(sd_s * sd_w, 1e-6)
    off = judged & ((mad > 40.0)
                    | ((sd_s >= 6.0) & (sd_w >= 6.0) & (corr < 0.35))
                    | ((sd_s < 4.0) & (sd_w >= 16.0)) | ((sd_w < 4.0) & (sd_s >= 16.0)))
    judged_n, off_n = int(judged.sum()), int(off.sum())

    # A hole is a patch, and a patch is contiguous. A redraw that merely wanders off the
    # original disagrees in scattered single tiles wherever the picture happened to be busy,
    # which is the difference that tells the two apart at any size. Count a tile as clustered
    # when it has at least two off neighbours in its 3x3 - padded, so tiles at the edge of the
    # frame are not treated as neighbours of tiles at the opposite edge.
    o = off.astype(np.int32)
    p = np.pad(o, 1)
    nb = sum(p[dy:dy + o.shape[0], dx:dx + o.shape[1]]
             for dy in (0, 1, 2) for dx in (0, 1, 2))
    clustered = off & (nb >= 3)

    return {'alpha': alpha, 'a8': a8, 'off': off, 'clustered': clustered, 'unconv': unconv,
            'clear': float((a8 == 0).mean()), 'solid': float((a8 == 255).mean()),
            'opaque_px': opaque_px, 'unconv_px': int(unconv.sum()),
            'judged_n': judged_n, 'off_n': off_n, 'clustered_n': int(clustered.sum()),
            'agree': 1.0 - off_n / max(judged_n, 1)}

def report(q):
    print('CHECK transparent=%.2f%% partial=%.2f%% opaque=%.2f%% agree=%.0f%%(%d/%d tiles) '
          'unconverted=%dpx subject=%s'
          % (q['clear'] * 100, (1 - q['clear'] - q['solid']) * 100, q['solid'] * 100,
             q['agree'] * 100, q['judged_n'] - q['off_n'], q['judged_n'], q['unconv_px'], S))

def where(mask, grid):
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return ''
    s = T if grid else 1
    return ' around x=%d..%d y=%d..%d' % (xs.min() * s, xs.max() * s + s - 1,
                                          ys.min() * s, ys.max() * s + s - 1)

def deliver(black, q):
    # Un-premultiply: obs_black is alpha * F, so the subject's own colour is obs_black / alpha.
    # Fully-opaque pixels are taken from the ORIGINAL instead — the model redraws the subject,
    # and its redrawing is not the photograph the user sent. Only the partly-transparent edge
    # comes from the solved frame, because an anti-aliased boundary is a blend of subject and
    # background that the original cannot supply.
    F = black / np.clip(q['alpha'], 1e-3, 1.0)[..., None]
    rgb_out = np.where(q['a8'][..., None] == 255, srcf, np.clip(F, 0.0, 255.0)).astype(np.uint8)
    Image.fromarray(np.dstack([rgb_out, q['a8']]), 'RGBA').save(D + '/output.png')

white, black = frame('white.png'), frame('black.png')
q = measure(white, black)
report(q)

# Each rule also says which frames have to be drawn again. A fault that only the black call can
# have caused does not condemn the white frame, and redrawing a frame that already passed is
# both a wasted 2K generation and a fresh chance for it to come back wrong.
fatal, soft, hint, regen = [], [], {}, set()
if q['clear'] < 0.001:
    fatal.append('THE TWO FRAMES MATCH: only %.2f%% of this came out transparent, so white.png '
                 'and black.png carry the same background and there is nothing to subtract. '
                 'Check the second call really edited white.png to a black background.'
                 % (q['clear'] * 100))
    regen |= {'white', 'black'}
if q['solid'] < 0.001:
    fatal.append('THE SUBJECT IS GONE: %.2f%% of this is fully opaque, so one of the two frames '
                 'came back blank.' % (q['solid'] * 100))
    regen |= {'white', 'black'}
if q['judged_n'] >= 8 and q['agree'] < 0.75:
    fatal.append('THE FRAMES ARE NOT THIS PHOTO: %d of %d tiles inside the silhouette show '
                 'something other than the input%s. The model re-framed, rescaled or redrew the '
                 'subject instead of only changing the background, so this mask fits a picture '
                 'nobody asked for: laid over the original it would cut out the wrong pixels.'
                 % (q['off_n'], q['judged_n'], where(q['off'], True)))
    hint['white'] = (f' Do not crop, zoom, pan, rotate or re-centre anything. The output frame '
                     f'must match the input frame exactly: same field of view, {S} the same '
                     f'size, in the same place, covering the same pixels. A previous attempt '
                     f'moved it, which made the result unusable. Change only the background '
                     f'colour.')
    regen |= {'white', 'black'}
if q['unconv_px'] > max(256, 0.005 * q['opaque_px']):
    fatal.append('BACKGROUND LEFT INSIDE THE SUBJECT: %d pixels%s are pure white in both frames '
                 'while the input is not white there, so the second call never converted that '
                 'patch and it would be delivered opaque.'
                 % (q['unconv_px'], where(q['unconv'], False)))
    hint['black'] = (f' This includes any white area fully enclosed by {S} - a hole '
                     f'through it, a gap between its parts, the space inside a handle, a loop or '
                     f'a ring. A previous attempt left such a patch white; every white pixel that '
                     f'is not {S} itself has to become black.')
    regen.add('black')
# A couple of odd tiles is what a redraw of a busy photograph looks like, not a defect: the model
# never returns the subject byte-for-byte. A fixed count of 2 made that noise a rejection on every
# large photo, which cost two more generations and threw away a frame scoring 914 of 916. Two
# readings of the same tiles now have to agree before another attempt is spent:
#
#   - enough of them to be more than noise, scaled to the silhouette so that the same picture is
#     judged the same way whatever size it arrives at, with a floor for small ones where a single
#     tile really is a large fraction of the subject;
#   - or few but contiguous, because a gap painted over as subject is a patch and stays a patch
#     however large the photo around it is. Scaling alone would have let a six-tile hole through
#     on a nine-hundred-tile silhouette, which is the same defect this check exists to catch.
#
# The fatal rules above are untouched. This one only decides when a merely suspect frame is worth
# drawing again.
soft_min = max(4, int(q['judged_n'] * 0.03))
if not fatal and (q['off_n'] >= soft_min or q['clustered_n'] >= 4):
    at = q['clustered'] if q['clustered_n'] else q['off']
    soft.append('SUSPECT %d of %d tiles inside the silhouette do not match the input, %d of them '
                'in a contiguous patch%s, which is what an enclosed gap painted over as subject '
                'looks like.'
                % (q['off_n'], q['judged_n'], q['clustered_n'], where(at, True)))
    hint['white'] = hint.get('white', '') + (
        ' Look again at the area around x=%d y=%d: if the backdrop is visible there it is '
        'background and must come out white, however completely the subject surrounds it.'
        % (int(np.nonzero(at)[1].mean() * T), int(np.nonzero(at)[0].mean() * T)))
    regen |= {'white', 'black'}

if not fatal and not soft:
    deliver(black, q)
    sys.exit(0)

# Keep this attempt where a later one can still reach it. Frames that are about to be drawn again
# are moved, so a STEP 2 that dies cannot leave a stale frame to be scored a second time; a frame
# being kept is copied instead, because it stays in place for the next black call to edit.
try:
    log = json.load(open(D + '/attempts.json'))
except Exception:
    log = []
n = len(log) + 1
files = {}
for name in ('white', 'black'):
    live = '%s/%s.png' % (D, name)
    if os.path.exists(live):
        arch = 'attempt-%d-%s.png' % (n, name)
        (os.replace if name in regen else shutil.copyfile)(live, D + '/' + arch)
        files[name] = arch
log.append({'n': n, 'fatal': bool(fatal), 'off': q['off_n'], 'unconv': q['unconv_px'],
            'files': files})
json.dump(log, open(D + '/attempts.json', 'w'))

for line in fatal + soft:
    print(line)

if n < MAX_ATTEMPTS:
    json.dump(hint, open(D + '/retry.json', 'w'))
    json.dump(sorted(regen) or ['white', 'black'], open(D + '/plan.json', 'w'))
    sys.exit('ATTEMPT %d REJECTED, no file written. Run the STEP 2 command again exactly as it '
             'is - it picks up %s/retry.json by itself - then run this STEP 3 command again.'
             % (n, D))

# Out of attempts. Being rejected is not the same as being unusable: only a fatal fault makes
# frames worthless, whereas a suspect attempt was set aside in the hope of a better one, not
# because it was broken. Three attempts used to end in nothing whenever the last of them happened
# to be the bad one, discarding a perfectly deliverable earlier frame on the way. Take the best of
# what was actually drawn instead, and fail only when every attempt was genuinely faulty.
usable = [a for a in log if not a['fatal'] and len(a['files']) == 2]
if not usable:
    open(D + '/failure.txt', 'w').write(
        'Background removal gave up after %d attempts, every one of them faulty. subject=%s. '
        'Last attempt: transparent=%.2f%% opaque=%.2f%% agree=%.0f%%(%d/%d tiles) '
        'unconverted=%dpx. %s\n'
        % (n, S, q['clear'] * 100, q['solid'] * 100, q['agree'] * 100,
           q['judged_n'] - q['off_n'], q['judged_n'], q['unconv_px'], ' '.join(fatal + soft)))
    sys.exit('GIVING UP after %d attempts, every one of them faulty. Do not upload anything: run '
             'the STEP 5 command to report %s/failure.txt, then reply with the CHECK line and the '
             'reason above.' % (n, D))
best = min(usable, key=lambda a: (a['off'], a['unconv']))
bw, bb = frame(best['files']['white']), frame(best['files']['black'])
qb = measure(bw, bb)
deliver(bb, qb)
print('DELIVERING attempt %d of %d - not perfect, but the closest to the input of everything '
      'these %d attempts drew. %d of %d tiles inside the silhouette still disagree, so check the '
      'result before using it. Put this line in your reply, and the CHECK line below it, which '
      'describes the file that is about to be uploaded.' % (best['n'], n, n, qb['off_n'],
                                                            qb['judged_n']))
report(qb)
EOF

That script is complete as written. There is no threshold to tune, no key colour to fill in and
no number to retype — it reads the two frames STEP 2 wrote and solves for alpha directly. Do not
edit it, and in particular do not replace the subtraction with a colour comparison against one
frame: estimating alpha from a colour distance is exactly the method this replaced, and it cost
a 13-pixel blurred edge, a coloured halo and a scatter of stray background pixels.

Do not "improve" it by taking the colour channels from the generated frames instead of src
either. Keeping the original's own pixels inside the silhouette is why the result is sharp; the
generated frames are there to say *where* the subject is and how much of it is there, not to
redraw it.

Print the CHECK line in your reply, all of it. \`transparent/partial/opaque\` say how much came
out see-through; \`agree\` and \`unconverted\` say whether the frames are about the photo that was
sent, which the first three cannot tell you — a mask cut from a rescaled redraw scores a
perfectly healthy-looking transparent/partial/opaque split. \`subject\` says what was cut out,
which none of the others can tell you either: a cutout of the wrong object scores perfectly on
every number on that line, because the arithmetic was right and only the choice was wrong.

If the script exits without writing a file, do exactly what it says: run the STEP 2 command
again unchanged (it reads the notes STEP 3 left for it) and then STEP 3 again. Up to three
attempts. Never upload a file this script refused to write, and never edit the frames or the
script by hand to get past it.

On the third attempt the script stops asking for better and hands back the best of what it has,
which is usually not the third attempt: it keeps every attempt it drew and picks the one that
matches the input most closely. A \`DELIVERING attempt N of 3\` line means exactly that — a real
result, with the reservation printed next to it. Upload it as normal and pass both that line and
the CHECK line under it through to your reply; that CHECK line, not the earlier one, describes
the file you uploaded. It only says \`GIVING UP\` when every attempt was faulty, and then there is
genuinely nothing to send: report it with STEP 5 instead of uploading.

If PIL, numpy or google-genai is unavailable, do not improvise and do not upload — say which
import failed in your reply instead.

STEP 4 — upload the result:
  curl -sS -X PUT --data-binary @${workDir}/output.png \\
    -H 'content-type: image/png' \\
    -H 'x-job-token: ${token}' \\
    -H "x-input-sha256: $(sha256sum ${workDir}/input.png | cut -d' ' -f1)" \\
    '${uploadUrl}'

That last header is a checksum of the file you actually processed. The Worker compares it with
the image it staged for this job and rejects the upload if they differ, which is how a mixed-up
input gets caught instead of being delivered to the wrong person. Compute it from
${workDir}/input.png as shown — do not copy a checksum from anywhere else.

A 200 response means the upload succeeded. Then reply with DONE, followed by the subject line
and the two frame lines STEP 2 printed and the whole CHECK line STEP 3 printed, plus any
SUSPECT line — nothing else. Those lines are the only record of what was cut out, what
resolution the model actually returned, how much of the frame came out transparent, and whether
the frames were about the photo that was sent. They are read by a person, not parsed by the
Worker.

STEP 5 — only when there is nothing to upload. Send the reason back:

  curl -sS -X POST --data-binary @${workDir}/failure.txt \\
    -H 'content-type: text/plain' \\
    -H 'x-job-token: ${token}' \\
    '${noteUrl}'

STEP 3 writes that file itself when it gives up, so run this exactly as written rather than
composing a message of your own. If some other command failed instead — a missing import, a
model call that returned nothing, a download that 404'd — write the file first, then run the
same curl:

  printf '%s\\n' 'STEP n failed: <the command> printed <what it printed>' > ${workDir}/failure.txt

Do this before you reply. A person is watching a progress bar on the other side of this and your
reply text does not reach them: without this call, all they are ever told is that the wait ran
out — which is equally true of a crash, a refusal and a model outage. This is the only way the
real reason gets to them. If the curl itself fails, carry on and put the reason in your reply
instead: it is a report, not a gate, and it must never become a second failure.

Never run STEP 5 for a job you uploaded. The upload is the answer, and a failure note on top of
a delivered cutout only contradicts it.

The upload is how the result gets back — your reply text is not the delivery channel, so do
not paste base64 into it. If any step fails, reply with plain text saying exactly which
command failed and what it printed. An honest failure is useful; a placeholder image, a 1x1
PNG, a checkerboard, or the input returned unchanged is worse than nothing and will be
rejected.`;
}

/** PNG dimensions straight out of the IHDR chunk. Null for anything that is not a PNG. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 26) return null;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Can this PNG express transparency at all?
 *
 * IHDR byte 25 is the colour type: 6 = RGBA, 4 = grey+alpha, 3 = palette (transparent only
 * if a tRNS chunk is present), 2 = RGB, 0 = greyscale. Types 0 and 2 have nowhere to store
 * alpha, so a "cutout" in one of them is opaque by construction.
 *
 * This is not pedantry about file formats. Asked for a transparent background, the image
 * model returned an opaque RGB PNG with a grey-and-white checkerboard painted into it, and
 * every other check passed it: right magic bytes, sensible dimensions, 848 KB of real
 * detail. Colour type is what tells the two apart.
 */
export function pngHasAlpha(bytes: Uint8Array): boolean | null {
  if (!pngDimensions(bytes)) return null;
  const colorType = bytes[25];
  if (colorType === 6 || colorType === 4) return true;
  if (colorType === 3) {
    // Look for a tRNS chunk in the header region rather than walking every chunk: it is
    // required to appear before the first IDAT.
    const head = bytes.subarray(0, Math.min(bytes.length, 4096));
    for (let i = 0; i + 3 < head.length; i++) {
      if (head[i] === 0x74 && head[i + 1] === 0x52 && head[i + 2] === 0x4e && head[i + 3] === 0x53) {
        return true;
      }
    }
    return false;
  }
  return false;
}

/**
 * An agent that never received the image still has to answer something, and in practice
 * it answers with a 1x1 transparent PNG. That used to sail through as a success: saved to
 * R2, HTTP 200, an invisible "result" for the user. Catch it here instead.
 */
/** JPEG has no alpha channel in any variant, so a JPEG cutout is a contradiction. */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export function assertUsableCutout(base64Data: string, agentName: string): void {
  let bytes: Uint8Array;
  try {
    const binary = atob(base64Data);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    throw new HttpError(
      502,
      'agent_bad_image',
      `Manyfold Agent ("${agentName}") returned image data that could not be decoded.`,
    );
  }
  assertUsableCutoutBytes(bytes, agentName);
}

export function assertUsableCutoutBytes(bytes: Uint8Array, agentName: string): void {
  // Check the container before the contents. The first real cutout the agent uploaded was
  // 848 KB of genuine detail — and a JPEG, sent with content-type image/png. Every
  // size-and-dimension test passed it, because the problem was not the picture.
  if (isJpeg(bytes)) {
    throw new HttpError(
      502,
      'agent_opaque_image',
      `Manyfold Agent ("${agentName}") returned a JPEG. JPEG has no alpha channel and cannot be a cutout, ` +
        `so return a PNG (RGBA).`,
    );
  }

  // Dimensions are the real signal. Byte length is only a fallback for formats we cannot
  // measure — a flat-colour cutout compresses far below any sane byte threshold, so
  // applying both tests at once would reject perfectly good images.
  const dimensions = pngDimensions(bytes);
  const degenerate = dimensions
    ? dimensions.width < MIN_CUTOUT_EDGE || dimensions.height < MIN_CUTOUT_EDGE
    : bytes.length < MIN_CUTOUT_BYTES;

  if (degenerate) {
    const detail = dimensions ? `${dimensions.width}x${dimensions.height}` : `${bytes.length} bytes`;
    throw new HttpError(
      502,
      'agent_placeholder_image',
      `Manyfold Agent ("${agentName}") returned a placeholder instead of a cutout (${detail}). ` +
        `The Agent may not have received the image or may be unable to output an image.`,
    );
  }

  if (pngHasAlpha(bytes) === false) {
    throw new HttpError(
      502,
      'agent_opaque_image',
      `Manyfold Agent ("${agentName}") returned a PNG without an alpha channel, so it is not a cutout. ` +
        `A common failure is drawing a checkerboard instead of true transparency.`,
    );
  }
}

function parseRemoveBgJson(text: string): { label?: string; svgPath?: string; boundingBox?: [number, number, number, number] } {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  const jsonMatch = cleaned.match(/\{[\s\S]*"svgPath"[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    const sanitized = cleaned.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
    return JSON.parse(sanitized);
  }
}

/** Everything one delegated background removal needs, once the input is already staged. */
interface AgentJob {
  env: Env;
  cred: AgentCredential;
  agentName: string;
  ticket: JobTicket;
  inputUrl: string;
  uploadUrl: string;
  /** Where the agent posts a failure it cannot upload past. See `POST /api/job/:id/note`. */
  noteUrl: string;
  mimeType: string;
  model: string;
  /** Text model for STEP 2's naming call. Unused when `subject` is set. */
  textModel: string;
  /** Caller-supplied subject phrase, sanitized. Null means STEP 2 works it out. */
  subject: string | null;
  r2Enabled: boolean;
  production: boolean;
}

/**
 * Run the agent's turn and collect its result.
 *
 * Called two ways: awaited, for the legacy synchronous response, and from `waitUntil`,
 * where the browser has already been given a job id and polls for the outcome. The only
 * difference is how long it is willing to wait — and that in the second case the return
 * value is dropped, so every conclusion it reaches is also written to the job's note.
 */
async function runAgentJob(job: AgentJob, graceMs: number, pollMs?: number): Promise<RemoveBgResponse> {
  const { env, cred, agentName, ticket } = job;
  const bucket = env.R2_IMAGE!;
  // Re-created per dispatch attempt: a rejected dispatch consumed none of the turn's budget,
  // so the timeout should start when a turn actually starts.
  let controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), REMOVE_BG_TIMEOUT_MS);

  try {
    let snapshot: StreamSnapshot | null = null;
    let streamError: string | null = null;
    const dispatchDeadline = Date.now() + Math.min(graceMs, DISPATCH_RETRY_WINDOW_MS);

    // Built once and reused across dispatch retries. Holding the messageId steady is
    // deliberate: a retry that reaches a platform which deduplicates by messageId resolves
    // to the original task rather than billing a second turn.
    const params = {
      message: {
        kind: 'message' as const,
        role: 'user' as const,
        messageId: `rmbg-${crypto.randomUUID()}`,
        // No A2A FilePart here. The agent cannot read bytes off one anyway — the
        // text prompt's STEP 1 has it curl the full image from inputUrl, which is
        // the only path that actually feeds the pixels into processing. Inlining
        // the image as base64 in this JSON-RPC body too was pure duplication, and
        // for large originals (megapixel photos run ~4MB+ of base64) it pushed the
        // request over the agent endpoint's body-size limit: a straight HTTP 413
        // that left the job stuck pending until the ticket's 10-minute TTL expired.
        parts: [
          {
            kind: 'text' as const,
            text: agentInstructions(
              workDirFor(ticket.jobId),
              job.inputUrl,
              job.uploadUrl,
              job.noteUrl,
              ticket.token,
              job.model,
              job.textModel,
              job.subject,
            ),
          },
        ],
      },
      configuration: {
        acceptedOutputModes: [
          'image/png',
          'image/jpeg',
          'image/webp',
          'text/plain',
          'application/json',
        ],
      },
    };

    for (let attempt = 0; ; attempt++) {
      try {
        snapshot = await consumeA2AStream({ cred, params, signal: controller.signal });
        break;
      } catch (streamErr: unknown) {
        const message = streamErr instanceof Error ? streamErr.message : String(streamErr);

        if (isDispatchRejection(message)) {
          // Out of patience with the turn never dispatched: no upload can arrive, so say so
          // now instead of holding the browser until the ticket expires.
          if (Date.now() >= dispatchDeadline) {
            await setJobNote(
              env,
              ticket.jobId,
              'failed',
              `The Agent stayed at capacity for too long, so this image was never started. ${message}`,
            );
            throw new HttpError(
              503,
              'agent_busy',
              `Manyfold Agent ("${agentName}") is at capacity: ${message}`,
            );
          }

          // Nothing started, so there is nothing to wait for and everything to gain by
          // asking again once a sibling turn frees a slot.
          const delay = dispatchRetryDelay(attempt);
          console.warn(`Manyfold A2A dispatch rejected, retrying in ${delay}ms:`, message);
          await setJobNoteUnlessFailed(
            env,
            ticket.jobId,
            'progress',
            `The Agent is at capacity. Waiting for a free slot, then retrying (attempt ${attempt + 2}).`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          clearTimeout(timer);
          controller = new AbortController();
          timer = setTimeout(() => controller.abort(), REMOVE_BG_TIMEOUT_MS);
          continue;
        }

        // Do not give up here. The agent's upload travels over plain HTTPS and is
        // completely independent of this stream, so a dropped stream is not evidence
        // that the job failed — only that we stopped hearing about it.
        streamError = message;
        console.error('Manyfold A2A stream error:', streamError);
        await setJobNoteUnlessFailed(
          env,
          ticket.jobId,
          'progress',
          `The Agent connection was interrupted (${streamError}), but the Agent is still running. Waiting for its upload.`,
        );
        break;
      }
    }

    // Only a *terminal* snapshot means the turn is over. A stream can also just stop —
    // consumeA2AStream returns what it accumulated when the body ends without a final
    // event — and that is the same situation as a thrown connection error: the agent is
    // still working, we simply stopped hearing about it. Give both the full grace period.
    if (snapshot && !snapshot.terminal) {
      await setJobNoteUnlessFailed(
        env,
        ticket.jobId,
        'progress',
        `The Agent stopped reporting at "${snapshot.state}" but the job is still active. Waiting for its upload.`,
      );
    }

    // The upload is the expected channel, so look there before anything else.
    const finished = snapshot?.terminal === true;
    const uploaded = await waitForUpload(bucket, ticket.outputKey, finished ? 0 : graceMs, pollMs);
    if (uploaded) {
      const bytes = new Uint8Array(await uploaded.arrayBuffer());
      const finalMime = uploaded.httpMetadata?.contentType || 'image/png';
      const cutoutBase64 = bytesToBase64(bytes);
      assertUsableCutout(cutoutBase64, agentName);

      await setJobNote(env, ticket.jobId, 'done', snapshot?.text || 'Background removal complete.');
      void pruneJobTickets(env);
      return {
        label: agentName,
        image: `data:${finalMime};base64,${cutoutBase64}`,
        mimeType: finalMime,
        r2Key: ticket.outputKey,
        r2Url: `/api/r2/${encodeURIComponent(ticket.outputKey)}`,
      };
    }

    if (snapshot?.image) {
      let cutoutDataUrl: string;
      let finalMime = snapshot.image.mimeType || 'image/png';

      if (/^https?:\/\//i.test(snapshot.image.data)) {
        const fetched = await fetchImageAsDataUrl(snapshot.image.data, {
          cred,
          production: job.production,
        });
        cutoutDataUrl = fetched.dataUrl;
        finalMime = fetched.mimeType || finalMime;
      } else if (snapshot.image.data.startsWith('data:')) {
        cutoutDataUrl = snapshot.image.data;
      } else {
        cutoutDataUrl = `data:${finalMime};base64,${snapshot.image.data}`;
      }

      // Verify before it reaches R2 — a placeholder must not become a stored "result".
      assertUsableCutout(cutoutDataUrl.slice(cutoutDataUrl.indexOf(',') + 1), agentName);

      let r2Info: { r2Key: string; r2Url: string } | null = null;
      if (job.r2Enabled) {
        r2Info = await saveImageToR2(env, cutoutDataUrl, finalMime, agentName);
      }

      await setJobNote(env, ticket.jobId, 'done', snapshot.text || 'Background removal complete.');
      return {
        label: agentName,
        image: cutoutDataUrl,
        mimeType: finalMime,
        r2Key: r2Info?.r2Key,
        r2Url: r2Info?.r2Url,
      };
    }

    // Nothing in R2 and nothing scrapeable from the reply. Whatever the agent last
    // said is the only diagnosis available, so pass it through verbatim rather than
    // replacing it with a generic message. Name the job too: its output key is
    // readable at /api/r2/ if the upload turns up late.
    throw new HttpError(
      500,
      'agent_no_image',
      `Manyfold Agent ("${agentName}") did not upload the result to ${job.uploadUrl}. ` +
        (streamError ? `Connection issue: ${streamError}. ` : '') +
        `Agent response: ${snapshot?.text || '(no text response)'}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function handleRemoveBg(
  env: Env,
  body: RemoveBgRequest,
  origin: string,
  /**
   * Cloudflare's `executionCtx.waitUntil`. Given one, the agent path answers 202 with a
   * job id and runs the turn on borrowed time; without one it blocks, which is what the
   * tests and any non-request caller still expect.
   */
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<RemoveBgResponse> {
  if (!body.image) {
    throw new HttpError(400, 'missing_image', 'Image data is required.');
  }

  const settings = await loadAppSettings(env);

  // Parse mime type and clean base64 data
  let mimeType = 'image/jpeg';
  let base64Data = body.image;

  if (body.image.startsWith('data:')) {
    const match = body.image.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    if (match) {
      mimeType = match[1];
      base64Data = match[2];
    } else {
      const commaIdx = body.image.indexOf(',');
      if (commaIdx !== -1) {
        base64Data = body.image.slice(commaIdx + 1);
      }
    }
  }

  const apiKey = env.GEMINI_API_KEY || (typeof process !== 'undefined' ? process.env?.GEMINI_API_KEY : '');

  // 1. Prioritize Manyfold Agent A2A method if configured/allowed & connected
  if (settings.bgRemoveMode !== 'gemini_only') {
    const connectedAgents = await listConnectedAgents(env).catch(() => []);
    if (connectedAgents && connectedAgents.length > 0) {
      const selectedAgent = body.agentId
        ? connectedAgents.find((a) => a.agentId === body.agentId) || connectedAgents[0]
        : connectedAgents[0];

      try {
        const cred = await credentialFor(env, selectedAgent.agentId);

        if (!env.R2_IMAGE) {
          throw new HttpError(
            500,
            'r2_required',
            'R2 bucket R2_IMAGE is not bound. This path requires R2 because the Agent returns the image through storage.',
          );
        }

        // Hand the input over as a URL. The agent can download that; it cannot get at the
        // bytes of a FilePart, and it cannot send bytes back at all.
        const ticket = await createJobTicket(env, extensionFor(mimeType));
        const inputBytes = base64ToBytes(base64Data);
        await putImageAtKey(
          env,
          ticket.inputKey,
          inputBytes,
          mimeType,
          `input for ${selectedAgent.name}`,
          // Travels with the object so the upload route can tell a cutout of *this* image
          // apart from a cutout of whatever a sibling job happened to leave lying around.
          { [INPUT_DIGEST_METADATA]: await sha256Hex(inputBytes) },
        );
        const job: AgentJob = {
          env,
          cred,
          agentName: selectedAgent.name,
          ticket,
          inputUrl: `${origin}/api/r2/${encodeURIComponent(ticket.inputKey)}`,
          uploadUrl: `${origin}/api/job/${ticket.jobId}/output`,
          noteUrl: `${origin}/api/job/${ticket.jobId}/note`,
          mimeType,
          // Fixed, not settings.bgRemoveModel: only an -image model can render the white and
          // black frames STEP 2 needs (see GEMINI.md). bgRemoveModel picks the text model for
          // the legacy direct-API SVG-path fallback below, which is a different job entirely.
          model: 'gemini-3.1-flash-image',
          // Naming the subject is a text answer about a picture, which is the same kind of
          // question the fallback path asks, so it uses the same configured text model.
          textModel: settings.bgRemoveModel || 'gemini-3.6-flash',
          subject: sanitizeSubject(body.subject),
          r2Enabled: settings.r2Enabled,
          production: env.ENVIRONMENT === 'production',
        };

        if (waitUntil) {
          // A turn takes about five minutes and the A2A stream dies at 126 seconds, so
          // waiting here means the browser never sees a result that was produced anyway.
          // Hand back the job id instead and let the upload route record the outcome.
          await setJobNote(
            env,
            ticket.jobId,
            'progress',
            `Image handed to Manyfold Agent ("${selectedAgent.name}"). Waiting for the cutout upload.`,
          );
          waitUntil(
            runAgentJob(job, ASYNC_UPLOAD_GRACE_MS, ASYNC_UPLOAD_POLL_MS).catch(
              async (err: unknown) => {
                // Nobody is left to throw to. The note is the only way this reaches the
                // user, so it has to be written even when the failure is our own bug — but
                // never over the agent's own account of what went wrong, which is always the
                // better answer than this side's "no upload arrived".
                const message = err instanceof Error ? err.message : String(err);
                console.error('Manyfold A2A background job failed:', message);
                await setJobNoteUnlessFailed(env, ticket.jobId, 'failed', message);
              },
            ),
          );
          return {
            label: selectedAgent.name,
            jobId: ticket.jobId,
            statusUrl: `/api/job/${ticket.jobId}/status`,
          };
        }

        return await runAgentJob(job, UPLOAD_GRACE_BROKEN_MS);
      } catch (err: unknown) {
        if (err instanceof HttpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error('Manyfold A2A Error:', message);
        if (!apiKey || settings.bgRemoveMode === 'agent_only') {
          throw new HttpError(500, 'agent_error', `Manyfold Agent ("${selectedAgent.name}") failed: ${message}`);
        }
        console.warn('Falling back to direct Gemini API key legacy path after A2A failure.');
      }
    }
  }

  // 2. Direct Gemini API Key legacy fallback method if configured
  if (apiKey) {
    const baseUrl = env.MANYFOLD_API_BASE_URL && (typeof process !== 'undefined' ? process.env?.GOOGLE_GEMINI_BASE_URL : undefined);

    const ai = new GoogleGenAI({
      apiKey,
      ...(baseUrl ? { httpOptions: { baseUrl } } : {}),
    });

    try {
      const modelName = settings.bgRemoveModel || 'gemini-3.6-flash';
      const response = await ai.models.generateContent({
        model: modelName,
        contents: [
          {
            inlineData: {
              mimeType,
              data: base64Data,
            },
          },
          settings.geminiSystemPrompt + `
Return a JSON object with the following schema:
{
  "label": "short description of all main foreground subjects",
  "svgPath": "smooth closed SVG path 'd' attribute string outlining all main subjects tightly in normalized coordinates (viewBox 0 0 1000 1000). Start with 'M', use bezier curves (C, S, Q) and line segments (L), and close every subpath with 'Z'. Coordinates must span 0 to 1000 where (0,0) is top-left and (1000,1000) is bottom-right.",
  "boundingBox": [ymin, xmin, ymax, xmax]
}`,
        ],
        config: {
          responseMimeType: 'application/json',
        },
      });

      const text = response.text || '';
      const result = parseRemoveBgJson(text);

      if (!result.svgPath) {
        throw new Error('Gemini API did not return a valid SVG path mask.');
      }

      const label = result.label || 'Subject';

      return {
        label,
        svgPath: result.svgPath,
        boundingBox: result.boundingBox || [0, 0, 1000, 1000],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('RemoveBg Gemini Error:', message);
      throw new HttpError(500, 'gemini_error', `Failed to process image with Gemini API: ${message}`);
    }
  }

  throw new HttpError(
    400,
    'no_auth_method',
    'No AI processing service is available. Configure GEMINI_API_KEY in Cloudflare or connect a Manyfold Agent in Settings.'
  );
}
