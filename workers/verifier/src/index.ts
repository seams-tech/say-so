import type { SaySoIntentInput } from '@sayso/verdict';
import { AccountVoiceDO, createDurableObjectVoiceStore } from './accountVoiceDo.ts';
import { authorizeEnrollment, resolveCorsOrigin, type AuthEnv } from './auth.ts';
import { createVerdictSignerFromSeedHex, type VerdictSigner } from './crypto.ts';
import { SaySoEngine } from './engine.ts';
import {
  createMockSpectralSpeakerClient,
  createMockSttProvider,
  MOCK_VERIFIER_VERSION,
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

const MOCK_DEV_SEED_HEX = '11'.repeat(32);

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
  const configured = env.VERDICT_SECRET_KEY_HEX?.trim() || '';
  if (!configured && !isMockMode(env)) {
    return Promise.reject(new Error('VERDICT_SECRET_KEY_HEX is not configured'));
  }
  const keyHex = configured || MOCK_DEV_SEED_HEX;
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-SaySo-Enroll-Token',
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    if (origin !== '*') headers.Vary = 'Origin';
  }
  return headers;
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
      const engine = await buildEngine(env);
      const body = (await request.json()) as { intent: SaySoIntentInput };
      return jsonResponse(request, engine.render(body.intent), env);
    }

    if (request.method === 'POST' && url.pathname === '/v1/enroll') {
      const body = (await request.json()) as {
        user_id: string;
        audio_wav_b64: string[];
        enrollment_token?: string;
      };
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
      const body = (await request.json()) as {
        intent: SaySoIntentInput;
        audio_wav_b64: string;
        mock_transcript?: string;
      };
      if (body.intent?.user_id) {
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
      }

      const engine = await buildEngine(env);
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
