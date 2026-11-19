export const SAMPLE_RATE = 16_000;
export const MAX_SAMPLES = 8 * SAMPLE_RATE;

/** Converts Float32 [-1, 1] mono audio samples into clamped Int16 PCM samples. */
export function float32ToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? Math.round(s * 32_768) : Math.round(s * 32_767);
  }
  return out;
}

/** Encodes Int16 samples into little-endian bytes for WebSocket binary frames. */
export function pcm16ToLeBytes(samples: Int16Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(i * 2, samples[i], true);
  }
  return out;
}

/**
 * Builds the exact 44-byte canonical 16 kHz mono PCM16 WAV over `samples[0..sampleCount]`,
 * matching `sayso_wasm::audio::wav_bytes` byte-for-byte so `audioDigest` verifies locally.
 */
export function pcm16ToCanonicalWav(samples: Int16Array, sampleCount = samples.length): Uint8Array<ArrayBuffer> {
  if (sampleCount <= 0 || sampleCount > samples.length || sampleCount > MAX_SAMPLES) {
    throw new RangeError(`sampleCount (${sampleCount}) must be between 1 and min(samples.length, ${MAX_SAMPLES})`);
  }
  const dataBytes = sampleCount * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < sampleCount; i += 1) {
    view.setInt16(44 + i * 2, samples[i], true);
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
