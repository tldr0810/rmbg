import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A2AError,
  extractImageFromParts,
  fetchImageAsDataUrl,
  foldA2AResults,
  safeErrorText,
  validateA2AUrl,
} from '../src/worker/a2a';

describe('extractImageFromParts', () => {
  it('extracts inline-data image parts', () => {
    const img = extractImageFromParts([
      { kind: 'text', text: 'processing' },
      { kind: 'inline-data', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' },
    ]);
    expect(img).not.toBeNull();
    expect(img?.mimeType).toBe('image/png');
    expect(img?.data).toContain('iVBORw0KGgoAAAANSUhEUgAAAAE');
  });

  it('extracts file-data image parts', () => {
    const img = extractImageFromParts([
      { kind: 'file-data', mimeType: 'image/png', fileUri: 'https://example.com/cutout.png' },
    ]);
    expect(img).not.toBeNull();
    expect(img?.data).toBe('https://example.com/cutout.png');
  });

  it('extracts standard A2A raw image parts', () => {
    const img = extractImageFromParts([
      { raw: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', mediaType: 'image/png' },
    ]);
    expect(img).not.toBeNull();
    expect(img?.mimeType).toBe('image/png');
    expect(img?.data).toContain('iVBORw0KGgo');
  });
});

describe('foldA2AResults (stream accumulator)', () => {
  it('accumulates image artifact chunks with append: true', () => {
    const snapshot = foldA2AResults([
      {
        kind: 'artifact-update',
        artifact: {
          artifactId: 'img1',
          parts: [{ kind: 'inline-data', mimeType: 'image/png', data: 'chunk1_' }],
        },
      },
      {
        kind: 'artifact-update',
        append: true,
        artifact: {
          artifactId: 'img1',
          parts: [{ kind: 'inline-data', mimeType: 'image/png', data: 'chunk2' }],
        },
      },
      { kind: 'status-update', status: { state: 'completed' } },
    ]);
    expect(snapshot.image).toBeDefined();
    expect(snapshot.image?.mimeType).toBe('image/png');
    expect(snapshot.image?.data).toBe('chunk1_chunk2');
    expect(snapshot.terminal).toBe(true);
  });

  it('extracts base64 image data URL embedded in text fallback', () => {
    const snapshot = foldA2AResults([
      {
        kind: 'message',
        role: 'agent',
        parts: [{ kind: 'text', text: 'Here is your transparent PNG: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' }],
      },
    ]);
    expect(snapshot.image).toBeDefined();
    expect(snapshot.image?.mimeType).toBe('image/png');
    expect(snapshot.image?.data).toContain('data:image/png;base64,iVBORw');
  });

  it('accumulates artifact appends and reaches a terminal state', () => {
    const snapshot = foldA2AResults([
      { kind: 'status-update', taskId: 't1', contextId: 'c1', status: { state: 'working' } },
      { kind: 'artifact-update', artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'Hello' }] } },
      { kind: 'artifact-update', append: true, artifact: { artifactId: 'a', parts: [{ kind: 'text', text: ', world' }] } },
      { kind: 'status-update', status: { state: 'completed' }, final: true },
    ]);
    expect(snapshot.text).toBe('Hello, world');
    expect(snapshot.taskId).toBe('t1');
    expect(snapshot.contextId).toBe('c1');
    expect(snapshot.state).toBe('completed');
    expect(snapshot.terminal).toBe(true);
  });

  it('treats a final artifact marker as terminal even without a state', () => {
    const snapshot = foldA2AResults([
      {
        kind: 'artifact-update',
        final: true,
        artifact: {
          artifactId: 'img1',
          parts: [{ kind: 'inline-data', mimeType: 'image/png', data: 'final-image' }],
        },
      },
    ]);
    expect(snapshot.image?.data).toBe('final-image');
    expect(snapshot.final).toBe(true);
    expect(snapshot.terminal).toBe(true);
  });

  it('normalizes done and success states to completed', () => {
    expect(foldA2AResults([{ status: { state: 'done' } }]).state).toBe('completed');
    expect(foldA2AResults([{ status: { state: 'success' } }]).state).toBe('completed');
  });

  it('replaces an artifact when append is not set', () => {
    const snapshot = foldA2AResults([
      { kind: 'artifact-update', artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'draft' }] } },
      { kind: 'artifact-update', artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'final' }] } },
    ]);
    expect(snapshot.text).toBe('final');
  });

  it('joins multiple artifacts in insertion order', () => {
    const snapshot = foldA2AResults([
      { kind: 'artifact-update', artifact: { artifactId: 'one', parts: [{ kind: 'text', text: 'first' }] } },
      { kind: 'artifact-update', artifact: { artifactId: 'two', parts: [{ kind: 'text', text: 'second' }] } },
    ]);
    expect(snapshot.text).toBe('first\n\nsecond');
  });

  it('falls back to direct message text, then status text', () => {
    const direct = foldA2AResults([
      { kind: 'message', role: 'agent', parts: [{ kind: 'text', text: 'direct reply' }] },
    ]);
    expect(direct.text).toBe('direct reply');

    const status = foldA2AResults([
      { kind: 'status-update', status: { state: 'working', message: { parts: [{ kind: 'text', text: 'thinking…' }] } } },
    ]);
    expect(status.text).toBe('thinking…');
    // When status text is the only text, it must not double as progress.
    expect(status.progressText).toBe('');
  });

  it('keeps progress narration separate from artifact text', () => {
    const snapshot = foldA2AResults([
      { kind: 'status-update', status: { state: 'working', message: { parts: [{ kind: 'text', text: 'working on it' }] } } },
      { kind: 'artifact-update', artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'the answer' }] } },
    ]);
    expect(snapshot.text).toBe('the answer');
    expect(snapshot.progressText).toBe('working on it');
  });

  it('normalizes underscore and TASK_STATE_ prefixed states', () => {
    expect(foldA2AResults([{ status: { state: 'INPUT_REQUIRED' } }]).state).toBe('input-required');
    expect(foldA2AResults([{ status: { state: 'task_state_completed' } }]).terminal).toBe(true);
  });

  it('reads inline artifacts from a full task object', () => {
    const snapshot = foldA2AResults([
      {
        kind: 'task',
        id: 't9',
        status: { state: 'completed' },
        artifacts: [{ artifactId: 'a', parts: [{ kind: 'text', text: 'task result' }] }],
      },
    ]);
    expect(snapshot.text).toBe('task result');
    expect(snapshot.taskId).toBe('t9');
  });
});

