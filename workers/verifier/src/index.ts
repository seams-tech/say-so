import type { SaySoIntentInput } from '@sayso/verdict';
import { AccountVoiceDO, createDurableObjectVoiceStore } from './accountVoiceDo.ts';
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

export interface Env {
  AI?: {
    run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  };
  ACCOUNT_VOICE: DurableObjectNamespace;
  SPEAKER_CONTAINER?: DurableObjectNamespace;
  /** Optional external speaker-service URL (e.g. local `cargo run` on `http://127.0.0.1:8080`). */
  SPEAKER_SERVICE_URL?: string;
  /** Optional pinned Ed25519 speaker-service public key (64 hex chars). */
  SPEAKER_PINNED_KEY_HEX?: string;
  /** 32-byte Ed25519 signing seed as 64 hex chars (`wrangler secret put VERDICT_SECRET_KEY_HEX`). */
  VERDICT_SECRET_KEY_HEX?: string;
  /** Opt-in offline local UI testing mode (`"true"` in `.dev.vars` only). Never set in production. */
  SAYSO_DEV_MOCK?: string;
  SAYSO_ALLOWED_ORIGIN?: string;
}

const DEFAULT_DEV_SEED_HEX = '11'.repeat(32);

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
  const keyHex = env.VERDICT_SECRET_KEY_HEX?.trim() || DEFAULT_DEV_SEED_HEX;
  if (cachedSignerPromise && cachedSignerKeyHex === keyHex) {
    return cachedSignerPromise;
  }
  cachedSignerKeyHex = keyHex;
  cachedSignerPromise = createVerdictSignerFromSeedHex(keyHex);
  return cachedSignerPromise;
}

function corsHeaders(env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.SAYSO_ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(body: unknown, env: Env, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(env),
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
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    const url = new URL(request.url);
    const mock = isMockMode(env);

    if (request.method === 'GET' && url.pathname === '/healthz') {
      const signer = await getWarmSigner(env);
      return jsonResponse(
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
      const signer = await getWarmSigner(env);
      return jsonResponse({ public_key_hex: signer.publicKeyHex, mock }, env);
    }

    if (url.pathname === '/v1/stream') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return jsonResponse({ error: 'Expected WebSocket Upgrade' }, env, 426);
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
      return jsonResponse(engine.render(body.intent), env);
    }

    if (request.method === 'POST' && url.pathname === '/v1/enroll') {
      const engine = await buildEngine(env);
      const body = (await request.json()) as {
        user_id: string;
        audio_wav_b64: string[];
      };
      return jsonResponse(await engine.enroll(body.user_id, body.audio_wav_b64 ?? []), env);
    }

    if (request.method === 'POST' && url.pathname === '/v1/verify') {
      const engine = await buildEngine(env);
      const body = (await request.json()) as {
        intent: SaySoIntentInput;
        audio_wav_b64: string;
        mock_transcript?: string;
      };
      return jsonResponse(
        await engine.verifyBatch({
          intent: body.intent,
          audioWavB64: body.audio_wav_b64,
          mockTranscript: body.mock_transcript,
        }),
        env,
      );
    }

    return jsonResponse({ error: 'Not Found' }, env, 404);
  },
};
