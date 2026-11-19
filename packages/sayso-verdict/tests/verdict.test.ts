import assert from 'node:assert/strict';
import test from 'node:test';
import { audioDigest, canonicalWav, createIntent, pcm16ToCanonicalWav, verdictMessage, verifyVerdict } from '../src/index.ts';

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

test('createIntent, canonical WAV, and WebCrypto Ed25519 verifyVerdict round-trip', async () => {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pubKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const pubKeyHex = Buffer.from(pubKeyRaw).toString('hex');

  const built = await createIntent({
    userId: 'alice@acme.com',
    action: 'stripe/payout',
    payload: '{"recipient":"acct_9182","amount_usd":45}',
    sentence: 'Approve payout $45',
  });
  assert.equal(built.canonicalSentence, 'approve payout forty five dollars');
  assert.deepEqual(built.expectedTokens, ['approve', 'payout', 'forty', 'five', 'dollars']);

  const pcm = new Int16Array(16_000);
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = Math.round(Math.sin(i * 0.08) * 6_000);
  const wav = pcm16ToCanonicalWav(pcm);
  assert.deepEqual(canonicalWav(wav), wav);
  const aDigest = await audioDigest(wav);

  const nowMs = 1_760_000_000_000;
  const verdictJson = JSON.stringify({
    kind: 'sayso_verdict_v1',
    verifier: 'sayso/0.2.0',
    user_id: built.intent.user_id,
    action: built.intent.action,
    intent_digest: toBase64Url(built.intentDigest),
    spoken_text_digest: toBase64Url(built.spokenTextDigest),
    audio_digest: toBase64Url(aDigest),
    outcome: 'accept',
    reason: null,
    expires_at_ms: nowMs + 120_000,
    speaker_score_milli: 880,
    heard: null,
  });

  const msg = await verdictMessage(verdictJson);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, keyPair.privateKey, msg));
  const signatureB64 = toBase64(sig);

  const ok = await verifyVerdict({
    verdictJson,
    signatureB64,
    publicKey: pubKeyHex,
    userId: 'alice@acme.com',
    action: 'stripe/payout',
    intentDigest: built.intentDigest,
    spokenTextDigest: built.spokenTextDigest,
    audioDigest: aDigest,
    nowMs: nowMs + 5_000,
  });
  assert.equal(ok.ok, true);

  // Tampered payload digest fails with intent_mismatch.
  const otherIntent = await createIntent({
    userId: 'alice@acme.com',
    action: 'stripe/payout',
    payload: '{"recipient":"attacker","amount_usd":45}',
    sentence: 'Approve payout $45',
  });
  const mismatch = await verifyVerdict({
    verdictJson,
    signatureB64,
    publicKey: pubKeyRaw,
    intentDigest: otherIntent.intentDigest,
    nowMs: nowMs + 5_000,
  });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.refusal.code, 'intent_mismatch');

  // Expired verdict fails with expired.
  const expired = await verifyVerdict({
    verdictJson,
    signatureB64,
    publicKey: pubKeyHex,
    nowMs: nowMs + 125_000,
  });
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.refusal.code, 'expired');
});
