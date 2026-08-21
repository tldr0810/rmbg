import { describe, expect, it, vi, beforeEach } from 'vitest';
import app from '../src/worker/index';
import type { Env } from '../src/worker/types';
import { handleRemoveBg } from '../src/worker/remove-bg';
import * as connectModule from '../src/worker/connect';
import * as a2aModule from '../src/worker/a2a';
import { CUTOUT_PNG_BASE64 } from './fixtures';

let mockDbStore: Record<string, string> = {};

beforeEach(() => {
  mockDbStore = {};
});

const mockDb = {
  prepare: (sql: string) => {
    return {
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (sql.includes('INSERT INTO settings')) {
            const key = args[0] as string;
            const val = args[1] as string;
            mockDbStore[key] = val;
          }
          return { success: true };
        },
        first: async <T>() => {
          if (sql.includes('SELECT value FROM settings')) {
            const key = args[0] as string;
            if (mockDbStore[key] !== undefined) {
              return { value: mockDbStore[key] } as T;
            }
          }
          return null;
        },
        all: async () => ({ results: [] }),
      }),
      run: async () => ({ success: true }),
      first: async () => null,
      all: async () => ({ results: [] }),
    };
  },
  exec: async () => {},
  batch: async () => [],
} as unknown as D1Database;

const createMockR2 = () => {
  const store = new Map<string, { body: Uint8Array; metadata?: Record<string, string>; contentType?: string }>();
  return {
    put: async (key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) => {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      store.set(key, {
        body: bytes,
        contentType: options?.httpMetadata?.contentType || 'image/png',
        metadata: options?.customMetadata,
      });
      return null;
    },
    get: async (key: string) => {
      const item = store.get(key);
      if (!item) return null;
      return {
        body: item.body,
        httpEtag: 'test-etag',
        writeHttpMetadata: (headers: Headers) => {
          if (item.contentType) headers.set('Content-Type', item.contentType);
        },
      };
    },
    list: async () => {
      const objects = Array.from(store.entries()).map(([key, val]) => ({
        key,
        size: val.body.length,
        uploaded: new Date(),
        httpMetadata: { contentType: val.contentType },
        customMetadata: val.metadata,
      }));
      return { objects, truncated: false };
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    _store: store,
  } as unknown as R2Bucket;
};

describe('/api/settings and Cloudflare R2 endpoints', () => {
  it('gets default app settings from GET /api/settings', async () => {
    const res = await app.request('/api/settings', {
      method: 'GET',
    }, { DB: mockDb });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { settings: { bgRemoveModel: string; r2Enabled: boolean } };
    expect(data.settings.bgRemoveModel).toBe('gemini-3.6-flash');
    expect(data.settings.r2Enabled).toBe(true);
  });

  it('updates settings via POST /api/settings', async () => {
    const res = await app.request('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'http://localhost' },
      body: JSON.stringify({
        bgRemoveModel: 'gemini-3.5-pro',
        r2Enabled: false,
      }),
    }, { DB: mockDb });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { settings: { bgRemoveModel: string; r2Enabled: boolean } };
    expect(data.settings.bgRemoveModel).toBe('gemini-3.5-pro');
    expect(data.settings.r2Enabled).toBe(false);
  });

  it('lists R2 items via GET /api/r2/list', async () => {
    const mockR2 = createMockR2();
    await mockR2.put('test-cutout.png', new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: 'image/png' },
      customMetadata: { label: 'Cat Person' },
    });

    const res = await app.request('/api/r2/list', {
      method: 'GET',
    }, { DB: mockDb, R2_IMAGE: mockR2 });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { enabled: boolean; items: { key: string; url: string }[] };
    expect(data.enabled).toBe(true);
    expect(data.items.length).toBe(1);
    expect(data.items[0].key).toBe('test-cutout.png');
    expect(data.items[0].url).toContain('/api/r2/test-cutout.png');
  });

  it('serves image directly from R2 via GET /api/r2/:key', async () => {
    const mockR2 = createMockR2();
    await mockR2.put('my-image.png', new Uint8Array([137, 80, 78, 71]), {
      httpMetadata: { contentType: 'image/png' },
    });

    const res = await app.request('/api/r2/my-image.png', {
      method: 'GET',
    }, { DB: mockDb, R2_IMAGE: mockR2 });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes[0]).toBe(137);
  });

  it('deletes image from R2 via DELETE /api/r2/:key', async () => {
    const mockR2 = createMockR2();
    await mockR2.put('delete-me.png', new Uint8Array([1, 2, 3]));

    const res = await app.request('/api/r2/delete-me.png', {
      method: 'DELETE',
      headers: { Origin: 'http://localhost' },
    }, { DB: mockDb, R2_IMAGE: mockR2 });

    expect(res.status).toBe(200);
    const listRes = await mockR2.list();
    expect(listRes.objects.length).toBe(0);
  });

  it('stores output cutout transparent PNG into R2 bucket on remove-bg completion', async () => {
    vi.spyOn(connectModule, 'listConnectedAgents').mockResolvedValueOnce([
      {
        agentId: 'agent-r2',
        name: 'R2 Tester Agent',
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
      label: 'R2 Tester Agent',
    });
    vi.spyOn(a2aModule, 'consumeA2AStream').mockResolvedValueOnce({
      taskId: 't1',
      contextId: 'c1',
      state: 'completed',
      text: 'Done',
      progressText: '',
      terminal: true,
      final: true,
      diagnostics: {
        events: 1,
        lastKind: 'status',
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

    const mockR2 = createMockR2();
    const mockEnv = { DB: mockDb, R2_IMAGE: mockR2 } as Env;

    const res = await handleRemoveBg(mockEnv, { image: 'data:image/png;base64,abc' });

    expect(res.r2Key).toBeDefined();
    expect(res.r2Url).toBeDefined();
    expect(res.r2Url).toContain('/api/r2/');

    const list = await mockR2.list();
    expect(list.objects.length).toBe(1);
    expect(list.objects[0].key).toBe(res.r2Key);
  });
});
