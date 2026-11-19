import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { pcm16ToCanonicalWav, pcm16ToLeBytes, toBase64, type StreamServerMessage } from '@seams/sayso-client';
import { audioDigest, checkVerdict, confirmationRequest } from '@seams/voice-verdict';
import type { StoredVoiceTemplate, VoiceStore } from '../src/accountVoiceDo.ts';
import { createVerdictSignerFromSeedHex } from '../src/crypto.ts';
import { SaySoEngine } from '../src/engine.ts';
import {
  createMockSpectralSpeakerClient,
  createMockSttProvider,
  MOCK_VERIFIER_VERSION,
} from '../src/mockDev.ts';
import { MULTISIG_MAX_TRIES, type MultisigStore, type StoredMultisigOpening } from '../src/multisigProposalDo.ts';
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

function createInMemoryStores(): { voiceStore: VoiceStore; multisigStore: MultisigStore } {
  const templates = new Map<string, StoredVoiceTemplate>();
  const usedAudio = new Map<string, Set<string>>();
  const openings = new Map<string, StoredMultisigOpening>();
  const tries = new Map<string, number>();
  const signers = new Map<string, Map<string, string>>();

  return {
    voiceStore: {
      async getTemplate(owner) {
        return templates.get(owner) ?? null;
      },
      async saveTemplate(owner, epoch, templateSvt1B64) {
        templates.set(owner, { epoch, templateSvt1B64 });
      },
      async consumeAudioAndGetTemplate(owner, audioDigestB64u) {
        let set = usedAudio.get(owner);
        if (!set) {
          set = new Set();
          usedAudio.set(owner, set);
        }
        const audioReused = set.has(audioDigestB64u);
        set.add(audioDigestB64u);
        return { audioReused, template: templates.get(owner) ?? null };
      },
    },
    multisigStore: {
      async saveProposal(multisig, commitmentHex, opening, proposer, proposerTemplateSvt1B64) {
        const key = `${multisig}:${commitmentHex}`;
        openings.set(key, opening);
        const map = new Map<string, string>();
        map.set(proposer, proposerTemplateSvt1B64);
        signers.set(key, map);
      },
      async prepareConfirm(multisig, commitmentHex, member) {
        const key = `${multisig}:${commitmentHex}`;
        const opening = openings.get(key) ?? null;
        const count = tries.get(`${key}:${member}`) ?? 0;
        const map = signers.get(key);
        const otherSignerTemplatesB64: string[] = [];
        if (map) {
          for (const [m, svt1] of map.entries()) {
            if (m !== member) otherSignerTemplatesB64.push(svt1);
          }
        }
        return { opening, attemptsExhausted: count >= MULTISIG_MAX_TRIES, otherSignerTemplatesB64 };
      },
      async recordConfirmOutcome(multisig, commitmentHex, member, outcome, memberTemplateSvt1B64) {
        const key = `${multisig}:${commitmentHex}`;
        if (outcome === 'words_refusal') {
          tries.set(`${key}:${member}`, (tries.get(`${key}:${member}`) ?? 0) + 1);
        } else {
          let map = signers.get(key);
          if (!map) {
            map = new Map();
            signers.set(key, map);
          }
          map.set(member, memberTemplateSvt1B64);
        }
      },
    },
  };
}

