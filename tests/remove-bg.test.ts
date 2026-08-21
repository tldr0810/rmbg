import { describe, expect, it, vi } from 'vitest';
import { assertUsableCutout, handleRemoveBg, pngDimensions } from '../src/worker/remove-bg';
import type { Env } from '../src/worker/types';
import app from '../src/worker/index';
import * as connectModule from '../src/worker/connect';
import * as a2aModule from '../src/worker/a2a';
import { CUTOUT_PNG_BASE64, PLACEHOLDER_1X1_BASE64 } from './fixtures';

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

describe('remove-bg handler', () => {
  it('throws HttpError 400 when no auth method or GEMINI_API_KEY is available', async () => {
    const origKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const mockEnv = { DB: mockDb } as Env;
      await expect(handleRemoveBg(mockEnv, { image: 'data:image/png;base64,abc' })).rejects.toThrow(
        '無可用的 AI 處理服務'
      );
    } finally {
      process.env.GEMINI_API_KEY = origKey;
    }
  });

  it('throws HttpError 400 when image is missing', async () => {
    const mockEnv = { GEMINI_API_KEY: 'test-key', DB: mockDb } as Env;
    await expect(handleRemoveBg(mockEnv, { image: '' })).rejects.toThrow(
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
    vi.spyOn(connectModule, 'listConnectedAgents').mockResolvedValueOnce([
      {
        agentId: 'agent-1',
        name: 'Test Agent',
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
      label: 'Test Agent',
    });
    vi.spyOn(a2aModule, 'consumeA2AStream').mockResolvedValueOnce({
      taskId: 't1',
      contextId: 'c1',
      state: 'completed',
      text: 'Here is your background removal',
      progressText: '',
      terminal: true,
      final: true,
      diagnostics: {
        events: 1,
        lastKind: 'status-update',
        state: 'completed',
        taskId: 't1',
        contextId: 'c1',
        imageMimeType: 'image/png',
        imageLength: 100,
        imageArtifact: true,
        final: true,
      },
      image: {
        mimeType: 'image/png',
        data: `data:image/png;base64,${CUTOUT_PNG_BASE64}`,
      },
    });

    const mockEnv = { DB: mockDb } as Env;
    const res = await handleRemoveBg(mockEnv, { image: 'data:image/png;base64,abc' });
    expect(res.image).toBeDefined();
    expect(res.image).toContain('data:image/png;base64,iVBORw0KGgo');
    expect(res.label).toBe('Test Agent');
  });

  it('throws diagnostic error when connected agent returns text without an image artifact', async () => {
    vi.spyOn(connectModule, 'listConnectedAgents').mockResolvedValueOnce([
      {
        agentId: 'agent-1',
        name: 'Test Agent',
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
      label: 'Test Agent',
    });
    vi.spyOn(a2aModule, 'consumeA2AStream').mockResolvedValueOnce({
      taskId: 't1',
      contextId: 'c1',
      state: 'completed',
      text: 'Sorry, I cannot process this image.',
      progressText: '',
      terminal: true,
      final: true,
      diagnostics: {
        events: 1,
        lastKind: 'status-update',
        state: 'completed',
        taskId: 't1',
        contextId: 'c1',
        imageMimeType: null,
        imageLength: 0,
        imageArtifact: false,
        final: true,
      },
    });

    const mockEnv = { DB: mockDb } as Env;
    await expect(handleRemoveBg(mockEnv, { image: 'data:image/png;base64,abc' })).rejects.toThrow(
      'Manyfold Agent ("Test Agent") 未回傳圖片結果'
    );
  });
});

describe('assertUsableCutout', () => {
  const PLACEHOLDER_1X1 = PLACEHOLDER_1X1_BASE64;

  /** A real PNG of the given size, big enough to clear both thresholds. */
  const pngOf = (width: number, height: number): string => {
    const ihdr = new Uint8Array(24);
    ihdr.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    new DataView(ihdr.buffer).setUint32(16, width);
    new DataView(ihdr.buffer).setUint32(20, height);
    const padded = new Uint8Array(2048);
    padded.set(ihdr, 0);
    let binary = '';
    for (const byte of padded) binary += String.fromCharCode(byte);
    return btoa(binary);
  };

  it('rejects the 1x1 placeholder an image-blind agent returns', () => {
    expect(() => assertUsableCutout(PLACEHOLDER_1X1, 'rmbg')).toThrow('回傳了佔位圖');
  });

  it('reports the placeholder dimensions so the cause is visible', () => {
    expect(() => assertUsableCutout(PLACEHOLDER_1X1, 'rmbg')).toThrow('1x1');
  });

  it('rejects a payload too small to be a cutout regardless of format', () => {
    expect(() => assertUsableCutout(btoa('tiny'), 'rmbg')).toThrow('回傳了佔位圖');
  });

  it('rejects data that is not valid base64', () => {
    expect(() => assertUsableCutout('!!!not base64!!!', 'rmbg')).toThrow('無法解碼');
  });

  it('accepts a real cutout', () => {
    expect(() => assertUsableCutout(pngOf(96, 96), 'rmbg')).not.toThrow();
  });

  it('reads PNG dimensions from the IHDR chunk', () => {
    const bytes = Uint8Array.from(atob(PLACEHOLDER_1X1), (c) => c.charCodeAt(0));
    expect(pngDimensions(bytes)).toEqual({ width: 1, height: 1 });
  });

  it('returns null for anything that is not a PNG', () => {
    expect(pngDimensions(new Uint8Array(64))).toBeNull();
  });
});
