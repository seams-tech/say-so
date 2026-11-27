import type { SaySoIntentInput } from '@seams/sayso-verdict';
import { AccountVoiceDO, createDurableObjectVoiceStore } from './accountVoiceDo.ts';
import { authorizeEnrollment, authorizeVerify, resolveCorsOrigin, type AuthEnv } from './auth.ts';
import { createVerdictSignerFromSeedHex, type VerdictSigner } from './crypto.ts';
import { SaySoEngine } from './engine.ts';
import {
  createMockSpectralSpeakerClient,
  createMockSttProvider,
  MOCK_VERIFIER_VERSION,
  verdictSeedHex,
} from './mockDev.ts';
import { createSpeakerClient, SpeakerContainer } from './speaker.ts';
import { createWorkersAiSttProvider } from './stt.ts';
import { SaySoCore } from './wasm.ts';
// @ts-expect-error -- bundled `.wasm` module import in Cloudflare Workers
import wasmModule from './wasm/sayso_wasm.wasm';

export { AccountVoiceDO, SpeakerContainer };

export interface Env extends AuthEnv {
  AI?: {
    run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  };
  ACCOUNT_VOICE: DurableObjectNamespace;
  SPEAKER_CONTAINER?: DurableObjectNamespace;
  /** Optional external speaker-service URL (e.g. local `cargo run` on `http://127.0.0.1:8080`). */
  SPEAKER_SERVICE_URL?: string;
  /** Optional pinned Ed25519 speaker-service public key (64 hex chars). */
  SPEAKER_PINNED_KEY_HEX?: string;
  /** Required in production: 32-byte Ed25519 signing seed as 64 hex chars. */
  VERDICT_SECRET_KEY_HEX?: string;
}

const MAX_RENDER_BODY_BYTES = 16 * 1024;
const MAX_VERIFY_BODY_BYTES = 512 * 1024;
const MAX_ENROLL_BODY_BYTES = 1_600 * 1024;

let cachedWasm: SaySoCore | null = null;
let cachedSignerKeyHex: string | null = null;
let cachedSignerPromise: Promise<VerdictSigner> | null = null;

function isMockMode(env: Env): boolean {
  return env.SAYSO_DEV_MOCK?.trim().toLowerCase() === 'true';
}

function getWarmWasm(): SaySoCore {
  cachedWasm ??= SaySoCore.fromModuleSync(wasmModule as WebAssembly.Module);
  return cachedWasm;
}

function getWarmSigner(env: Env): Promise<VerdictSigner> {
  let keyHex: string;
  try {
    keyHex = verdictSeedHex({ configured: env.VERDICT_SECRET_KEY_HEX ?? '', mock: isMockMode(env) });
  } catch (error) {
    return Promise.reject(error);
  }
  if (cachedSignerPromise && cachedSignerKeyHex === keyHex) {
    return cachedSignerPromise;
  }
  cachedSignerKeyHex = keyHex;
  cachedSignerPromise = createVerdictSignerFromSeedHex(keyHex);
  return cachedSignerPromise;
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = resolveCorsOrigin(request, env.SAYSO_ALLOWED_ORIGIN);
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-SaySo-Enroll-Token, X-SaySo-Verify-Token',
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    if (origin !== '*') headers.Vary = 'Origin';
  }
  return headers;
}

async function readJsonBody<T>(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; data: T } | { ok: false; status: 400 | 413; error: string }> {
  const declaredLen = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    return { ok: false, status: 413, error: 'payload_too_large' };
  }
  let buf: ArrayBuffer;
  try {
    buf = await request.arrayBuffer();
  } catch {
    return { ok: false, status: 400, error: 'invalid_body' };
  }
  if (buf.byteLength > maxBytes) {
    return { ok: false, status: 413, error: 'payload_too_large' };
  }
  try {
    const text = new TextDecoder().decode(buf);
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' };
  }
}

function jsonResponse(
  request: Request,
  body: unknown,
  env: Env,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request, env),
      ...extraHeaders,
    },
  });
}

