import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { pcm16ToLeBytes, toBase64, type StreamServerMessage } from '@sayso/client';
import {
  audioDigest,
  createEnrollmentToken,
  createIntent,
  createVerifyToken,
  pcm16ToCanonicalWav,
  verifyVerdict,
} from '@sayso/verdict';
import type { StoredVoiceTemplate, VoiceStore } from '../src/accountVoiceDo.ts';
import { authorizeEnrollment, authorizeVerify, resolveCorsOrigin } from '../src/auth.ts';
import { createVerdictSignerFromSeedHex } from '../src/crypto.ts';
import { SaySoEngine } from '../src/engine.ts';
import {
  createMockSpectralSpeakerClient,
  createMockSttProvider,
  MOCK_VERIFIER_VERSION,
} from '../src/mockDev.ts';
import type { SpeakerClient } from '../src/speaker.ts';
import type { SttProvider, SttTranscriptEvent } from '../src/stt.ts';
import { SaySoCore } from '../src/wasm.ts';

const here = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(resolve(here, '../src/wasm/sayso_wasm.wasm'));

function makeAxisEmbeddingB64(axis: number, angle = 0): string {
  const buf = new ArrayBuffer(192 * 4);
  const view = new DataView(buf);
  for (let i = 0; i < 192; i += 1) view.setFloat32(i * 4, 0, true);
  view.setFloat32(axis * 4, Math.cos(angle), true);
  view.setFloat32(((axis + 1) % 192) * 4, Math.sin(angle), true);
  return toBase64(new Uint8Array(buf));
}

function makeToneSamples(ms: number, freqStep = 0.09): Int16Array {
  const count = Math.floor((ms * 16_000) / 1_000);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = Math.round(Math.sin(i * freqStep) * 7_500);
  }
  return out;
}

function createInMemoryVoiceStore(): VoiceStore {
  const templates = new Map<string, StoredVoiceTemplate>();
  const usedAudio = new Map<string, Set<string>>();

  return {
    async getTemplate(userId) {
      return templates.get(userId) ?? null;
    },
    async saveTemplate(userId, epoch, templateSvt1B64) {
      templates.set(userId, { epoch, templateSvt1B64 });
    },
    async consumeAudioAndGetTemplate(userId, audioDigestB64u) {
      let set = usedAudio.get(userId);
      if (!set) {
        set = new Set();
        usedAudio.set(userId, set);
      }
      const audioReused = set.has(audioDigestB64u);
      set.add(audioDigestB64u);
      return { audioReused, template: templates.get(userId) ?? null };
    },
  };
}

