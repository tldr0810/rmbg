import { describe, expect, it, vi } from 'vitest';
import {
  assertUsableCutout,
  handleRemoveBg,
  pngDimensions,
  workDirFor,
} from '../src/worker/remove-bg';
import { INPUT_DIGEST_METADATA, sha256Hex } from '../src/worker/job';
import type { Env } from '../src/worker/types';
import app from '../src/worker/index';
import * as connectModule from '../src/worker/connect';
import * as a2aModule from '../src/worker/a2a';
import { CUTOUT_PNG_BASE64, PLACEHOLDER_1X1_BASE64, makeJobDb } from './fixtures';

const mockDb = {
  prepare: () => ({
    bind: () => ({
      run: async () => {},
      all: async () => ({ results: [] }),
      first: async () => null,
    }),
    run: async () => {},
    all: async () => ({ results: [] }),
    first: async () => null,
  }),
  exec: async () => {},
  batch: async () => [],
} as unknown as D1Database;

/**
 * The agent path now hands the image over through R2, so a bucket is part of the fixture
 * rather than an optional extra. `seed` pre-loads what the agent is pretending to upload.
 */
interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
  metadata?: Record<string, string>;
}

function makeR2(seed: Record<string, StoredObject> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    bucket: {
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
          httpMetadata: { contentType: hit.contentType },
        };
      },
      async head(key: string) {
        const hit = store.get(key);
        return hit ? { size: hit.bytes.byteLength } : null;
      },
    } as unknown as R2Bucket,
  };
}

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));

/** One connected, authorized agent — the precondition for every A2A-path test below. */
function mockAgent(name = 'Test Agent') {
  vi.spyOn(connectModule, 'listConnectedAgents').mockResolvedValueOnce([
    {
      agentId: 'agent-1',
      name,
      description: 'Test',
      rpcUrl: 'https://api.manyfold.ai/rpc',
      expiresAt: null,
      verified: true,
      warning: null,
      connectedAt: '2026-08-21T00:00:00Z',
    },
  ]);
  vi.spyOn(connectModule, 'credentialFor').mockResolvedValueOnce({
    rpcUrl: 'https://api.manyfold.ai/rpc',
    token: 'test-token',
    label: name,
  });
}

/** A finished A2A turn. `image` is the artifact-in-the-reply path, which R2 supersedes. */
function snapshotOf(text: string, image?: a2aModule.ImageArtifact): a2aModule.StreamSnapshot {
  return {
    taskId: 't1',
    contextId: 'c1',
    state: 'completed',
    text,
    progressText: '',
    terminal: true,
    final: true,
    diagnostics: {
      events: 1,
      lastKind: 'status-update',
      state: 'completed',
      taskId: 't1',
      contextId: 'c1',
      imageMimeType: image?.mimeType ?? null,
      imageLength: image ? image.data.length : 0,
      imageArtifact: Boolean(image),
      final: true,
    },
    ...(image ? { image } : {}),
  };
}

/** The job id of the input the handler just staged in R2. */
const stagedJobId = (store: Map<string, unknown>): string => {
  const key = [...store.keys()].find((k) => k.endsWith('_input.png'))!;
  return key.slice('job_'.length, -'_input.png'.length);
};

