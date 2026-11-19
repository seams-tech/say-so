import { audioDigest, checkVerdict, type Digest, type VerdictCheck } from '@seams/voice-verdict';
import { MAX_SAMPLES, pcm16ToCanonicalWav, pcm16ToLeBytes, toBase64 } from './pcm.ts';
import type {
  EnrollWireOutput,
  RenderWireOutput,
  SaySoRequestInput,
  StreamClientMessage,
  StreamServerMessage,
  VerifyWireOutput,
} from './protocol.ts';

export interface SaySoClientConfig {
  /** Base HTTP(S) URL of the SaySo Cloudflare Worker, e.g. `https://sayso.example.workers.dev` or `http://localhost:8787`. */
  baseUrl: string;
  /** Pinned Ed25519 verifier public key (`ed25519:<base58>` or 64-char hex). */
  verifierPublicKey: string | Uint8Array;
  fetch?: typeof fetch;
  createWebSocket?: (url: string) => WebSocket;
}

export interface StreamVerifyOptions {
  owner: string;
  request: SaySoRequestInput;
  contacts?: string[];
  /** Locally computed request digest to verify against the signed verdict. */
  expectedRequestDigest?: Digest;
  acceptStepUp?: boolean;
  onReady?: (info: Extract<StreamServerMessage, { type: 'ready' }>) => void;
  onTranscript?: (update: Extract<StreamServerMessage, { type: 'transcript' }>) => void;
}

export interface StreamVerifySession {
  /** Push a live 16 kHz mono Int16 PCM frame to the Worker over WebSocket. */
  sendPcmFrame: (frame: Int16Array) => void;
  /**
   * Optional offline dev helper (honored ONLY when the Worker runs with `SAYSO_DEV_MOCK=true`,
   * ignored in production).
   */
  sendMockTranscript: (transcript: string, isFinal: boolean, speechFinal?: boolean) => void;
  /** Signal end of speech from client-side VAD if the server has not already early-closed. */
  finishSpeech: () => void;
  /** Close/abort the session. */
  abort: () => void;
  /** Resolves when the Worker returns a signed verdict and local Ed25519 + audioDigest check completes. */
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

  async render(owner: string, request: SaySoRequestInput, contacts: string[] = []): Promise<RenderWireOutput> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner, request, contacts }),
    });
    return (await res.json()) as RenderWireOutput;
  }

  async enroll(owner: string, wavClips: readonly [Uint8Array, Uint8Array, Uint8Array]): Promise<EnrollWireOutput> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        op: 'enroll',
        owner,
        audio_wav_b64: wavClips.map((clip) => toBase64(clip)),
      }),
    });
    return (await res.json()) as EnrollWireOutput;
  }

  async verifyBatch(params: {
    owner: string;
    request: SaySoRequestInput;
    wav: Uint8Array;
    contacts?: string[];
    expectedRequestDigest?: Digest;
    acceptStepUp?: boolean;
  }): Promise<{ wire: VerifyWireOutput; checked: VerdictCheck }> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        op: 'verify',
        owner: params.owner,
        request: params.request,
        contacts: params.contacts ?? [],
        audio_wav_b64: toBase64(params.wav),
      }),
    });
    const wire = (await res.json()) as VerifyWireOutput;
    const checked = await checkVerdict({
      verdictJson: wire.verdict_json,
      signatureB64: wire.signature_b64 ?? '',
      publicKey: this.verifierPublicKey,
      requestDigest: params.expectedRequestDigest,
      audioDigest: await audioDigest(params.wav),
      acceptStepUp: params.acceptStepUp,
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
          owner: options.owner,
          request: options.request,
          contacts: options.contacts ?? [],
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
            const checked = await checkVerdict({
              verdictJson: msg.output.verdict_json,
              signatureB64: msg.output.signature_b64 ?? '',
              publicKey: this.verifierPublicKey,
              requestDigest: options.expectedRequestDigest,
              audioDigest: expectedAudio,
              acceptStepUp: options.acceptStepUp,
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