test('SaySo streaming early-close, trailing negation guard, replay guard, and @sayso/verdict check', async () => {
  const wasm = await SaySoCore.fromBytes(wasmBytes);
  const signer = await createVerdictSignerFromSeedHex('22'.repeat(32));
  const voiceStore = createInMemoryVoiceStore();

  let currentAxis = 0;
  let emitTranscript: ((ev: SttTranscriptEvent) => void) | null = null;
  let batchText = '';

  const speaker: SpeakerClient = {
    async embed() {
      return { embeddingLeB64: makeAxisEmbeddingB64(currentAxis, 0.04), modelMs: 12 };
    },
  };

  const stt: SttProvider = {
    async openStream(onTranscript) {
      emitTranscript = onTranscript;
      return {
        sendPcmChunk() {},
        async finishAndFlush() {
          return null;
        },
        close() {},
      };
    },
    async transcribeBatch() {
      return batchText;
    },
  };

  const engine = new SaySoEngine({
    wasm,
    signer,
    voiceStore,
    speaker,
    stt,
    earlyCloseGuardMs: 40,
  });

  // 1. Enroll `alice@acme.com`
  const clip1 = pcm16ToCanonicalWav(makeToneSamples(900, 0.08));
  const clip2 = pcm16ToCanonicalWav(makeToneSamples(950, 0.09));
  const clip3 = pcm16ToCanonicalWav(makeToneSamples(1_000, 0.1));
  const enrolled = await engine.enroll('alice@acme.com', [toBase64(clip1), toBase64(clip2), toBase64(clip3)]);
  assert.equal(enrolled.outcome, 'accept');
  assert.equal(enrolled.template_epoch, 1);

  // 2. Stream live PCM + token-matched early-close!
  const built = await createIntent({
    userId: 'alice@acme.com',
    action: 'stripe/payout',
    payload: '{"amount":45,"currency":"USD"}',
    sentence: 'Approve payout $45',
  });

  let closed = false;
  const donePromise = new Promise<Extract<StreamServerMessage, { type: 'verdict' }>>((resolve) => {
    const session = engine.attachStreamSession(
      (msg) => {
        if (msg.type === 'verdict') resolve(msg);
      },
      () => {
        closed = true;
      },
    );

    void (async () => {
      await session.onTextMessage(JSON.stringify({ type: 'init', intent: built.intent }));
      const fullSamples = makeToneSamples(1_000, 0.11);
      for (let offset = 0; offset < fullSamples.length; offset += 800) {
        session.onBinaryChunk(pcm16ToLeBytes(fullSamples.subarray(offset, offset + 800)));
      }
      // mock_transcript must be strictly ignored when mockMode is false:
      await session.onTextMessage(
        JSON.stringify({ type: 'mock_transcript', transcript: 'wrong words', isFinal: true, speechFinal: true }),
      );
      emitTranscript!({ transcript: 'Approve payout', isFinal: false, speechFinal: false });
      emitTranscript!({ transcript: 'Approve payout $45.', isFinal: true, speechFinal: false });
    })();
  });

  const verdictMsg = await donePromise;
  assert.equal(closed, true);
  assert.equal(verdictMsg.closedBy, 'token_match');
  assert.equal(verdictMsg.sampleCount, 16_000);

  const clientWav = pcm16ToCanonicalWav(makeToneSamples(1_000, 0.11), verdictMsg.sampleCount);
  const checked = await verifyVerdict({
    verdictJson: verdictMsg.output.verdict_json,
    signatureB64: verdictMsg.output.signature_b64!,
    publicKey: signer.publicKeyHex,
    userId: 'alice@acme.com',
    action: 'stripe/payout',
    intentDigest: built.intentDigest,
    spokenTextDigest: built.spokenTextDigest,
    audioDigest: await audioDigest(clientWav),
  });
  assert.equal(checked.ok, true);
  if (checked.ok) {
    assert.equal(checked.verdict.outcome, 'accept');
    assert.equal(checked.verdict.verifier, 'sayso/0.2.0');
  }

  // 3. Replaying the exact same audio refuses with `audio_reused`!
  batchText = 'Approve payout $45.';
  const replayed = await engine.verifyBatch({
    intent: built.intent,
    audioWavB64: toBase64(clientWav),
  });
  const checkedReplay = await verifyVerdict({
    verdictJson: replayed.verdict_json,
    signatureB64: replayed.signature_b64!,
    publicKey: signer.publicKeyHex,
  });
  assert.equal(checkedReplay.ok, false);
  if (!checkedReplay.ok && checkedReplay.refusal.code === 'refused') {
    assert.equal(checkedReplay.refusal.reason, 'audio_reused');
  }

  // 4. Trailing negation within the guard window cancels early-close and refuses with `words`!
  const negationPromise = new Promise<Extract<StreamServerMessage, { type: 'verdict' }>>((resolve) => {
    const session = engine.attachStreamSession(
      (msg) => {
        if (msg.type === 'verdict') resolve(msg);
      },
      () => {},
    );
    void (async () => {
      await session.onTextMessage(JSON.stringify({ type: 'init', intent: built.intent }));
      const samples = makeToneSamples(1_100, 0.13);
      session.onBinaryChunk(pcm16ToLeBytes(samples));
      emitTranscript!({ transcript: 'Approve payout 45 dollars', isFinal: false, speechFinal: false });
      await new Promise((r) => setTimeout(r, 10));
      emitTranscript!({ transcript: 'Approve payout 45 dollars not', isFinal: true, speechFinal: true });
    })();
  });

  const negatedMsg = await negationPromise;
  assert.equal(negatedMsg.closedBy, 'stt_speech_final');
  const checkedNegated = await verifyVerdict({
    verdictJson: negatedMsg.output.verdict_json,
    signatureB64: negatedMsg.output.signature_b64!,
    publicKey: signer.publicKeyHex,
  });
  assert.equal(checkedNegated.ok, false);
  if (!checkedNegated.ok && checkedNegated.refusal.code === 'refused') {
    assert.equal(checkedNegated.refusal.reason, 'words');
    assert.equal(checkedNegated.refusal.verdict.heard, 'approve payout forty five dollars not');
  }

  // 5. Wrong speaker voice is refused with `speaker`!
  currentAxis = 10;
  const imposter = await engine.verifyBatch({
    intent: built.intent,
    audioWavB64: toBase64(pcm16ToCanonicalWav(makeToneSamples(950, 0.17))),
  });
  const checkedImposter = await verifyVerdict({
    verdictJson: imposter.verdict_json,
    signatureB64: imposter.signature_b64!,
    publicKey: signer.publicKeyHex,
  });
  assert.equal(checkedImposter.ok, false);
  if (!checkedImposter.ok && checkedImposter.refusal.code === 'refused') {
    assert.equal(checkedImposter.refusal.reason, 'speaker');
  }
});