test('SaySo streaming early-close, trailing negation guard, replay guard, and multisig same_speaker', async () => {
  const wasm = await SaySoCore.fromBytes(wasmBytes);
  const signer = await createVerdictSignerFromSeedHex('22'.repeat(32));
  const { voiceStore, multisigStore } = createInMemoryStores();

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
    multisigStore,
    speaker,
    stt,
    earlyCloseGuardMs: 40,
  });

  // 1. Enroll `app:alice`
  const clip1 = pcm16ToCanonicalWav(makeToneSamples(900, 0.08));
  const clip2 = pcm16ToCanonicalWav(makeToneSamples(950, 0.09));
  const clip3 = pcm16ToCanonicalWav(makeToneSamples(1_000, 0.1));
  const enrolled = await engine.enroll('app:alice', [toBase64(clip1), toBase64(clip2), toBase64(clip3)]);
  assert.equal(enrolled.outcome, 'accept');
  assert.equal(enrolled.template_epoch, 1);

  // 2. Stream live PCM + token-matched early-close!
  const conf = await confirmationRequest({
    owner: 'app:alice',
    context: 'stripe/payout',
    payload: new TextEncoder().encode('{"amount":45,"currency":"USD"}'),
    summary: 'approve payout forty five dollars',
  });

  const messages: StreamServerMessage[] = [];
  let closed = false;
  const donePromise = new Promise<Extract<StreamServerMessage, { type: 'verdict' }>>((resolve) => {
    const session = engine.attachStreamSession(
      (msg) => {
        messages.push(msg);
        if (msg.type === 'verdict') resolve(msg);
      },
      () => {
        closed = true;
      },
    );

    void (async () => {
      await session.onTextMessage(JSON.stringify({ type: 'init', owner: conf.owner, request: conf.request }));
      const fullSamples = makeToneSamples(1_000, 0.11);
      for (let offset = 0; offset < fullSamples.length; offset += 800) {
        session.onBinaryChunk(pcm16ToLeBytes(fullSamples.subarray(offset, offset + 800)));
      }
      // Verify mock_transcript is strictly ignored when mockMode is false:
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
  const checked = await checkVerdict({
    verdictJson: verdictMsg.output.verdict_json,
    signatureB64: verdictMsg.output.signature_b64!,
    publicKey: signer.publicKeyNear,
    requestDigest: conf.digest,
    audioDigest: await audioDigest(clientWav),
  });
  assert.equal(checked.ok, true);
  if (checked.ok) {
    assert.equal(checked.verdict.outcome, 'accept');
    assert.equal(checked.verdict.verifier, 'sayso/0.1.0');
  }

  // 3. Replaying the exact same audio over batch HTTP refuses with `audio_reused`!
  batchText = 'Approve payout $45.';
  const replayed = await engine.verifyBatch({
    owner: conf.owner,
    request: conf.request,
    audioWavB64: toBase64(clientWav),
  });
  const checkedReplay = await checkVerdict({
    verdictJson: replayed.verdict_json,
    signatureB64: replayed.signature_b64!,
    publicKey: signer.publicKeyNear,
  });
  assert.equal(checkedReplay.ok, false);
  if (!checkedReplay.ok && checkedReplay.refusal.code === 'refused') {
    assert.equal(checkedReplay.refusal.reason, 'audio_reused');
  }

  // 4. Trailing negation within the 40 ms guard window cancels early-close and refuses with `words`!
  const negationPromise = new Promise<Extract<StreamServerMessage, { type: 'verdict' }>>((resolve) => {
    const session = engine.attachStreamSession(
      (msg) => {
        if (msg.type === 'verdict') resolve(msg);
      },
      () => {},
    );
    void (async () => {
      await session.onTextMessage(JSON.stringify({ type: 'init', owner: conf.owner, request: conf.request }));
      const samples = makeToneSamples(1_100, 0.13);
      session.onBinaryChunk(pcm16ToLeBytes(samples));
      emitTranscript!({ transcript: 'Approve payout 45 dollars', isFinal: false, speechFinal: false });
      await new Promise((r) => setTimeout(r, 10));
      emitTranscript!({ transcript: 'Approve payout 45 dollars not', isFinal: true, speechFinal: true });
    })();
  });

  const negatedMsg = await negationPromise;
  assert.equal(negatedMsg.closedBy, 'stt_speech_final');
  const checkedNegated = await checkVerdict({
    verdictJson: negatedMsg.output.verdict_json,
    signatureB64: negatedMsg.output.signature_b64!,
    publicKey: signer.publicKeyNear,
  });
  assert.equal(checkedNegated.ok, false);
  if (!checkedNegated.ok && checkedNegated.refusal.code === 'refused') {
    assert.equal(checkedNegated.refusal.reason, 'words');
    assert.equal(checkedNegated.refusal.verdict.heard, 'approve payout forty five dollars not');
  }

  // 5. Multisig `same_speaker` defense: signer 2 enrolled with same voice as signer 1 is refused!
  currentAxis = 5;
  await engine.enroll('s1.testnet', [
    toBase64(pcm16ToCanonicalWav(makeToneSamples(900, 0.14))),
    toBase64(pcm16ToCanonicalWav(makeToneSamples(920, 0.15))),
    toBase64(pcm16ToCanonicalWav(makeToneSamples(940, 0.16))),
  ]);
  await engine.enroll('s2.testnet', [
    toBase64(pcm16ToCanonicalWav(makeToneSamples(900, 0.17))),
    toBase64(pcm16ToCanonicalWav(makeToneSamples(920, 0.18))),
    toBase64(pcm16ToCanonicalWav(makeToneSamples(940, 0.19))),
  ]);

  const proposeReq = {
    kind: 'multisig_propose' as const,
    multisig: 'ms.testnet',
    proposal_id: 1,
    receiver: 'bob.testnet',
    amount_yocto: '2000000000000000000000000',
  };
  const renderedPropose = engine.render('s1.testnet', proposeReq);
  batchText = renderedPropose.sentence!;
  const proposed = await engine.verifyBatch({
    owner: 's1.testnet',
    request: proposeReq,
    audioWavB64: toBase64(pcm16ToCanonicalWav(makeToneSamples(950, 0.21))),
  });
  assert.ok(proposed.multisig?.commitment);
  const commitmentHex = Buffer.from(proposed.multisig.commitment, 'base64url').toString('hex');

  const sameVoiceConfirm = await engine.verifyBatch({
    owner: 's2.testnet',
    request: {
      kind: 'multisig_confirm',
      multisig: 'ms.testnet',
      proposal_id: 1,
      commitment_hex: commitmentHex,
    },
    audioWavB64: toBase64(pcm16ToCanonicalWav(makeToneSamples(950, 0.22))),
  });
  const checkedSameSpeaker = await checkVerdict({
    verdictJson: sameVoiceConfirm.verdict_json,
    signatureB64: sameVoiceConfirm.signature_b64!,
    publicKey: signer.publicKeyNear,
  });
  assert.equal(checkedSameSpeaker.ok, false);
  if (!checkedSameSpeaker.ok && checkedSameSpeaker.refusal.code === 'refused') {
    assert.equal(checkedSameSpeaker.refusal.reason, 'same_speaker');
  }
});

test('Opt-in SAYSO_DEV_MOCK=true offline mode enrolls spectral voiceprint and signs sayso/0.1.0+mock verdicts', async () => {
  const wasm = await SaySoCore.fromBytes(wasmBytes);
  const signer = await createVerdictSignerFromSeedHex('33'.repeat(32));
  const { voiceStore, multisigStore } = createInMemoryStores();

  const mockEngine = new SaySoEngine({
    wasm,
    signer,
    voiceStore,
    multisigStore,
    speaker: createMockSpectralSpeakerClient(),
    stt: createMockSttProvider(),
    mockMode: true,
    verifierVersion: MOCK_VERIFIER_VERSION,
    earlyCloseGuardMs: 30,
  });

  // Enroll with 3 consistent offline tone clips (same spectral signature)
  const enrolled = await mockEngine.enroll('app:offline-dev', [
    toBase64(pcm16ToCanonicalWav(makeToneSamples(850, 0.12))),
    toBase64(pcm16ToCanonicalWav(makeToneSamples(900, 0.121))),
    toBase64(pcm16ToCanonicalWav(makeToneSamples(950, 0.119))),
  ]);
  assert.equal(enrolled.outcome, 'accept');

  const conf = await confirmationRequest({
    owner: 'app:offline-dev',
    context: 'github/deploy',
    payload: new TextEncoder().encode('{"release":"2.4"}'),
    summary: 'deploy release two four to production',
  });

  const mockResult = await new Promise<Extract<StreamServerMessage, { type: 'verdict' }>>((resolve) => {
    const session = mockEngine.attachStreamSession(
      (msg) => {
        if (msg.type === 'verdict') resolve(msg);
      },
      () => {},
    );
    void (async () => {
      await session.onTextMessage(JSON.stringify({ type: 'init', owner: conf.owner, request: conf.request }));
      const livePcm = makeToneSamples(920, 0.12);
      session.onBinaryChunk(pcm16ToLeBytes(livePcm));
      await session.onTextMessage(
        JSON.stringify({
          type: 'mock_transcript',
          transcript: 'Deploy release 2 4 to production.',
          isFinal: true,
          speechFinal: false,
        }),
      );
    })();
  });

  assert.equal(mockResult.closedBy, 'token_match');
  const checked = await checkVerdict({
    verdictJson: mockResult.output.verdict_json,
    signatureB64: mockResult.output.signature_b64!,
    publicKey: signer.publicKeyNear,
    requestDigest: conf.digest,
  });
  assert.equal(checked.ok, true);
  if (checked.ok) {
    assert.equal(checked.verdict.verifier, 'sayso/0.1.0+mock');
  }
});
