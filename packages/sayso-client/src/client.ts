import {
  audioDigest,
  MAX_SAMPLES,
  pcm16ToCanonicalWav,
  verifyVerdict,
  type Digest,
  type SaySoIntentInput,
  type VerdictCheck,
} from '@sayso/verdict';
import { pcm16ToLeBytes, toBase64 } from './pcm.ts';
import type {
  EnrollWireOutput,
  RenderWireOutput,
  StreamClientMessage,
  StreamServerMessage,
  VerifyWireOutput,
} from './protocol.ts';

export interface SaySoClientConfig {
  /** Base HTTP(S) URL of the SaySo Cloudflare Worker, e.g. `https://sayso.example.workers.dev` or `http://localhost:8787`. */
  baseUrl: string;
  /** Pinned Ed25519 verifier public key (64 hex chars, 43-char base64url, or 32-byte Uint8Array). */
  verifierPublicKey: string | Uint8Array;
  fetch?: typeof fetch;
  createWebSocket?: (url: string) => WebSocket;
}

export interface StreamVerifyOptions {
  intent: SaySoIntentInput;
  /** Locally computed 32-byte `intentDigest` from `createIntent()` to check against the signed verdict. */
  expectedIntentDigest?: Digest;
  onReady?: (info: Extract<StreamServerMessage, { type: 'ready' }>) => void;
  onTranscript?: (update: Extract<StreamServerMessage, { type: 'transcript' }>) => void;
}

export interface StreamVerifySession {
  sendPcmFrame: (frame: Int16Array) => void;
  sendMockTranscript: (transcript: string, isFinal: boolean, speechFinal?: boolean) => void;
  finishSpeech: () => void;
  abort: () => void;
  result: Promise<{
    wire: VerifyWireOutput;
    checked: VerdictCheck;
    sampleCount: number;
    closedBy: 'token_match' | 'stt_speech_final' | 'client_end' | 'max_duration';
    canonicalWav: Uint8Array<ArrayBuffer>;
  }>;
}

export class SaySoClient {
  private readonly baseUrl: string;
  private readonly verifierPublicKey: string | Uint8Array;
  private readonly fetchImpl: typeof fetch;
  private readonly wsFactory: (url: string) => WebSocket;

  constructor(config: SaySoClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.verifierPublicKey = config.verifierPublicKey;
    this.fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
    this.wsFactory = config.createWebSocket ?? ((url) => new WebSocket(url));
  }

