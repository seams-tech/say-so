import assert from 'node:assert/strict';
import test from 'node:test';
import {
  audioDigest,
  canonicalWav,
  createEnrollmentToken,
  createIntent,
  createVerifyToken,
  MemoryVerdictReplayGuard,
  pcm16ToCanonicalWav,
  verdictMessage,
  verifyEnrollmentToken,
  verifyVerdict,
  verifyVerifyToken,
} from '../src/index.ts';

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

test('createIntent, canonical WAV, WebCrypto Ed25519 verifyVerdict, and VerdictReplayGuard', async () => {
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

  const replayGuard = new MemoryVerdictReplayGuard(() => nowMs + 5_000);

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
    replayGuard,
  });
  assert.equal(ok.ok, true);

  // Submitting the exact same signed verdict twice fails with `verdict_replayed`.
  const replayed = await verifyVerdict({
    verdictJson,
    signatureB64,
    publicKey: pubKeyHex,
    nowMs: nowMs + 6_000,
    replayGuard,
  });
  assert.equal(replayed.ok, false);
  if (!replayed.ok) assert.equal(replayed.refusal.code, 'verdict_replayed');

  // Tampered payload digest fails with `intent_mismatch`.
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

  // Expired verdict fails with `expired`.
  const expired = await verifyVerdict({
    verdictJson,
    signatureB64,
    publicKey: pubKeyHex,
    nowMs: nowMs + 125_000,
  });
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.refusal.code, 'expired');
});

test('HMAC enrollment tokens bind userId and expiry cleanly', async () => {
  const secret = 'super-secret-enroll-key';
  const nowMs = 1_760_000_000_000;
  const token = await createEnrollmentToken({
    userId: 'alice@acme.com',
    secret,
    ttlMs: 60_000,
    nowMs,
  });

  const valid = await verifyEnrollmentToken({
    token,
    expectedUserId: 'alice@acme.com',
    secret,
    nowMs: nowMs + 10_000,
  });
  assert.equal(valid.ok, true);

  const wrongUser = await verifyEnrollmentToken({
    token,
    expectedUserId: 'bob@acme.com',
    secret,
    nowMs: nowMs + 10_000,
  });
  assert.deepEqual(wrongUser, { ok: false, code: 'user_mismatch' });

  const expired = await verifyEnrollmentToken({
    token,
    expectedUserId: 'alice@acme.com',
    secret,
    nowMs: nowMs + 65_000,
  });
  assert.deepEqual(expired, { ok: false, code: 'expired' });

  const wrongSecret = await verifyEnrollmentToken({
    token,
    expectedUserId: 'alice@acme.com',
    secret: 'wrong-secret',
    nowMs: nowMs + 10_000,
  });
  assert.deepEqual(wrongSecret, { ok: false, code: 'bad_signature' });
});

test('HMAC verify tokens bind userId, optional intentDigest, and stay domain-separated from enrollment tokens', async () => {
  const secret = 'shared-auth-secret';
  const nowMs = 1_760_000_000_000;
  const built = await createIntent({
    userId: 'alice@acme.com',
    action: 'stripe/payout',
    payload: '{"amount_usd":45}',
    sentence: 'Approve payout $45',
  });
  const other = await createIntent({
    userId: 'alice@acme.com',
    action: 'stripe/payout',
    payload: '{"amount_usd":999}',
    sentence: 'Approve payout $999',
  });

  const token = await createVerifyToken({
    userId: 'alice@acme.com',
    secret,
    intentDigest: built.intentDigest,
    ttlMs: 60_000,
    nowMs,
  });

  const valid = await verifyVerifyToken({
    token,
    secret,
    expectedUserId: 'alice@acme.com',
    expectedIntentDigest: built.intentDigest,
    nowMs: nowMs + 10_000,
  });
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.userId, 'alice@acme.com');
    assert.equal(valid.intentDigestB64u, toBase64Url(built.intentDigest));
  }

  // Wrong intent digest fails cleanly.
  const wrongIntent = await verifyVerifyToken({
    token,
    secret,
    expectedUserId: 'alice@acme.com',
    expectedIntentDigest: other.intentDigest,
    nowMs: nowMs + 10_000,
  });
  assert.deepEqual(wrongIntent, { ok: false, code: 'intent_mismatch' });

  // Wrong user fails cleanly.
  const wrongUser = await verifyVerifyToken({
    token,
    secret,
    expectedUserId: 'bob@acme.com',
    nowMs: nowMs + 10_000,
  });
  assert.deepEqual(wrongUser, { ok: false, code: 'user_mismatch' });

  // Expired fails cleanly.
  const expired = await verifyVerifyToken({
    token,
    secret,
    nowMs: nowMs + 61_000,
  });
  assert.deepEqual(expired, { ok: false, code: 'expired' });

  // Domain separation: verify token CANNOT pass verifyEnrollmentToken, and enrollment token CANNOT pass verifyVerifyToken.
  const crossEnroll = await verifyEnrollmentToken({
    token,
    expectedUserId: 'alice@acme.com',
    secret,
    nowMs: nowMs + 10_000,
  });
  assert.deepEqual(crossEnroll, { ok: false, code: 'bad_signature' });

  const enrollToken = await createEnrollmentToken({
    userId: 'alice@acme.com',
    secret,
    ttlMs: 60_000,
    nowMs,
  });
  const crossVerify = await verifyVerifyToken({
    token: enrollToken,
    expectedUserId: 'alice@acme.com',
    secret,
    nowMs: nowMs + 10_000,
  });
  assert.deepEqual(crossVerify, { ok: false, code: 'bad_signature' });
});

test('guarded words extend the intent digest, and an intent with none keeps its digest', async () => {
  const transfer = {
    userId: 'near:testnet:alice.testnet',
    action: 'seams.near.transfer',
    payloadSha256: '42'.repeat(32),
    sentence: 'send ten near to bob dot testnet',
  };
  const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

  // `crates/sayso-wasm/src/intent.rs` pins the same two values for `intent_digest`.
  const plain = await createIntent(transfer);
  assert.equal(toHex(plain.intentDigest), '51bc8d22b29c0220a5cfb1a90c3ebebea5757c7f8293c0062beef13cb5968e86');
  assert.equal('guarded_word_indexes' in plain.intent, false);
  assert.deepEqual(await createIntent({ ...transfer, guardedWordIndexes: [] }), plain);

  // The amount ("ten near") and the recipient ("bob dot testnet").
  const guarded = await createIntent({ ...transfer, guardedWordIndexes: [1, 2, 4, 5, 6] });
  assert.equal(toHex(guarded.intentDigest), 'a63e63c8e79f1e78101657310a9b5eedf1672fd5f55cf677db2be5accf86a583');
  assert.deepEqual(guarded.intent.guarded_word_indexes, [1, 2, 4, 5, 6]);
  assert.deepEqual(guarded.spokenTextDigest, plain.spokenTextDigest);

  for (const bad of [[7], [2, 1], [1, 1], [-1], [1.5], [Number.NaN]]) {
    await assert.rejects(createIntent({ ...transfer, guardedWordIndexes: bad }), RangeError, JSON.stringify(bad));
  }
});