test('Opt-in SAYSO_DEV_MOCK=true offline mode enrolls spectral voiceprint and signs sayso/0.2.0+mock verdicts', async () => {
  const wasm = await SaySoCore.fromBytes(wasmBytes);
  const signer = await createVerdictSignerFromSeedHex('33'.repeat(32));
  const voiceStore = createInMemoryVoiceStore();

  const mockEngine = new SaySoEngine({
    wasm,
    signer,
    voiceStore,
    speaker: createMockSpectralSpeakerClient(),
    stt: createMockSttProvider(),
    mockMode: true,
    verifierVersion: MOCK_VERIFIER_VERSION,
    earlyCloseGuardMs: 30,
  });

  const enrolled = await mockEngine.enroll('usr_offline', [
    toBase64(pcm16ToCanonicalWav(makeToneSamples(850, 0.12))),
    toBase64(pcm16ToCanonicalWav(makeToneSamples(900, 0.121))),
    toBase64(pcm16ToCanonicalWav(makeToneSamples(950, 0.119))),
  ]);
  assert.equal(enrolled.outcome, 'accept');

  const built = await createIntent({
    userId: 'usr_offline',
    action: 'github/deploy',
    payload: '{"release":"2.4"}',
    sentence: 'Deploy release 2.4 to production',
  });

  const mockResult = await new Promise<Extract<StreamServerMessage, { type: 'verdict' }>>((resolve) => {
    const session = mockEngine.attachStreamSession(
      (msg) => {
        if (msg.type === 'verdict') resolve(msg);
      },
      () => {},
    );
    void (async () => {
      await session.onTextMessage(JSON.stringify({ type: 'init', intent: built.intent }));
      const livePcm = makeToneSamples(920, 0.12);
      session.onBinaryChunk(pcm16ToLeBytes(livePcm));
      await session.onTextMessage(
        JSON.stringify({
          type: 'mock_transcript',
          transcript: 'Deploy release two point four to production.',
          isFinal: true,
          speechFinal: false,
        }),
      );
    })();
  });

  assert.equal(mockResult.closedBy, 'token_match');
  const checked = await verifyVerdict({
    verdictJson: mockResult.output.verdict_json,
    signatureB64: mockResult.output.signature_b64!,
    publicKey: signer.publicKeyHex,
    intentDigest: built.intentDigest,
  });
  assert.equal(checked.ok, true);
  if (checked.ok) {
    assert.equal(checked.verdict.verifier, 'sayso/0.2.0+mock');
  }
});