  async render(intent: SaySoIntentInput): Promise<RenderWireOutput> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent }),
    });
    return (await res.json()) as RenderWireOutput;
  }

  async enroll(userId: string, wavClips: readonly [Uint8Array, Uint8Array, Uint8Array]): Promise<EnrollWireOutput> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        audio_wav_b64: wavClips.map((clip) => toBase64(clip)),
      }),
    });
    return (await res.json()) as EnrollWireOutput;
  }

  async verifyBatch(params: {
    intent: SaySoIntentInput;
    wav: Uint8Array;
    expectedIntentDigest?: Digest;
  }): Promise<{ wire: VerifyWireOutput; checked: VerdictCheck }> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: params.intent,
        audio_wav_b64: toBase64(params.wav),
      }),
    });
    const wire = (await res.json()) as VerifyWireOutput;
    const checked = await verifyVerdict({
      verdictJson: wire.verdict_json,
      signatureB64: wire.signature_b64 ?? '',
      publicKey: this.verifierPublicKey,
      userId: params.intent.user_id,
      action: params.intent.action,
      intentDigest: params.expectedIntentDigest,
      audioDigest: await audioDigest(params.wav),
    });
    return { wire, checked };
  }

  streamVerify(options: StreamVerifyOptions): StreamVerifySession {
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/v1/stream`;
    const ws = this.wsFactory(wsUrl);
    ws.binaryType = 'arraybuffer';

    const recorded = new Int16Array(MAX_SAMPLES);
    let recordedSamples = 0;
    let readyOpen = false;
    let settled = false;
    const pendingFrames: Uint8Array<ArrayBuffer>[] = [];
    const pendingMessages: StreamClientMessage[] = [];
    let pendingEnd = false;

    const sendJson = (msg: StreamClientMessage) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    const result = new Promise<{
      wire: VerifyWireOutput;
      checked: VerdictCheck;
      sampleCount: number;
      closedBy: 'token_match' | 'stt_speech_final' | 'client_end' | 'max_duration';
      canonicalWav: Uint8Array<ArrayBuffer>;
    }>((resolve, reject) => {
      ws.addEventListener('open', () => {
        sendJson({
          type: 'init',
          intent: options.intent,
        });
      });

      ws.addEventListener('message', async (event) => {
        if (settled || typeof event.data !== 'string') return;
        let msg: StreamServerMessage;
        try {
          msg = JSON.parse(event.data) as StreamServerMessage;
        } catch {
          return;
        }
        if (msg.type === 'ready') {
          readyOpen = true;
          options.onReady?.(msg);
          for (const queued of pendingFrames.splice(0)) {
            if (ws.readyState === WebSocket.OPEN) ws.send(queued);
          }
          for (const queuedMsg of pendingMessages.splice(0)) {
            sendJson(queuedMsg);
          }
          if (pendingEnd) {
            sendJson({ type: 'end', clientSpeechEndedAtMs: Date.now() });
          }
          return;
        }
        if (msg.type === 'transcript') {
          options.onTranscript?.(msg);
          return;
        }
        if (msg.type === 'error') {
          settled = true;
          ws.close();
          reject(new Error(`SaySo stream error (${msg.reason}): ${msg.detail ?? ''}`));
          return;
        }
        if (msg.type === 'verdict') {
          settled = true;
          ws.close();
          try {
            const count = Math.min(msg.sampleCount, recordedSamples);
            const canonicalWav = count > 0 ? pcm16ToCanonicalWav(recorded, count) : new Uint8Array(0);
            const expectedAudio = count > 0 ? await audioDigest(canonicalWav) : undefined;
            const checked = await verifyVerdict({
              verdictJson: msg.output.verdict_json,
              signatureB64: msg.output.signature_b64 ?? '',
              publicKey: this.verifierPublicKey,
              userId: options.intent.user_id,
              action: options.intent.action,
              intentDigest: options.expectedIntentDigest,
              audioDigest: expectedAudio,
            });
            resolve({
              wire: msg.output,
              checked,
              sampleCount: count,
              closedBy: msg.closedBy,
              canonicalWav,
            });
          } catch (err) {
            reject(err);
          }
        }
      });

      ws.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          reject(new Error('SaySo WebSocket connection failed'));
        }
      });

      ws.addEventListener('close', () => {
        if (!settled) {
          settled = true;
          reject(new Error('SaySo WebSocket closed before verdict'));
        }
      });
    });

    return {
      sendPcmFrame(frame: Int16Array) {
        if (settled) return;
        const space = MAX_SAMPLES - recordedSamples;
        if (space <= 0) return;
        const slice = frame.length <= space ? frame : frame.subarray(0, space);
        recorded.set(slice, recordedSamples);
        recordedSamples += slice.length;
        const bytes = pcm16ToLeBytes(slice);
        if (readyOpen && ws.readyState === WebSocket.OPEN) {
          ws.send(bytes);
        } else {
          pendingFrames.push(bytes);
        }
      },
      sendMockTranscript(transcript: string, isFinal: boolean, speechFinal = false) {
        if (settled) return;
        const msg: StreamClientMessage = { type: 'mock_transcript', transcript, isFinal, speechFinal };
        if (readyOpen) {
          sendJson(msg);
        } else {
          pendingMessages.push(msg);
        }
      },
      finishSpeech() {
        if (settled) return;
        if (readyOpen) {
          sendJson({ type: 'end', clientSpeechEndedAtMs: Date.now() });
        } else {
          pendingEnd = true;
        }
      },
      abort() {
        if (settled) return;
        settled = true;
        ws.close();
      },
      result,
    };
  }
}