describe('validateA2AUrl', () => {
  const label = 'the rpcUrl';

  it('accepts a public https URL and strips fragments', () => {
    expect(validateA2AUrl('https://api.manyfold.ai/api/a2a/agents/x/rpc#frag', true, label)).toBe(
      'https://api.manyfold.ai/api/a2a/agents/x/rpc',
    );
  });

  it.each([
    'http://api.manyfold.ai/rpc',
    'https://user:pass@api.manyfold.ai/rpc',
    'https://localhost/rpc',
    'https://127.0.0.1/rpc',
    'https://10.0.0.8/rpc',
    'https://192.168.1.5/rpc',
    'https://172.16.0.1/rpc',
    'https://169.254.169.254/latest/meta-data',
    'https://agent.local/rpc',
    'https://[::1]/rpc',
    'https://[fd00::1]/rpc',
    'not a url',
  ])('rejects %s in production', (url) => {
    expect(() => validateA2AUrl(url, true, label)).toThrow(A2AError);
  });

  it('allows http and private hosts in development', () => {
    expect(validateA2AUrl('http://localhost:8787/rpc', false, label)).toBe('http://localhost:8787/rpc');
  });
});

describe('fetchImageAsDataUrl', () => {
  const cred = {
    rpcUrl: 'https://api.manyfold.ai/api/a2a/agents/x/rpc',
    token: 'nca_secret_token',
    label: 'Test Agent',
  };

  const pngResponse = () =>
    new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });

  let calls: Array<{ url: string; headers: Record<string, string> }>;

  beforeEach(() => {
    calls = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
      return Promise.resolve(pngResponse());
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the bearer token when the artifact is on the agent host', async () => {
    const result = await fetchImageAsDataUrl('https://api.manyfold.ai/artifacts/1.png', {
      cred,
      production: true,
    });
    expect(result.mimeType).toBe('image/png');
    expect(calls[0].headers.authorization).toBe(`Bearer ${cred.token}`);
  });

  it('withholds the bearer token from any other host', async () => {
    await fetchImageAsDataUrl('https://attacker.example/collect.png', { cred, production: true });
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  it.each([
    'https://169.254.169.254/latest/meta-data',
    'https://127.0.0.1/artifact.png',
    'http://api.manyfold.ai/artifact.png',
    'not a url',
  ])('rejects %s in production without fetching', async (url) => {
    await expect(fetchImageAsDataUrl(url, { cred, production: true })).rejects.toThrow(A2AError);
    expect(calls).toHaveLength(0);
  });
});

describe('safeErrorText', () => {
  it('redacts bearer tokens and JWTs', () => {
    const jwt = `eyJ${'a'.repeat(24)}.${'b'.repeat(24)}.${'c'.repeat(16)}`;
    const input = `HTTP 401 Bearer nca_secret_token for ${jwt} via ?token=abc123&x=1`;
    const output = safeErrorText(input);
    expect(output).not.toContain('nca_secret_token');
    expect(output).not.toContain(jwt);
    expect(output).not.toContain('abc123');
    expect(output).toContain('Bearer [redacted]');
  });

  it('collapses whitespace and truncates', () => {
    expect(safeErrorText('a\n\n  b')).toBe('a b');
    expect(safeErrorText('x'.repeat(2000)).length).toBeLessThanOrEqual(600);
  });
});
