import assert from 'node:assert/strict';
import test from 'node:test';
import { audioDigest, canonicalWav, pcm16ToCanonicalWav } from '@sayso/verdict';
import { float32ToPcm16 } from '../src/pcm.ts';

test('pcm16ToCanonicalWav matches @sayso/verdict canonicalWav byte-for-byte', async () => {
  const floatSamples = new Float32Array(16_000);
  for (let i = 0; i < floatSamples.length; i += 1) {
    floatSamples[i] = Math.sin(i * 0.05) * 0.25;
  }
  const pcm16 = float32ToPcm16(floatSamples);
  const built = pcm16ToCanonicalWav(pcm16, 12_800);
  const normalized = canonicalWav(built);
  assert.deepEqual(built, normalized);

  const digest = await audioDigest(built);
  assert.equal(digest.length, 32);
});