test('Enrollment auth fails closed in production and accepts Bearer API key or HMAC token', async () => {
  const req = new Request('https://sayso.example/v1/enroll', { method: 'POST' });

  // Production with no secrets configured -> 503 fail-closed.
  const unconfigured = await authorizeEnrollment({
    request: req,
    userId: 'alice@acme.com',
    env: {},
  });
  assert.deepEqual(unconfigured, { ok: false, status: 503, reason: 'enrollment_auth_not_configured' });

  // Mock mode with no secrets -> allowed for offline local dev.
  const devMock = await authorizeEnrollment({
    request: req,
    userId: 'alice@acme.com',
    env: { SAYSO_DEV_MOCK: 'true' },
  });
  assert.deepEqual(devMock, { ok: true, method: 'dev_mock' });

  // Server-to-server Bearer API key.
  const bearerReq = new Request('https://sayso.example/v1/enroll', {
    method: 'POST',
    headers: { Authorization: 'Bearer sk_live_123' },
  });
  const bearerOk = await authorizeEnrollment({
    request: bearerReq,
    userId: 'alice@acme.com',
    env: { SAYSO_API_KEY: 'sk_live_123' },
  });
  assert.deepEqual(bearerOk, { ok: true, method: 'api_key' });

  // Short-lived HMAC enrollment token bound to userId.
  const nowMs = 1_760_000_000_000;
  const token = await createEnrollmentToken({
    userId: 'alice@acme.com',
    secret: 'enroll-hmac-secret',
    ttlMs: 60_000,
    nowMs,
  });
  const tokenReq = new Request('https://sayso.example/v1/enroll', {
    method: 'POST',
    headers: { 'X-SaySo-Enroll-Token': token },
  });
  const tokenOk = await authorizeEnrollment({
    request: tokenReq,
    userId: 'alice@acme.com',
    env: { SAYSO_ENROLL_SECRET: 'enroll-hmac-secret' },
    nowMs: nowMs + 5_000,
  });
  assert.deepEqual(tokenOk, { ok: true, method: 'enroll_token' });

  const wrongUser = await authorizeEnrollment({
    request: tokenReq,
    userId: 'bob@acme.com',
    env: { SAYSO_ENROLL_SECRET: 'enroll-hmac-secret' },
    nowMs: nowMs + 5_000,
  });
  assert.deepEqual(wrongUser, { ok: false, status: 401, reason: 'enroll_token_user_mismatch' });

  // Strict comma-separated CORS allowlist.
  const corsReq = new Request('https://sayso.example/v1/verify', {
    headers: { Origin: 'https://app.example.com' },
  });
  assert.equal(
    resolveCorsOrigin(corsReq, 'https://app.example.com, http://localhost:5179'),
    'https://app.example.com',
  );
  assert.equal(resolveCorsOrigin(corsReq, 'https://other.example.com'), null);
});

