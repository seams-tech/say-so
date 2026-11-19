export const SAMPLE_RATE = 16_000;
export const MAX_SAMPLES = 8 * SAMPLE_RATE;

/**
 * Re-encodes any 16 kHz mono PCM16 WAV into the canonical 44-byte header WAV.
 */
export function canonicalWav(wav: Uint8Array): Uint8Array<ArrayBuffer> {
  const text = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
  if (wav.length < 12 || text(0) !== 'RIFF' || text(8) !== 'WAVE') throw new RangeError('not a WAV');
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let at = 12;
  let formatOk = false;
  while (at + 8 <= wav.length) {
    const id = text(at);
    const size = view.getUint32(at + 4, true);
    const start = at + 8;
    const end = start + size;
    if (id === 'data') {
      if (!formatOk) throw new RangeError('WAV has data before fmt chunk');
      const data = wav.subarray(start, Math.min(end, wav.length));
      const samples = Math.floor(data.length / 2);
      if (samples === 0 || samples > MAX_SAMPLES) throw new RangeError('WAV must have 1 sample to 8 s of audio');
      return wrapCanonicalWavBytes(data.subarray(0, samples * 2), samples);
    }
    if (end > wav.length) throw new RangeError('WAV has a truncated chunk');
    if (id === 'fmt ') {
      if (size < 16) throw new RangeError('WAV has a bad fmt chunk');
      const tag = view.getUint16(start, true);
      const pcm = tag === 1 || (tag === 0xfffe && size >= 26 && view.getUint16(start + 24, true) === 1);
      const mono16k = view.getUint16(start + 2, true) === 1 && view.getUint32(start + 4, true) === SAMPLE_RATE;
      if (!pcm || !mono16k || view.getUint16(start + 14, true) !== 16) {
        throw new RangeError('WAV must be 16 kHz mono PCM16');
      }
      formatOk = true;
    }
    at = end + (size & 1);
  }
  throw new RangeError('WAV has no data chunk');
}

/** Builds the canonical 44-byte 16 kHz mono PCM16 WAV from Int16 samples. */
export function pcm16ToCanonicalWav(samples: Int16Array, sampleCount = samples.length): Uint8Array<ArrayBuffer> {
  if (sampleCount <= 0 || sampleCount > samples.length || sampleCount > MAX_SAMPLES) {
    throw new RangeError(`sampleCount (${sampleCount}) must be between 1 and min(samples.length, ${MAX_SAMPLES})`);
  }
  const pcmBytes = new Uint8Array(sampleCount * 2);
  const view = new DataView(pcmBytes.buffer);
  for (let i = 0; i < sampleCount; i += 1) {
    view.setInt16(i * 2, samples[i], true);
  }
  return wrapCanonicalWavBytes(pcmBytes, sampleCount);
}

function wrapCanonicalWavBytes(pcmLeBytes: Uint8Array, sampleCount: number): Uint8Array<ArrayBuffer> {
  const dataLen = sampleCount * 2;
  const out = new Uint8Array(44 + dataLen);
  const header = new DataView(out.buffer);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) out[offset + i] = value.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  header.setUint32(4, 36 + dataLen, true);
  ascii(8, 'WAVEfmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, SAMPLE_RATE, true);
  header.setUint32(28, SAMPLE_RATE * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  ascii(36, 'data');
  header.setUint32(40, dataLen, true);
  out.set(pcmLeBytes, 44);
  return out;
}

/** Computes SHA-256 of the canonical WAV (matches `verdict.audio_digest`). */
export async function audioDigest(wav: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', canonicalWav(wav)));
}
