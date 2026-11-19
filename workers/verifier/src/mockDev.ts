/**
 * Opt-in offline development providers (`SAYSO_DEV_MOCK=true` in `.dev.vars`).
 *
 * Never enabled in production. Verdicts issued under this mode are tagged
 * `"verifier": "sayso/0.2.0+mock"` inside the signed `sayso_verdict_v1` JSON.
 */
import { fromBase64, toBase64 } from './crypto.ts';
import type { SpeakerClient } from './speaker.ts';
import type { SttProvider, SttTranscriptEvent } from './stt.ts';

export const MOCK_VERIFIER_VERSION = 'sayso/0.2.0+mock';

export function createMockSpectralSpeakerClient(): SpeakerClient {
  return {
    async embed(canonicalWavB64: string) {
      const started = Date.now();
      const wav = fromBase64(canonicalWavB64);
      if (wav.length <= 44) return null;
      const sampleCount = Math.floor((wav.length - 44) / 2);
      if (sampleCount < 160) return null;

      const view = new DataView(wav.buffer, wav.byteOffset + 44, sampleCount * 2);
      const samples = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i += 1) {
        samples[i] = view.getInt16(i * 2, true) / 32_768;
      }

      const features = new Float32Array(192);
      let energy = 0;
      for (let i = 0; i < sampleCount; i += 1) {
        energy += samples[i] * samples[i];
      }
      if (energy < 1e-6) return null;

      const step = Math.max(1, Math.floor(sampleCount / 4_000));
      for (let lag = 0; lag < 192; lag += 1) {
        const d = lag + 1;
        let corr = 0;
        let count = 0;
        for (let i = 0; i + d < sampleCount; i += step) {
          corr += samples[i] * samples[i + d];
          count += 1;
        }
        features[lag] = count > 0 ? corr / count : 0;
      }

      const buf = new ArrayBuffer(192 * 4);
      const outView = new DataView(buf);
      for (let i = 0; i < 192; i += 1) {
        outView.setFloat32(i * 4, features[i], true);
      }
      return {
        embeddingLeB64: toBase64(new Uint8Array(buf)),
        modelMs: Math.max(1, Date.now() - started),
      };
    },
  };
}

export function createMockSttProvider(): SttProvider {
  return {
    async openStream(onTranscript) {
      let latest = '';
      let closed = false;
      return {
        sendPcmChunk() {},
        injectMockTranscript(ev: SttTranscriptEvent) {
          if (closed) return;
          latest = ev.transcript;
          onTranscript(ev);
        },
        async finishAndFlush() {
          return latest || null;
        },
        close() {
          closed = true;
        },
      };
    },
    async transcribeBatch() {
      return null;
    },
  };
}