async function buildEngine(env: Env): Promise<SaySoEngine> {
  const wasm = getWarmWasm();
  const signer = await getWarmSigner(env);
  const mock = isMockMode(env);

  const speaker = mock
    ? createMockSpectralSpeakerClient()
    : createSpeakerClient({
        containerNamespace: env.SPEAKER_CONTAINER,
        serviceUrl: env.SPEAKER_SERVICE_URL,
        pinnedPublicKeyHex: env.SPEAKER_PINNED_KEY_HEX,
      });

  const stt = mock
    ? createMockSttProvider()
    : env.AI
      ? createWorkersAiSttProvider(env.AI)
      : {
          async openStream() {
            throw new Error('Workers AI binding unavailable');
          },
          async transcribeBatch() {
            return null;
          },
        };

  return new SaySoEngine({
    wasm,
    signer,
    voiceStore: createDurableObjectVoiceStore(env.ACCOUNT_VOICE),
    speaker,
    stt,
    mockMode: mock,
    verifierVersion: mock ? MOCK_VERIFIER_VERSION : 'sayso/0.2.0',
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);
    const mock = isMockMode(env);

    // Fail closed if production deployment is missing VERDICT_SECRET_KEY_HEX.
    let signer: VerdictSigner;
    try {
      signer = await getWarmSigner(env);
    } catch (err) {
      return jsonResponse(
        request,
        { error: 'server_misconfigured', detail: err instanceof Error ? err.message : 'missing signing key' },
        env,
        503,
      );
    }

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return jsonResponse(
        request,
        {
          ok: true,
          verifier: mock ? MOCK_VERIFIER_VERSION : 'sayso/0.2.0',
          mock,
          public_key_hex: signer.publicKeyHex,
        },
        env,
      );
    }

    if (request.method === 'GET' && url.pathname === '/v1/public-key') {
      return jsonResponse(request, { public_key_hex: signer.publicKeyHex, mock }, env);
    }

    const voiceStore = createDurableObjectVoiceStore(env.ACCOUNT_VOICE);

    if (url.pathname === '/v1/stream') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return jsonResponse(request, { error: 'Expected WebSocket Upgrade' }, env, 426);
      }

      // Gate WebSocket upgrade BEFORE opening WebSocketPair, Deepgram Nova-3, or SpeakerContainer.
      const auth = await authorizeVerify({
        request,
        queryToken: url.searchParams.get('token') ?? undefined,
        env,
      });
      if (!auth.ok) {
        return jsonResponse(request, { error: auth.reason }, env, auth.status);
      }

      const rateKey = auth.userId ?? (auth.method === 'dev_mock' ? '__dev_mock__' : '__api_key__');
      const rl = await voiceStore.checkRateLimit?.(rateKey, 'stream', 30, 60_000, Date.now());
      if (rl && !rl.allowed) {
        return jsonResponse(
          request,
          { error: 'rate_limited', retry_after_sec: rl.retryAfterSec },
          env,
          429,
          { 'Retry-After': String(rl.retryAfterSec) },
        );
      }

      const engine = await buildEngine(env);
      const pair = new WebSocketPair();
      const [clientWs, serverWs] = Object.values(pair);
      serverWs.accept();

      const session = engine.attachStreamSession(
        (msg) => {
          if (serverWs.readyState === WebSocket.OPEN) {
            serverWs.send(JSON.stringify(msg));
          }
        },
        () => {
          try {
            serverWs.close(1000, 'done');
          } catch {
            // Ignore already-closed WebSocket.
          }
        },
        {
          authorizedUserId: auth.userId,
          authorizedIntentDigestB64u: auth.intentDigestB64u,
        },
      );

      serverWs.addEventListener('message', (event) => {
        if (typeof event.data === 'string') {
          void session.onTextMessage(event.data);
        } else if (event.data instanceof ArrayBuffer) {
          session.onBinaryChunk(new Uint8Array(event.data));
        }
      });
      serverWs.addEventListener('close', () => session.onDisconnect());
      serverWs.addEventListener('error', () => session.onDisconnect());

      return new Response(null, { status: 101, webSocket: clientWs });
    }

    if (request.method === 'POST' && url.pathname === '/v1/render') {
      const parsed = await readJsonBody<{ intent: SaySoIntentInput }>(request, MAX_RENDER_BODY_BYTES);
      if (!parsed.ok) {
        return jsonResponse(request, { error: parsed.error }, env, parsed.status);
      }
      const engine = await buildEngine(env);
      return jsonResponse(request, engine.render(parsed.data.intent), env);
    }

    if (request.method === 'POST' && url.pathname === '/v1/enroll') {
      const parsed = await readJsonBody<{
        user_id: string;
        audio_wav_b64: string[];
        enrollment_token?: string;
      }>(request, MAX_ENROLL_BODY_BYTES);
      if (!parsed.ok) {
        return jsonResponse(request, { error: parsed.error }, env, parsed.status);
      }
      const body = parsed.data;
      if (!body.user_id || typeof body.user_id !== 'string') {
        return jsonResponse(request, { error: 'invalid_user_id' }, env, 400);
      }

      const auth = await authorizeEnrollment({
        request,
        userId: body.user_id,
        bodyToken: body.enrollment_token,
        env,
      });
      if (!auth.ok) {
        return jsonResponse(request, { error: auth.reason }, env, auth.status);
      }

      const rl = await voiceStore.checkRateLimit?.(body.user_id, 'enroll', 10, 10 * 60_000, Date.now());
      if (rl && !rl.allowed) {
        return jsonResponse(
          request,
          { error: 'rate_limited', retry_after_sec: rl.retryAfterSec },
          env,
          429,
          { 'Retry-After': String(rl.retryAfterSec) },
        );
      }

      const engine = await buildEngine(env);
      return jsonResponse(request, await engine.enroll(body.user_id, body.audio_wav_b64 ?? []), env);
    }

    if (request.method === 'POST' && url.pathname === '/v1/verify') {
      const parsed = await readJsonBody<{
        intent: SaySoIntentInput;
        audio_wav_b64: string;
        verify_token?: string;
        mock_transcript?: string;
      }>(request, MAX_VERIFY_BODY_BYTES);
      if (!parsed.ok) {
        return jsonResponse(request, { error: parsed.error }, env, parsed.status);
      }
      const body = parsed.data;
      if (!body.intent?.user_id || typeof body.intent.user_id !== 'string') {
        return jsonResponse(request, { error: 'invalid_intent' }, env, 400);
      }

      // Gate BEFORE AccountVoiceDO, Workers AI Whisper, or SpeakerContainer.
      const auth = await authorizeVerify({
        request,
        expectedUserId: body.intent.user_id,
        bodyToken: body.verify_token,
        env,
      });
      if (!auth.ok) {
        return jsonResponse(request, { error: auth.reason }, env, auth.status);
      }

      const engine = await buildEngine(env);
      if (auth.intentDigestB64u) {
        const rendered = engine.render(body.intent);
        if (!rendered.ok || rendered.intent_digest_b64u !== auth.intentDigestB64u) {
          return jsonResponse(request, { error: 'verify_token_intent_mismatch' }, env, 401);
        }
      }

      const rl = await voiceStore.checkRateLimit?.(body.intent.user_id, 'verify', 30, 60_000, Date.now());
      if (rl && !rl.allowed) {
        return jsonResponse(
          request,
          { error: 'rate_limited', retry_after_sec: rl.retryAfterSec },
          env,
          429,
          { 'Retry-After': String(rl.retryAfterSec) },
        );
      }

      return jsonResponse(
        request,
        await engine.verifyBatch({
          intent: body.intent,
          audioWavB64: body.audio_wav_b64,
          mockTranscript: body.mock_transcript,
        }),
        env,
      );
    }

    return jsonResponse(request, { error: 'Not Found' }, env, 404);
  },
};