test('Verify/stream auth fails closed, accepts verify tokens via header or ?token=, and blocks mismatched stream init before opening STT', async () => {
  const req = new Request('https://sayso.example/v1/stream', { method: 'GET' });

  // 1. Production with no secrets configured -> 503 fail-closed.
  assert.deepEqual(await authorizeVerify({ request: req, env: {} }), {
    ok: false,
    status: 503,
    reason: 'verify_auth_not_configured',
  });

  // 2. Opt-in SAYSO_DEV_MOCK=true -> allowed offline.
  assert.deepEqual(await authorizeVerify({ request: req, env: { SAYSO_DEV_MOCK: 'true' } }), {
    ok: true,
    method: 'dev_mock',
  });

  // 3. Missing token when secret is configured -> 401.
  assert.deepEqual(await authorizeVerify({ request: req, env: { SAYSO_ENROLL_SECRET: 'shared-secret' } }), {
    ok: false,
    status: 401,
    reason: 'unauthorized_verify',
  });

  // 4. Valid verify token via ?token= (browser WS upgrade) using fallback SAYSO_ENROLL_SECRET.
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
    payload: '{"amount_usd":500}',
    sentence: 'Approve payout $500',
  });

  const token = await createVerifyToken({
    userId: 'alice@acme.com',
    secret: 'shared-secret',
    intentDigest: built.intentDigest,
    ttlMs: 60_000,
    nowMs,
  });

  const wsAuth = await authorizeVerify({
    request: req,
    queryToken: token,
    env: { SAYSO_ENROLL_SECRET: 'shared-secret' },
    nowMs: nowMs + 5_000,
  });
  assert.equal(wsAuth.ok, true);
  if (wsAuth.ok) {
    assert.equal(wsAuth.method, 'verify_token');
    assert.equal(wsAuth.userId, 'alice@acme.com');
    assert.ok(wsAuth.intentDigestB64u);
  }

  // 5. Enrollment token cannot authorize /v1/verify or /v1/stream even with same secret.
  const enrollToken = await createEnrollmentToken({
    userId: 'alice@acme.com',
    secret: 'shared-secret',
    ttlMs: 60_000,
    nowMs,
  });
  assert.deepEqual(
    await authorizeVerify({
      request: req,
      queryToken: enrollToken,
      env: { SAYSO_ENROLL_SECRET: 'shared-secret' },
      nowMs: nowMs + 5_000,
    }),
    { ok: false, status: 401, reason: 'verify_token_bad_signature' },
  );

  // 6. attachStreamSession enforces authorizedUserId and authorizedIntentDigestB64u BEFORE opening STT!
  const wasm = await SaySoCore.fromBytes(wasmBytes);
  const signer = await createVerdictSignerFromSeedHex('44'.repeat(32));
  let sttOpenedCount = 0;
  const engine = new SaySoEngine({
    wasm,
    signer,
    voiceStore: createInMemoryVoiceStore(),
    speaker: {
      async embed() {
        return null;
      },
    },
    stt: {
      async openStream() {
        sttOpenedCount += 1;
        return {
          sendPcmChunk() {},
          async finishAndFlush() {
            return null;
          },
          close() {},
        };
      },
      async transcribeBatch() {
        return null;
      },
    },
  });

  const errors: Array<Extract<StreamServerMessage, { type: 'error' }>> = [];
  let closedCount = 0;

  // Wrong user_id on init -> rejected before stt.openStream()
  const wrongUserSession = engine.attachStreamSession(
    (msg) => {
      if (msg.type === 'error') errors.push(msg);
    },
    () => {
      closedCount += 1;
    },
    { authorizedUserId: 'alice@acme.com' },
  );
  await wrongUserSession.onTextMessage(
    JSON.stringify({
      type: 'init',
      intent: { ...built.intent, user_id: 'bob@acme.com' },
    }),
  );
  assert.equal(sttOpenedCount, 0);
  assert.equal(closedCount, 1);
  assert.equal(errors[0]?.reason, 'unauthorized_user');

  // Wrong intent digest on init -> rejected before stt.openStream()
  const wrongIntentSession = engine.attachStreamSession(
    (msg) => {
      if (msg.type === 'error') errors.push(msg);
    },
    () => {
      closedCount += 1;
    },
    {
      authorizedUserId: 'alice@acme.com',
      authorizedIntentDigestB64u: wsAuth.ok ? wsAuth.intentDigestB64u : undefined,
    },
  );
  await wrongIntentSession.onTextMessage(
    JSON.stringify({
      type: 'init',
      intent: other.intent,
    }),
  );
  assert.equal(sttOpenedCount, 0);
  assert.equal(closedCount, 2);
  assert.equal(errors[1]?.reason, 'unauthorized_intent');
});
