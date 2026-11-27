/**
 * Pure scale-to-zero Cloudflare Container (`SpeakerContainer`) + HTTP client
 * for ReDimNet B1 speaker embeddings.
 */
import { toHex, verifySpeakerServiceReply } from './crypto.ts';

export const REDIMNET_SHA256_HEX = 'e04dd7a6a1e23fc7b89e47682ea9d0a3946cf7bc59d07922c3db3efc52ae4269';

export interface SpeakerEmbedResult {
  embeddingLeB64: string;
  modelMs: number;
}

export interface SpeakerClient {
  embed(canonicalWavB64: string, expectedAudioDigestHex: string): Promise<SpeakerEmbedResult | null>;
}

interface ContainerPort {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface ContainerControl {
  running: boolean;
  start(opts?: { enableInternet?: boolean }): void;
  getTcpPort(port: number): ContainerPort;
}

/**
 * Pure scale-to-zero Cloudflare Container Durable Object wrapper around `speaker-service:8080`.
 * No keepalive cron is scheduled; the container sleeps automatically after idle (`sleepAfter`).
 */
export class SpeakerContainer {
  static readonly defaultPort = 8080;
  static readonly sleepAfter = '3m';
  static readonly startDeadlineMs = 8_000;

  private readonly ctx: DurableObjectState & { container?: ContainerControl };
  // One start for all requests: an enrollment sends its three recordings at the same time, and
  // `running` is true as soon as `start()` returns, before the service listens on its port.
  private ready: Promise<void> | null = null;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx as typeof this.ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;
    if (!container) {
      return Response.json({ error: 'container_binding_unavailable' }, { status: 503 });
    }
    const port = container.getTcpPort(SpeakerContainer.defaultPort);
    if (!container.running) this.ready = null;
    try {
      await (this.ready ??= this.start(container, port));
    } catch {
      this.ready = null;
      return Response.json({ error: 'container_not_ready' }, { status: 503 });
    }
    return port.fetch(request);
  }

  private async start(container: ContainerControl, port: ContainerPort): Promise<void> {
    if (!container.running) container.start({ enableInternet: false });
    const deadline = Date.now() + SpeakerContainer.startDeadlineMs;
    while (Date.now() < deadline) {
      try {
        const res = await port.fetch('http://container/healthz');
        if (res.ok) return;
      } catch {
        // The process is still loading redimnet-b1.onnx and binding port 8080.
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('speaker container did not listen in time');
  }
}

interface RawSpeakerReply {
  embedding_b64?: string;
  audio_digest?: string;
  model_sha256?: string;
  nonce?: string;
  public_key?: string;
  signature?: string;
  model_ms?: number;
}

export function createSpeakerClient(options: {
  containerNamespace?: DurableObjectNamespace;
  serviceUrl?: string;
  pinnedPublicKeyHex?: string;
  fetchImpl?: typeof fetch;
}): SpeakerClient {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));

  return {
    async embed(canonicalWavB64, expectedAudioDigestHex) {
      const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
      const nonceHex = toHex(nonceBytes);
      const body = JSON.stringify({
        audio_wav_b64: canonicalWavB64,
        nonce: nonceHex,
      });

      let res: Response;
      try {
        if (options.serviceUrl) {
          res = await fetchImpl(`${options.serviceUrl.replace(/\/+$/, '')}/v1/embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(10_000),
          });
        } else if (options.containerNamespace) {
          const stub = options.containerNamespace.get(options.containerNamespace.idFromName('scale-to-zero-0'));
          res = await stub.fetch('http://container/v1/embed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(10_000),
          });
        } else {
          return null;
        }
      } catch {
        return null;
      }

      if (!res.ok) return null;
      const reply = (await res.json()) as RawSpeakerReply;
      if (
        !reply.embedding_b64 ||
        !reply.audio_digest ||
        !reply.model_sha256 ||
        !reply.nonce ||
        !reply.public_key ||
        !reply.signature
      ) {
        return null;
      }

      const valid = await verifySpeakerServiceReply({
        embeddingB64: reply.embedding_b64,
        audioDigestHex: reply.audio_digest,
        nonceHex: reply.nonce,
        modelSha256Hex: reply.model_sha256,
        publicKeyHex: reply.public_key,
        signatureHex: reply.signature,
        expectedAudioDigestHex,
        expectedNonceHex: nonceHex,
        expectedModelSha256Hex: REDIMNET_SHA256_HEX,
        pinnedPublicKeyHex: options.pinnedPublicKeyHex,
      });
      if (!valid) return null;

      return {
        embeddingLeB64: reply.embedding_b64,
        modelMs: reply.model_ms ?? 0,
      };
    },
  };
}
