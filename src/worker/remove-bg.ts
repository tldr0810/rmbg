import { GoogleGenAI } from '@google/genai';
import { HttpError, type Env } from './types';
import { listConnectedAgents, credentialFor } from './connect';
import { consumeA2AStream, fetchImageAsDataUrl } from './a2a';
import { loadAppSettings } from './settings-manager';
import { saveImageToR2 } from './r2';

export interface RemoveBgRequest {
  /** Base64 string or data URL */
  image: string;
  /** Optional agentId if multiple Manyfold agents are connected */
  agentId?: string;
}

export interface RemoveBgResponse {
  label: string;
  image?: string;
  mimeType?: string;
  svgPath?: string;
  boundingBox?: [number, number, number, number];
  r2Key?: string;
  r2Url?: string;
}

const REMOVE_BG_TIMEOUT_MS = 180_000;

/** Anything smaller than this is a placeholder, not a cutout. */
const MIN_CUTOUT_BYTES = 512;
const MIN_CUTOUT_EDGE = 16;

function extensionFor(mimeType: string): string {
  const subtype = mimeType.split('/')[1] ?? 'png';
  return subtype === 'jpeg' ? 'jpg' : subtype.replace(/[^a-z0-9]/gi, '') || 'png';
}

/** PNG dimensions straight out of the IHDR chunk. Null for anything that is not a PNG. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * An agent that never received the image still has to answer something, and in practice
 * it answers with a 1x1 transparent PNG. That used to sail through as a success: saved to
 * R2, HTTP 200, an invisible "result" for the user. Catch it here instead.
 */
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
      `Manyfold Agent ("${agentName}") 回傳的圖片資料無法解碼。`,
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
      `Manyfold Agent ("${agentName}") 回傳了佔位圖而非去背結果 (${detail})。` +
        `這通常表示 Agent 沒有收到圖片,或它無法輸出圖片。`,
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

export async function handleRemoveBg(env: Env, body: RemoveBgRequest): Promise<RemoveBgResponse> {
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

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REMOVE_BG_TIMEOUT_MS);

        const messageId = `rmbg-${crypto.randomUUID()}`;

        try {
          const snapshot = await consumeA2AStream({
            cred,
            params: {
              message: {
                kind: 'message',
                role: 'user',
                messageId,
                parts: [
                  // A2A 0.3.0 FilePart. NOT `kind: 'inline-data'` — that is the Google
                  // GenAI SDK's spelling, not a part kind the A2A spec defines, so the
                  // server dropped it and the agent saw a bare text prompt with no image.
                  {
                    kind: 'file',
                    file: {
                      name: `input.${extensionFor(mimeType)}`,
                      mimeType,
                      bytes: base64Data,
                    },
                  },
                  {
                    kind: 'text',
                    text: `Remove the background from the image attached to this message.

The image is attached as a file part on this very message — you already have it. Do not ask
for it, and do not say it is missing.

Return the result as a transparent PNG image artifact, at the same pixel dimensions as the
input. Preserve the subject's own pixels, colours, texture, hair, fur, edges and proportions
exactly. Do not redraw, regenerate, restyle, upscale or crop. Remove only the background.

Never answer with a 1x1 or otherwise blank placeholder image. If you cannot produce a real
cutout, reply with plain text explaining why — a placeholder is worse than an honest failure.

Do not return SVG, JSON, a polygon, or a description of what you would do.`,
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
            },
            signal: controller.signal,
          });

          if (snapshot.image) {
            let cutoutDataUrl: string;
            let finalMime = snapshot.image.mimeType || 'image/png';

            if (/^https?:\/\//i.test(snapshot.image.data)) {
              const fetched = await fetchImageAsDataUrl(snapshot.image.data, {
                cred,
                production: env.ENVIRONMENT === 'production',
              });
              cutoutDataUrl = fetched.dataUrl;
              finalMime = fetched.mimeType || finalMime;
            } else if (snapshot.image.data.startsWith('data:')) {
              cutoutDataUrl = snapshot.image.data;
            } else {
              cutoutDataUrl = `data:${finalMime};base64,${snapshot.image.data}`;
            }

            // Verify before it reaches R2 — a placeholder must not become a stored "result".
            assertUsableCutout(cutoutDataUrl.slice(cutoutDataUrl.indexOf(',') + 1), selectedAgent.name);

            let r2Info: { r2Key: string; r2Url: string } | null = null;
            if (settings.r2Enabled && env.R2_IMAGE) {
              r2Info = await saveImageToR2(env, cutoutDataUrl, finalMime, selectedAgent.name);
            }

            return {
              label: selectedAgent.name,
              image: cutoutDataUrl,
              mimeType: finalMime,
              r2Key: r2Info?.r2Key,
              r2Url: r2Info?.r2Url,
            };
          }

          throw new HttpError(
            500,
            'agent_no_image',
            `Manyfold Agent ("${selectedAgent.name}") 未回傳圖片結果: Agent 回傳了文字敘述而未提供圖片 artifact (${snapshot.text || '無回應文字'})`
          );
        } finally {
          clearTimeout(timer);
        }
      } catch (err: unknown) {
        if (err instanceof HttpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error('Manyfold A2A Error:', message);
        if (!apiKey || settings.bgRemoveMode === 'agent_only') {
          throw new HttpError(500, 'agent_error', `Manyfold Agent ("${selectedAgent.name}") 處理失敗: ${message}`);
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
    '無可用的 AI 處理服務。請在 Cloudflare 設定 GEMINI_API_KEY，或在網站右上角點擊「Connect Manyfold Agent」授權您的 Agent！'
  );
}