describe('remove-bg handler', () => {
  it('throws HttpError 400 when no auth method or GEMINI_API_KEY is available', async () => {
    const origKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const mockEnv = { DB: mockDb } as Env;
      await expect(handleRemoveBg(mockEnv, { image: 'data:image/png;base64,abc' }, 'https://test.local')).rejects.toThrow(
        'No AI processing service is available'
      );
    } finally {
      process.env.GEMINI_API_KEY = origKey;
    }
  });

  it('throws HttpError 400 when image is missing', async () => {
    const mockEnv = { GEMINI_API_KEY: 'test-key', DB: mockDb } as Env;
    await expect(handleRemoveBg(mockEnv, { image: '' }, 'https://test.local')).rejects.toThrow(
      'Image data is required.'
    );
  });

  it('handles /api/remove-bg route 400 for bad request format', async () => {
    const res = await app.request('/api/remove-bg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'http://localhost' },
      body: JSON.stringify({}),
    }, { DB: mockDb });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe('bad_request');
  });

  it('returns image artifact directly when connected Manyfold agent returns an image', async () => {
    mockAgent();
    vi.spyOn(a2aModule, 'consumeA2AStream').mockResolvedValueOnce(
      snapshotOf('Here is your background removal', {
        mimeType: 'image/png',
        data: `data:image/png;base64,${CUTOUT_PNG_BASE64}`,
      }),
    );

    // Nothing uploaded to R2, so this exercises the fallback: a data URL scraped out of
    // the agent's plain-text reply.
    const mockEnv = { DB: mockDb, R2_IMAGE: makeR2().bucket } as Env;
    const res = await handleRemoveBg(mockEnv, { image: 'data:image/png;base64,abc' }, 'https://test.local');
    expect(res.image).toBeDefined();
    expect(res.image).toContain('data:image/png;base64,iVBORw0KGgo');
    expect(res.label).toBe('Test Agent');
  });

  it('throws diagnostic error when connected agent returns text without an image artifact', async () => {
    mockAgent();
    vi.spyOn(a2aModule, 'consumeA2AStream').mockResolvedValueOnce(
      snapshotOf('Sorry, I cannot process this image.'),
    );

    const mockEnv = { DB: mockDb, R2_IMAGE: makeR2().bucket } as Env;
    // The agent's own words are the only diagnosis available, so they must survive.
    await expect(handleRemoveBg(mockEnv, { image: 'data:image/png;base64,abc' }, 'https://test.local')).rejects.toThrow(
      'Sorry, I cannot process this image.'
    );
  });

  it('prefers the R2 upload over anything in the agent reply', async () => {
    mockAgent();

    const r2 = makeR2();
    // The agent uploads during its turn, so by the time the stream resolves the object is
    // already there. Simulate that by writing it from inside the mocked call.
    vi.spyOn(a2aModule, 'consumeA2AStream').mockImplementationOnce(async () => {
      await r2.bucket.put(`job_${stagedJobId(r2.store)}_output.png`, bytesOf(CUTOUT_PNG_BASE64), {
        httpMetadata: { contentType: 'image/png' },
      });
      return snapshotOf('DONE');
    });

    const mockEnv = { DB: mockDb, R2_IMAGE: r2.bucket } as Env;
    const res = await handleRemoveBg(mockEnv, { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` }, 'https://test.local');

    expect(res.label).toBe('Test Agent');
    expect(res.image).toContain('data:image/png;base64,iVBORw0KGgo');
    expect(res.r2Key).toMatch(/^job_[a-f0-9]{32}_output\.png$/);
  });

  it('still returns the cutout when the A2A stream dies after the upload', async () => {
    // Production, 2026-08-24: the stream died with "Network connection lost" after ~2min
    // and the whole job was reported failed. But the upload rides on its own HTTPS
    // request — losing the stream says nothing about whether the result arrived.
    mockAgent();

    const r2 = makeR2();
    vi.spyOn(a2aModule, 'consumeA2AStream').mockImplementationOnce(async () => {
      await r2.bucket.put(`job_${stagedJobId(r2.store)}_output.png`, bytesOf(CUTOUT_PNG_BASE64), {
        httpMetadata: { contentType: 'image/png' },
      });
      throw new Error('Network connection lost.');
    });

    const mockEnv = { DB: mockDb, R2_IMAGE: r2.bucket } as Env;
    const res = await handleRemoveBg(mockEnv, { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` }, 'https://test.local');

    expect(res.r2Key).toMatch(/^job_[a-f0-9]{32}_output\.png$/);
    expect(res.image).toContain('data:image/png;base64,iVBORw0KGgo');
  });

  /**
   * The agent runs every delegation in one sandbox with one /tmp. When the instructions named
   * fixed paths, a batch of six had six turns writing /tmp/input.png, /tmp/gen.png and
   * /tmp/output.png, and turns uploaded each other's pictures under their own job tokens —
   * a valid cutout of the wrong subject, which no downstream check can catch. These assert
   * the two properties that make that impossible and unnecessary respectively.
   */
  describe('the instructions sent to the agent', () => {
    /** Run one agent-path removal and hand back the prompt text it dispatched. */
    async function capturePrompt(subject?: string): Promise<{ prompt: string; jobId: string }> {
      mockAgent();
      const r2 = makeR2();
      let prompt = '';
      vi.spyOn(a2aModule, 'consumeA2AStream').mockImplementationOnce(async (options) => {
        const message = (options.params as { message: { parts: { text?: string }[] } }).message;
        prompt = message.parts[0].text ?? '';
        await r2.bucket.put(`job_${stagedJobId(r2.store)}_output.png`, bytesOf(CUTOUT_PNG_BASE64), {
          httpMetadata: { contentType: 'image/png' },
        });
        return snapshotOf('DONE');
      });

      const mockEnv = { DB: mockDb, R2_IMAGE: r2.bucket } as Env;
      await handleRemoveBg(
        mockEnv,
        { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}`, ...(subject ? { subject } : {}) },
        'https://test.local',
      );
      return { prompt, jobId: stagedJobId(r2.store) };
    }

    it('names a working directory belonging to this job and no shared /tmp file', async () => {
      const { prompt, jobId } = await capturePrompt();

      expect(prompt).toContain(workDirFor(jobId));
      expect(workDirFor(jobId)).toBe(`/tmp/rmbg-${jobId}`);
      // Every /tmp path must be under this job's directory. `find /tmp -maxdepth 1` is the
      // one bare mention and has no trailing slash, so it is not matched here.
      expect(prompt.match(/\/tmp\/(?!rmbg-)/g)).toBeNull();
    });

    it('keeps the original pixels inside the silhouette', async () => {
      // The model redraws the subject rather than returning it. Taking the opaque interior
      // from the generated frame meant shipping that redrawing upscaled to the input's size —
      // measured 2x on a real 2048x2048 job, and every cutout came back soft.
      const { prompt } = await capturePrompt();

      expect(prompt).toContain('np.array(src, dtype=np.float32)');
    });

    /**
     * Alpha is solved, not estimated. The same subject over two known backgrounds gives
     * `obs_white - obs_black = (1 - alpha) * 255` for any subject colour; the single-frame
     * chroma-key this replaced could only guess at alpha from a colour distance, and measured
     * 13 px of edge ramp and 7.33% partial alpha against an original whose own edge is 1 px
     * and 0.04%.
     */
    it('asks for a white frame and a black frame, the second edited from the first', async () => {
      const { prompt, jobId } = await capturePrompt();
      const dir = workDirFor(jobId);

      // The black frame must be an edit of the white one. Two independent generations drift,
      // and the subtraction above only cancels the subject if it did not move between frames.
      expect(prompt).toContain(`gen(D + '/input.png', D + '/white.png', WHITE`);
      expect(prompt).toContain(`gen(D + '/white.png', D + '/black.png', BLACK`);
      // Both frames hang off this job's own directory, like every other file it writes.
      expect(prompt).toContain(`D = '${dir}'`);
    });

    it('asks for 2K frames, because the API default is 1K', async () => {
      // Unset, imageConfig.imageSize defaults to 1K, and a 1024-wide mask stretched over a
      // 2048-wide photo is half the measured edge blur on its own. Capital K; lowercase is
      // rejected by the API.
      const { prompt } = await capturePrompt();

      expect(prompt).toContain("types.ImageConfig(image_size='2K')");
    });

    it('tells the model an enclosed gap is background too', async () => {
      // Left unsaid, the model reads a hole through the subject as part of the object and
      // paints around it. Both frames then agree there, alpha solves to 1, and the hole is
      // delivered opaque — 4387 px of it on the bench image, and every "too fat" pixel.
      const { prompt } = await capturePrompt();

      // The clause now names the subject rather than saying "the subject" — {S} is the Python
      // f-string hole STEP 2 fills with whatever it decided it was cutting out.
      expect(prompt).toContain('fully enclosed by {S}');
      expect(prompt).toContain('If the backdrop is visible through it, it ');
    });

    /**
     * Alpha can be solved perfectly for the wrong object.
     *
     * "The background is everything that is not the subject" never says which thing the subject
     * is, so each of the two calls resolved it by salience on its own. A production job on
     * 2026-08-25 photographed a plush toy held up in front of a gallery wall; the Monet mural
     * behind it won, the wall was whited out around the painting, and a 47%-opaque picture was
     * delivered. Every existing check passed it and was right to: the frames agreed, nothing was
     * re-framed, and the opaque pixels matched the input exactly. Nothing measurable was wrong.
     *
     * So the referent is fixed once, before either frame is drawn, and reported.
     */
    describe('choosing what to cut out', () => {
      it('names the subject once and refers both frames to that name', async () => {
        const { prompt } = await capturePrompt();

        // Decided before the frames, cached so a retry cannot change its mind mid-job.
        expect(prompt).toContain("json.dump({'subject': S}, open(D + '/subject.json', 'w'))");
        expect(prompt).toContain("S = json.load(open(D + '/subject.json'))['subject']");
        // Both prompts interpolate it instead of each resolving "the subject" for themselves.
        expect(prompt).toContain('The background is everything that is not {S}');
        expect(prompt).toContain('Do not move, resize, recolour, relight or redraw {S}');
      });

      it('asks for the presented object rather than the biggest one', async () => {
        // Area is the heuristic that lost a plush toy to the mural behind it, so the naming
        // prompt is written about depth and attention instead.
        const { prompt } = await capturePrompt();

        expect(prompt).toContain('over whatever merely covers the most pixels');
        expect(prompt).toContain('is backdrop however ');
      });

      it('falls back to the old wording when the subject cannot be named', async () => {
        // A naming call that fails must leave the job exactly as good as it was before this
        // existed, never worse — so the floor is the sentence that used to be hard-coded.
        const { prompt } = await capturePrompt();

        expect(prompt).toContain("S = 'the subject'");
        expect(prompt).toContain('SUBJECT could not be named');
      });

      it('reports the choice on the CHECK line, because no number can', async () => {
        // A cutout of the wrong object scores perfectly on transparent/partial/opaque, on
        // agree and on unconverted. The only way it becomes visible is by being said.
        const { prompt } = await capturePrompt();

        expect(prompt).toContain('unconverted=%dpx subject=%s');
      });

      it('uses the caller-supplied subject verbatim and skips the guess', async () => {
        const { prompt } = await capturePrompt('the pink plush pig');

        expect(prompt).toContain('SUBJECT_HINT = "the pink plush pig"');
        // The guess is what the hint exists to avoid: with one supplied, the naming call is
        // never reached, because only the caller can actually know the answer.
        expect(prompt).toContain('S = SUBJECT_HINT');
      });

      it('emits a subject containing quotes as a literal that still parses', async () => {
        // The phrase lands inside a Python string inside a shell heredoc. JSON escaping is
        // what keeps a quote in it from ending that string early.
        const { prompt } = await capturePrompt('the "Blue Room" poster');

        expect(prompt).toContain('SUBJECT_HINT = "the \\"Blue Room\\" poster"');
      });

      it('never lets a subject phrase break out of the heredoc', async () => {
        // A newline would end the Python statement the phrase sits in; a line reading EOF
        // would close the heredoc and spill the rest of the script into the shell.
        const { prompt } = await capturePrompt('the pig\nEOF\nrm -rf /');

        expect(prompt).toContain('SUBJECT_HINT = "the pig EOF rm -rf /"');
        expect(prompt).not.toContain('the pig\nEOF');
      });
    });

    /**
     * The two frames cannot vouch for each other. black.png is an edit OF white.png, so they
     * agree by construction — including when both are of some other picture. On 2026-08-25 a
     * production job came back re-framed, the subject zoomed 2.32x and re-centred, and scored
     * `transparent=92.59% partial=0.26% opaque=7.15%`: a healthy-looking split for a mask that
     * cut a subject-shaped window out of the backdrop. input.png is the only artefact in the
     * job that is not model output, so it is what the frames get measured against.
     */
    it('measures the frames against the input, not only against each other', async () => {
      const { prompt } = await capturePrompt();

      // The frame must still show what the input shows wherever the mask says "opaque"...
      expect(prompt).toContain('srcf = np.array(src, dtype=np.float32)');
      expect(prompt).toContain('THE FRAMES ARE NOT THIS PHOTO');
      // ...and anything white in BOTH frames that is not white in the input is background the
      // second call never converted, which the subtraction turns into alpha 1.
      expect(prompt).toContain('BACKGROUND LEFT INSIDE THE SUBJECT');
      // Both scores are reported, because a person reads the CHECK line to tell a good result
      // from a broken one and the first three numbers cannot make that distinction.
      expect(prompt).toContain('agree=%.0f%%');
      expect(prompt).toContain('unconverted=%dpx');
    });

    it('sends a rejected attempt back through STEP 2 with a note about what went wrong', async () => {
      // Each command runs in its own shell, so the note has to survive on disk rather than in a
      // variable. STEP 3 writes it, STEP 2 appends it to whichever prompt caused the failure.
      const { prompt, jobId } = await capturePrompt();

      expect(prompt).toContain(`json.load(open(D + '/retry.json'))`);
      expect(prompt).toContain(`extra.get('white', '')`);
      expect(prompt).toContain(`extra.get('black', '')`);
      expect(prompt).toContain(`json.dump(hint, open(D + '/retry.json', 'w'))`);
      // Rejected frames are kept, not overwritten: a job that ends badly stays diagnosable,
      // and the ledger is what a later attempt reads to find the best of them.
      expect(prompt).toContain(`'attempt-%d-%s.png' % (n, name)`);
      expect(prompt).toContain(`json.dump(log, open(D + '/attempts.json', 'w'))`);
      // And the retrying is bounded — an honest failure beats an unbounded spend.
      expect(prompt).toContain('MAX_ATTEMPTS = 3');
      expect(prompt).toContain('GIVING UP after %d attempts');
      expect(prompt).toContain(workDirFor(jobId));
    });

    /**
     * Two production jobs in one batch of six errored with a deliverable frame sitting on the
     * agent's disk. Both scored inside the silhouette — `agree=99.8%(914/916)`, then
     * `agree=98.9%(186/188)` — were soft-rejected in the hope of better, and the retry that
     * followed came back genuinely broken. The user got an error for a job that had already
     * succeeded twice.
     */
    it('delivers the best attempt rather than nothing when the last one is the bad one', async () => {
      const { prompt } = await capturePrompt();

      // Only a fatal fault disqualifies an attempt; a suspect one stays a candidate.
      expect(prompt).toContain(`usable = [a for a in log if not a['fatal'] and len(a['files']) == 2]`);
      expect(prompt).toContain(`best = min(usable, key=lambda a: (a['off'], a['unconv']))`);
      expect(prompt).toContain('DELIVERING attempt %d of %d');
      // Giving up is now reserved for the case where there is genuinely nothing to send.
      expect(prompt).toContain('GIVING UP after %d attempts, every one of them faulty');
      // The delivered attempt is re-measured, so the CHECK line describes the uploaded file
      // rather than whichever attempt happened to run last.
      expect(prompt).toContain('qb = measure(bw, bb)');
      expect(prompt).toContain('deliver(bb, qb)');
    });

    /**
     * A fixed threshold of two odd tiles is noise on a large photo — 914 of 916 tiles agreeing
     * was being called a defect — and each rejection costs two more 2K generations. Scaling it
     * with the silhouette judges the same picture the same way at any size.
     */
    it('scales the suspect-tile threshold with the size of the silhouette', async () => {
      const { prompt } = await capturePrompt();

      expect(prompt).toContain(`soft_min = max(4, int(q['judged_n'] * 0.03))`);
      expect(prompt).toContain(`if not fatal and (q['off_n'] >= soft_min or q['clustered_n'] >= 4):`);
      expect(prompt).not.toContain('off_n >= 2');
      // The fatal thresholds are a separate judgement and stay exactly where they were.
      expect(prompt).toContain(`if q['judged_n'] >= 8 and q['agree'] < 0.75:`);
      expect(prompt).toContain(`if q['unconv_px'] > max(256, 0.005 * q['opaque_px']):`);
    });

    /**
     * A percentage alone trades one blind spot for another: three percent of a 900-tile
     * silhouette is 27, so a small gap painted over as subject would ship. What separates a
     * real hole from redraw noise is not how many tiles disagree but whether they touch — a
     * hole is a patch, noise is scattered — and that reading does not change with the size
     * of the picture, so it runs alongside the percentage rather than replacing it.
     */
    it('catches a contiguous patch of odd tiles however large the silhouette', async () => {
      const { prompt } = await capturePrompt();

      // Neighbour count over the 3x3, padded so opposite edges of the frame are not adjacent.
      expect(prompt).toContain('p = np.pad(o, 1)');
      expect(prompt).toContain(`clustered = off & (nb >= 3)`);
      expect(prompt).toContain(`'clustered': clustered`);
      // The reported location is the patch when there is one, so the retry hint names the gap
      // rather than every stray tile in the frame.
      expect(prompt).toContain(`at = q['clustered'] if q['clustered_n'] else q['off']`);
      expect(prompt).toContain('in a contiguous patch%s');
    });

    /**
     * The white frame is measured against input.png and the black frame is an edit of it, so a
     * fault only the black call can have caused leaves a frame that already passed. Redrawing
     * it spends a 2K generation for a fresh chance at a different failure.
     */
    it('redraws only the frame that was at fault', async () => {
      const { prompt } = await capturePrompt();

      // The unconverted-patch check is the one that indicts the black call alone.
      expect(prompt).toContain(`regen.add('black')`);
      expect(prompt).toContain(`json.dump(sorted(regen) or ['white', 'black'], open(D + '/plan.json', 'w'))`);
      // STEP 2 reads the plan and keeps a frame it was not asked to draw again.
      expect(prompt).toContain(`plan = set(json.load(open(D + '/plan.json')))`);
      expect(prompt).toContain(`if 'white' in plan or not os.path.exists(D + '/white.png'):`);
      // A frame being kept is copied, not moved: the next black call edits it in place.
      expect(prompt).toContain(`(os.replace if name in regen else shutil.copyfile)`);
      // Missing plan.json — the first attempt — still draws both.
      expect(prompt).toContain(`plan = {'white', 'black'}`);
    });

    /**
     * The A2A stream dies at 126 seconds and the turn runs for minutes, so the agent's account
     * of a failure reaches nobody: the browser polls a job row, and all this side ever observes
     * is that no upload arrived. Four failures in one batch were reported as an expired wait.
     */
    it('gives a turn with nothing to upload a way to say why', async () => {
      const { prompt, jobId } = await capturePrompt();

      expect(prompt).toContain(`/api/job/${jobId}/note`);
      expect(prompt).toContain(`--data-binary @${workDirFor(jobId)}/failure.txt`);
      // STEP 3 writes the file itself, so the reason is the script's words, not a paraphrase.
      expect(prompt).toContain(`open(D + '/failure.txt', 'w').write(`);
      // A delivered cutout must never be contradicted by a failure note on top of it.
      expect(prompt).toContain('Never run STEP 5 for a job you uploaded');
    });

    it('carries no chroma-key machinery any more', async () => {
      const { prompt } = await capturePrompt();

      for (const gone of ['key.json', 'mindist', 'magenta', 'decontam', 'gen.png']) {
        expect(prompt).not.toContain(gone);
      }
    });

    it('asks for a digest of the file the agent actually processed', async () => {
      const { prompt } = await capturePrompt();
      expect(prompt).toContain('x-input-sha256');
      expect(prompt).toContain('sha256sum');
    });
  });

  it('records the staged input digest so the upload can be checked against it', async () => {
    mockAgent();
    const r2 = makeR2();
    vi.spyOn(a2aModule, 'consumeA2AStream').mockImplementationOnce(async () => {
      await r2.bucket.put(`job_${stagedJobId(r2.store)}_output.png`, bytesOf(CUTOUT_PNG_BASE64), {
        httpMetadata: { contentType: 'image/png' },
      });
      return snapshotOf('DONE');
    });

    const mockEnv = { DB: mockDb, R2_IMAGE: r2.bucket } as Env;
    await handleRemoveBg(
      mockEnv,
      { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` },
      'https://test.local',
    );

    const input = r2.store.get(`job_${stagedJobId(r2.store)}_input.png`)!;
    expect(input.metadata?.[INPUT_DIGEST_METADATA]).toBe(await sha256Hex(bytesOf(CUTOUT_PNG_BASE64)));
  });

  it('rejects a placeholder even when it arrived through the upload', async () => {
    mockAgent();

    const r2 = makeR2();
    vi.spyOn(a2aModule, 'consumeA2AStream').mockImplementationOnce(async () => {
      await r2.bucket.put(`job_${stagedJobId(r2.store)}_output.png`, bytesOf(PLACEHOLDER_1X1_BASE64), {
        httpMetadata: { contentType: 'image/png' },
      });
      return snapshotOf('DONE');
    });

    const mockEnv = { DB: mockDb, R2_IMAGE: r2.bucket } as Env;
    await expect(
      handleRemoveBg(mockEnv, { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` }, 'https://test.local'),
    ).rejects.toThrow('returned a placeholder');
  });
});

/**
 * The asynchronous path, which exists because the synchronous one could not work: the
 * agent needs about five minutes and the A2A stream dies at 126 seconds, so the browser
 * timed out on results that had already been produced and stored.
 */
describe('remove-bg, asynchronously', () => {
  /** Stands in for executionCtx.waitUntil, keeping the scheduled work awaitable. */
  function makeWaitUntil() {
    const scheduled: Promise<unknown>[] = [];
    return {
      scheduled,
      waitUntil: (promise: Promise<unknown>) => {
        scheduled.push(promise);
      },
      settle: () => Promise.all(scheduled),
    };
  }

  it('answers with a job id instead of an image, without waiting for the turn', async () => {
    mockAgent();
    const r2 = makeR2();
    const { db } = makeJobDb();
    const ctx = makeWaitUntil();

    // The turn never finishes. That must not stop the response: this promise is only
    // resolved after the assertions below have already run.
    let endTurn: () => void = () => {};
    vi.spyOn(a2aModule, 'consumeA2AStream').mockImplementationOnce(
      () => new Promise((resolve) => { endTurn = () => resolve(snapshotOf('DONE')); }),
    );

    const res = await handleRemoveBg(
      { DB: db, R2_IMAGE: r2.bucket } as Env,
      { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` },
      'https://test.local',
      ctx.waitUntil,
    );

    expect(res.jobId).toMatch(/^[a-f0-9]{32}$/);
    expect(res.statusUrl).toBe(`/api/job/${res.jobId}/status`);
    expect(res.image).toBeUndefined();
    // The input is staged before the response, so the agent can already download it.
    expect(r2.store.has(`job_${res.jobId}_input.png`)).toBe(true);
    expect(ctx.scheduled).toHaveLength(1);

    endTurn();
    await ctx.settle();
  });

  it('says what it is waiting for while the job runs', async () => {
    mockAgent('Cutout Bot');
    const r2 = makeR2();
    const { db, notes } = makeJobDb();
    const ctx = makeWaitUntil();
    vi.spyOn(a2aModule, 'consumeA2AStream').mockImplementationOnce(async () => {
      await r2.bucket.put(`job_${stagedJobId(r2.store)}_output.png`, bytesOf(CUTOUT_PNG_BASE64), {
        httpMetadata: { contentType: 'image/png' },
      });
      return snapshotOf('DONE');
    });

    const res = await handleRemoveBg(
      { DB: db, R2_IMAGE: r2.bucket } as Env,
      { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` },
      'https://test.local',
      ctx.waitUntil,
    );

    // A note exists from the moment the job is handed over — a poller that sees nothing
    // cannot tell "queued" from "lost".
    expect(notes.get(res.jobId!)).toMatchObject({ kind: 'progress' });
    expect(notes.get(res.jobId!)?.note).toContain('Cutout Bot');

    await ctx.settle();
    expect(notes.get(res.jobId!)).toMatchObject({ kind: 'done' });
  });

  it("records the agent's own words when the turn ends with no result", async () => {
    // The failure used to travel back in the HTTP response. Nothing is waiting on that
    // response any more, so if this is not written down the browser polls forever.
    mockAgent();
    const r2 = makeR2();
    const { db, notes } = makeJobDb();
    const ctx = makeWaitUntil();
    vi.spyOn(a2aModule, 'consumeA2AStream').mockResolvedValueOnce(
      snapshotOf('python3: No module named PIL'),
    );

    const res = await handleRemoveBg(
      { DB: db, R2_IMAGE: r2.bucket } as Env,
      { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` },
      'https://test.local',
      ctx.waitUntil,
    );
    await ctx.settle();

    const note = notes.get(res.jobId!);
    expect(note?.kind).toBe('failed');
    expect(note?.note).toContain('python3: No module named PIL');
  });

  it('keeps waiting, rather than failing, when only the stream breaks', async () => {
    // Proven in production: the stream drops at ~2 minutes and the agent uploads anyway.
    // A broken stream is therefore progress, not a verdict — the note must not say failed.
    mockAgent();
    const r2 = makeR2();
    const { db, notes } = makeJobDb();
    const ctx = makeWaitUntil();
    vi.spyOn(a2aModule, 'consumeA2AStream').mockImplementationOnce(async () => {
      // Upload first, so the (zero-length) wait that follows finds it immediately.
      await r2.bucket.put(`job_${stagedJobId(r2.store)}_output.png`, bytesOf(CUTOUT_PNG_BASE64), {
        httpMetadata: { contentType: 'image/png' },
      });
      throw new Error('Network connection lost.');
    });

    const res = await handleRemoveBg(
      { DB: db, R2_IMAGE: r2.bucket } as Env,
      { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` },
      'https://test.local',
      ctx.waitUntil,
    );
    await ctx.settle();

    expect(notes.get(res.jobId!)?.kind).toBe('done');
  });

  it('treats a stream that merely stops as still running, and finishes when the upload lands', async () => {
    // consumeA2AStream returns a non-terminal snapshot when the SSE body ends without a
    // final event. That is the same situation as a thrown connection error — the agent is
    // still working, we just stopped hearing about it — so it must get the same grace,
    // not be read as "the turn finished and never uploaded".
    vi.useFakeTimers();
    try {
      mockAgent();
      const r2 = makeR2();
      const { db, notes } = makeJobDb();
      const ctx = makeWaitUntil();
      vi.spyOn(a2aModule, 'consumeA2AStream').mockResolvedValueOnce({
        ...snapshotOf('still working'),
        state: 'working',
        terminal: false,
        final: false,
      });

      const res = await handleRemoveBg(
        { DB: db, R2_IMAGE: r2.bucket } as Env,
        { image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` },
        'https://test.local',
        ctx.waitUntil,
      );
      const settled = ctx.settle();

      // A minute later, with nothing in R2 yet, the job is still open rather than failed.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(notes.get(res.jobId!)).toMatchObject({ kind: 'progress' });
      expect(notes.get(res.jobId!)?.note).toContain('working');

      await r2.bucket.put(`job_${res.jobId}_output.png`, bytesOf(CUTOUT_PNG_BASE64), {
        httpMetadata: { contentType: 'image/png' },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await settled;

      expect(notes.get(res.jobId!)).toMatchObject({ kind: 'done' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers POST /api/remove-bg with 202 and a pollable job', async () => {
    mockAgent();
    const r2 = makeR2();
    const { db } = makeJobDb();
    const ctx = makeWaitUntil();
    vi.spyOn(a2aModule, 'consumeA2AStream').mockImplementationOnce(async () => {
      await r2.bucket.put(`job_${stagedJobId(r2.store)}_output.png`, bytesOf(CUTOUT_PNG_BASE64), {
        httpMetadata: { contentType: 'image/png' },
      });
      return snapshotOf('DONE');
    });

    const res = await app.request(
      '/api/remove-bg',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify({ image: `data:image/png;base64,${CUTOUT_PNG_BASE64}` }),
      },
      { DB: db, R2_IMAGE: r2.bucket } as Env,
      { waitUntil: ctx.waitUntil, passThroughOnException: () => {} } as ExecutionContext,
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string; statusUrl: string; image?: string };
    expect(body.jobId).toMatch(/^[a-f0-9]{32}$/);
    expect(body.image).toBeUndefined();

    await ctx.settle();

    // And the job the browser was handed now reports a readable result.
    const status = await app.request(
      body.statusUrl,
      {},
      { DB: db, R2_IMAGE: r2.bucket } as Env,
    );
    const statusBody = (await status.json()) as { output: { key: string } | null };
    expect(statusBody.output?.key).toBe(`job_${body.jobId}_output.png`);
  });
});

describe('assertUsableCutout', () => {
  const PLACEHOLDER_1X1 = PLACEHOLDER_1X1_BASE64;

  /**
   * A PNG header of the given size, big enough to clear both thresholds. colorType is the
   * IHDR byte that decides whether alpha is even representable: 6 = RGBA, 2 = plain RGB.
   */
  const pngOf = (width: number, height: number, colorType = 6): string => {
    const ihdr = new Uint8Array(26);
    ihdr.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    new DataView(ihdr.buffer).setUint32(16, width);
    new DataView(ihdr.buffer).setUint32(20, height);
    ihdr[24] = 8; // bit depth
    ihdr[25] = colorType;
    const padded = new Uint8Array(2048);
    padded.set(ihdr, 0);
    let binary = '';
    for (const byte of padded) binary += String.fromCharCode(byte);
    return btoa(binary);
  };

  it('rejects the 1x1 placeholder an image-blind agent returns', () => {
    expect(() => assertUsableCutout(PLACEHOLDER_1X1, 'rmbg')).toThrow('returned a placeholder');
  });

  it('reports the placeholder dimensions so the cause is visible', () => {
    expect(() => assertUsableCutout(PLACEHOLDER_1X1, 'rmbg')).toThrow('1x1');
  });

  it('rejects a payload too small to be a cutout regardless of format', () => {
    expect(() => assertUsableCutout(btoa('tiny'), 'rmbg')).toThrow('returned a placeholder');
  });

  it('rejects data that is not valid base64', () => {
    expect(() => assertUsableCutout('!!!not base64!!!', 'rmbg')).toThrow('could not be decoded');
  });

  it('accepts a real cutout', () => {
    expect(() => assertUsableCutout(pngOf(96, 96), 'rmbg')).not.toThrow();
  });

  it('rejects an opaque RGB PNG, however large and detailed', () => {
    // Production, 2026-08-24: asked for transparency, the image model returned an 848 KB
    // colour-type-2 PNG with a checkerboard *painted* into it. Big, sharp, and not a cutout.
    expect(() => assertUsableCutout(pngOf(1264, 842, 2), 'rmbg')).toThrow('without an alpha channel');
  });

  it('rejects greyscale without alpha and accepts greyscale with it', () => {
    expect(() => assertUsableCutout(pngOf(96, 96, 0), 'rmbg')).toThrow('without an alpha channel');
    expect(() => assertUsableCutout(pngOf(96, 96, 4), 'rmbg')).not.toThrow();
  });

  it('leaves non-PNG payloads to the size check alone', () => {
    // pngHasAlpha returns null for anything it cannot parse, which must not become a reject.
    const notPng = btoa('x'.repeat(2048));
    expect(() => assertUsableCutout(notPng, 'rmbg')).not.toThrow();
  });

  it('reads PNG dimensions from the IHDR chunk', () => {
    const bytes = Uint8Array.from(atob(PLACEHOLDER_1X1), (c) => c.charCodeAt(0));
    expect(pngDimensions(bytes)).toEqual({ width: 1, height: 1 });
  });

  it('returns null for anything that is not a PNG', () => {
    expect(pngDimensions(new Uint8Array(64))).toBeNull();
  });
});
