import type {
  EnrollWireOutput,
  RenderWireOutput,
  SaySoRequestInput,
  StreamClientMessage,
  StreamServerMessage,
  VerifyWireOutput,
} from '@seams/sayso-client';
import type { VoiceStore } from './accountVoiceDo.ts';
import { toBase64, toHex, type VerdictSigner } from './crypto.ts';
import type { MultisigStore, StoredMultisigOpening } from './multisigProposalDo.ts';
import type { SpeakerClient } from './speaker.ts';
import type { SttLiveStream, SttProvider } from './stt.ts';
import type { SaySoCore } from './wasm.ts';

const MAX_PCM_BYTES = 8 * 16_000 * 2; // 8.0 s of 16 kHz PCM16 LE
const MIN_EARLY_CLOSE_SAMPLES = 10_240; // >= 640 ms before early-closing on token match

export interface EngineDeps {
  wasm: SaySoCore;
  signer: VerdictSigner;
  voiceStore: VoiceStore;
  multisigStore: MultisigStore;
  speaker: SpeakerClient;
  stt: SttProvider;
  /** True only when `SAYSO_DEV_MOCK=true` is explicitly opted in for local offline UI testing. */
  mockMode?: boolean;
  /** Written into `Verdict.verifier` (`"sayso/0.1.0"` or `"sayso/0.1.0+mock"`). */
  verifierVersion?: string;
  /** Trailing window after expected tokens match to catch negations like "... not". Default: 200 ms. */
  earlyCloseGuardMs?: number;
  now?: () => number;
}

interface WasmAudioResult {
  ok: boolean;
  canonical_wav_b64?: string;
  audio_digest_b64u?: string;
  audio_digest_hex?: string;
  sample_count?: number;
  voiced_ms?: number;
  gate_passes?: boolean;
  reason?: string;
  detail?: string;
}

interface WasmVerdictReady {
  ok: boolean;
  outcome: 'accept' | 'step_up' | 'refuse';
  reason: string | null;
  verdict_json: string;
  verdict_message_b64: string;
  expires_at_ms: number;
  policy_text: string | null;
  multisig: { commitment: string; salt: string } | null;
}

export class SaySoEngine {
  private readonly deps: EngineDeps;
  private readonly mockMode: boolean;
  private readonly verifierVersion: string;
  private readonly earlyCloseGuardMs: number;
  private readonly now: () => number;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.mockMode = Boolean(deps.mockMode);
    this.verifierVersion = deps.verifierVersion ?? (this.mockMode ? 'sayso/0.1.0+mock' : 'sayso/0.1.0');
    this.earlyCloseGuardMs = deps.earlyCloseGuardMs ?? 200;
    this.now = deps.now ?? (() => Date.now());
  }

  render(owner: string, request: SaySoRequestInput, contacts: string[] = []): RenderWireOutput {
    const saltHex =
      request.kind === 'multisig_propose' || request.kind === 'multisig_hide_note'
        ? '00'.repeat(32)
        : undefined;
    return this.deps.wasm.call<RenderWireOutput>({
      cmd: 'prepare',
      owner,
      request,
      contacts,
      salt_hex: saltHex,
    });
  }

  async enroll(owner: string, wavB64List: string[]): Promise<EnrollWireOutput> {
    const started = this.now();
    const ms: Record<string, number> = {};
    if (wavB64List.length !== 3) {
      return this.refuseEnroll('unsupported', ms, started);
    }

    const decoded = wavB64List.map((wav_b64) =>
      this.deps.wasm.call<WasmAudioResult>({ cmd: 'audio_from_wav', wav_b64 }),
    );
    for (const clip of decoded) {
      if (!clip.ok || !clip.canonical_wav_b64 || !clip.audio_digest_hex) {
        return this.refuseEnroll('audio_invalid', ms, started);
      }
      if (!clip.gate_passes) {
        return this.refuseEnroll('quality', ms, started);
      }
    }
    ms.decode = this.now() - started;

    const speakerStart = this.now();
    const [embeddings, existing] = await Promise.all([
      Promise.all(
        decoded.map((clip) => this.deps.speaker.embed(clip.canonical_wav_b64!, clip.audio_digest_hex!)),
      ),
      this.deps.voiceStore.getTemplate(owner),
    ]);
    ms.speaker = this.now() - speakerStart;

    if (embeddings.some((e) => e === null)) {
      return this.refuseEnroll('speaker_unavailable', ms, started);
    }

    const evalRes = this.deps.wasm.call<{
      ok: boolean;
      reason?: string;
      template_epoch?: number;
      agreement_milli?: number;
      template_svt1_b64?: string;
    }>({
      cmd: 'evaluate_enroll',
      embeddings_le_b64: embeddings.map((e) => e!.embeddingLeB64),
      previous_epoch: existing?.epoch ?? 0,
    });

    if (!evalRes.ok || !evalRes.template_svt1_b64 || evalRes.template_epoch === undefined) {
      return {
        kind: 'seams_voice_enrollment_v3',
        outcome: 'refuse',
        reason: evalRes.reason ?? 'speaker',
        template_epoch: null,
        agreement_milli: evalRes.agreement_milli ?? null,
        verifier_public_key: this.deps.signer.publicKeyNear,
        ms: { ...ms, total: this.now() - started },
      };
    }

    const doStart = this.now();
    await this.deps.voiceStore.saveTemplate(owner, evalRes.template_epoch, evalRes.template_svt1_b64);
    ms.storage = this.now() - doStart;
    ms.total = this.now() - started;

    return {
      kind: 'seams_voice_enrollment_v3',
      outcome: 'accept',
      reason: null,
      template_epoch: evalRes.template_epoch,
      agreement_milli: evalRes.agreement_milli ?? null,
      verifier_public_key: this.deps.signer.publicKeyNear,
      ms,
    };
  }

  async verifyBatch(params: {
    owner: string;
    request: SaySoRequestInput;
    contacts?: string[];
    audioWavB64: string;
    mockTranscript?: string;
  }): Promise<VerifyWireOutput> {
    const started = this.now();
    const ms: Record<string, number> = {};
    const contacts = params.contacts ?? [];

    const audio = this.deps.wasm.call<WasmAudioResult>({
      cmd: 'audio_from_wav',
      wav_b64: params.audioWavB64,
    });
    ms.decode = this.now() - started;

    if (!audio.ok || !audio.canonical_wav_b64 || !audio.audio_digest_b64u || !audio.audio_digest_hex) {
      return this.signRefusal('audio_invalid', ms, started);
    }

    return this.executeVerifyCore({
      owner: params.owner,
      request: params.request,
      contacts,
      audio,
      transcriptOverride: this.mockMode ? params.mockTranscript : undefined,
      ms,
      started,
    });
  }

  /**
   * Attaches a stateful streaming SaySo session (`init` -> binary PCM16 frames -> live `transcript`
   * -> `200 ms` token-matched early close -> overlapped Speaker + DO + Ed25519 `verdict`).
   */
  attachStreamSession(send: (msg: StreamServerMessage) => void, closeSocket: () => void): {
    onTextMessage: (raw: string) => Promise<void>;
    onBinaryChunk: (bytes: Uint8Array) => void;
    onDisconnect: () => void;
  } {
    const pcmBuffer = new Uint8Array(MAX_PCM_BYTES);
    let pcmBytes = 0;
    let initialized = false;
    let committed = false;
    let earlyCloseTimer: ReturnType<typeof setTimeout> | null = null;
    let sttStream: SttLiveStream | null = null;
    let latestTranscript = '';

    let owner = '';
    let request!: SaySoRequestInput;
    let contacts: string[] = [];
    let saltHex: string | undefined;
    let storedOpening: StoredMultisigOpening | null = null;
    let otherSignerTemplatesB64: string[] = [];

    const clearEarlyTimer = () => {
      if (earlyCloseTimer !== null) {
        clearTimeout(earlyCloseTimer);
        earlyCloseTimer = null;
      }
    };

    const commit = async (
      closedBy: 'token_match' | 'stt_speech_final' | 'client_end' | 'max_duration',
    ) => {
      if (committed || !initialized) return;
      committed = true;
      clearEarlyTimer();

      const commitStarted = this.now();
      const ms: Record<string, number> = {};
      const sampleCount = Math.floor(pcmBytes / 2);
      if (sampleCount === 0) {
        const out = await this.signRefusal('audio_invalid', ms, commitStarted);
        send({ type: 'verdict', sampleCount: 0, closedBy, output: out });
        sttStream?.close();
        closeSocket();
        return;
      }

      const pcmSlice = pcmBuffer.subarray(0, sampleCount * 2);
      const audio = this.deps.wasm.call<WasmAudioResult>({
        cmd: 'audio_from_pcm',
        pcm_b64: toBase64(pcmSlice),
      });
      ms.decode = this.now() - commitStarted;

      if (!audio.ok || !audio.canonical_wav_b64 || !audio.audio_digest_b64u || !audio.audio_digest_hex) {
        const out = await this.signRefusal('audio_invalid', ms, commitStarted);
        send({ type: 'verdict', sampleCount, closedBy, output: out });
        sttStream?.close();
        closeSocket();
        return;
      }

      const parallelStart = this.now();
      const [flushedTranscript, consumed, speakerReply, summaryOk] = await Promise.all([
        sttStream ? sttStream.finishAndFlush() : Promise.resolve(latestTranscript || null),
        this.deps.voiceStore.consumeAudioAndGetTemplate(owner, audio.audio_digest_b64u, commitStarted),
        audio.gate_passes
          ? this.deps.speaker.embed(audio.canonical_wav_b64, audio.audio_digest_hex)
          : Promise.resolve(null),
        request.kind === 'community_note' && this.deps.stt.checkNoteSummary
          ? this.deps.stt.checkNoteSummary(request.note_text, request.summary)
          : Promise.resolve(true),
      ]);
      sttStream?.close();
      ms.critical_parallel = this.now() - parallelStart;
      if (speakerReply) ms.redimnet = speakerReply.modelMs;

      const finalTranscript = flushedTranscript ?? (latestTranscript || null);
      const output = await this.finalizeAndSign({
        owner,
        request,
        contacts,
        audio,
        consumed,
        speakerEmbeddingB64: speakerReply?.embeddingLeB64 ?? null,
        otherSignerTemplatesB64,
        transcript: finalTranscript,
        summaryPasses: summaryOk,
        saltHex,
        storedOpening,
        ms,
        started: commitStarted,
      });

      send({
        type: 'verdict',
        sampleCount,
        closedBy,
        output,
      });
      closeSocket();
    };

    return {
      onTextMessage: async (raw: string) => {
        if (committed) return;
        let msg: StreamClientMessage;
        try {
          msg = JSON.parse(raw) as StreamClientMessage;
        } catch {
          send({ type: 'error', reason: 'bad_json' });
          closeSocket();
          return;
        }

        if (msg.type === 'end') {
          await commit('client_end');
          return;
        }

        if (msg.type === 'mock_transcript') {
          // Strictly ignored unless Worker runs with opt-in `SAYSO_DEV_MOCK=true`.
          if (this.mockMode && initialized && sttStream?.injectMockTranscript) {
            sttStream.injectMockTranscript({
              transcript: msg.transcript,
              isFinal: msg.isFinal,
              speechFinal: msg.speechFinal,
            });
          }
          return;
        }

        if (msg.type === 'init') {
          if (initialized) return;
          owner = msg.owner;
          request = msg.request;
          contacts = msg.contacts ?? [];

          if (request.kind === 'multisig_propose' || request.kind === 'multisig_hide_note') {
            saltHex = toHex(crypto.getRandomValues(new Uint8Array(32)));
          } else if (request.kind === 'multisig_confirm') {
            const confirmPrep = await this.deps.multisigStore.prepareConfirm(
              request.multisig,
              request.commitment_hex,
              owner,
            );
            if (!confirmPrep.opening) {
              committed = true;
              const out = await this.signRefusal('proposal_missing', {}, this.now());
              send({ type: 'verdict', sampleCount: 0, closedBy: 'client_end', output: out });
              closeSocket();
              return;
            }
            if (confirmPrep.attemptsExhausted) {
              committed = true;
              const out = await this.signRefusal('attempts_exhausted', {}, this.now());
              send({ type: 'verdict', sampleCount: 0, closedBy: 'client_end', output: out });
              closeSocket();
              return;
            }
            storedOpening = confirmPrep.opening;
            otherSignerTemplatesB64 = confirmPrep.otherSignerTemplatesB64;
          }

          const prepared = this.deps.wasm.call<{
            ok: boolean;
            sentence?: string;
            display_text?: string;
            expected_tokens?: string[];
            request_digest_b64u?: string;
            recalled?: boolean;
            reason?: string;
          }>({
            cmd: 'prepare',
            owner,
            request,
            contacts,
            salt_hex: saltHex,
            stored_proposal: storedOpening ?? undefined,
          });

          if (!prepared.ok || !prepared.sentence || !prepared.expected_tokens || !prepared.request_digest_b64u) {
            committed = true;
            const out = await this.signRefusal(prepared.reason ?? 'unsupported', {}, this.now());
            send({ type: 'verdict', sampleCount: 0, closedBy: 'client_end', output: out });
            closeSocket();
            return;
          }

          try {
            sttStream = await this.deps.stt.openStream((ev) => {
              if (committed) return;
              latestTranscript = ev.transcript;
              const prog = this.deps.wasm.call<{
                ok: boolean;
                heard?: string;
                heard_tokens?: string[];
                matched_prefix_count?: number;
                expected_count?: number;
                passes_now?: boolean;
              }>({
                cmd: 'stream_progress',
                owner,
                request,
                contacts,
                transcript: ev.transcript,
                salt_hex: saltHex,
                stored_proposal: storedOpening ?? undefined,
              });

              if (prog.ok) {
                send({
                  type: 'transcript',
                  heard: prog.heard ?? '',
                  heardTokens: prog.heard_tokens ?? [],
                  matchedPrefixCount: prog.matched_prefix_count ?? 0,
                  expectedCount: prog.expected_count ?? 0,
                  isFinal: ev.isFinal,
                  passesNow: Boolean(prog.passes_now),
                });

                const currentSamples = Math.floor(pcmBytes / 2);
                if (prog.passes_now && currentSamples >= MIN_EARLY_CLOSE_SAMPLES) {
                  if (earlyCloseTimer === null) {
                    earlyCloseTimer = setTimeout(() => {
                      void commit('token_match');
                    }, this.earlyCloseGuardMs);
                  }
                } else {
                  clearEarlyTimer();
                }
              }

              if (ev.speechFinal && !committed && Math.floor(pcmBytes / 2) >= MIN_EARLY_CLOSE_SAMPLES) {
                void commit('stt_speech_final');
              }
            });
          } catch {
            committed = true;
            const out = await this.signRefusal('transcriber_unavailable', {}, this.now());
            send({ type: 'verdict', sampleCount: 0, closedBy: 'client_end', output: out });
            closeSocket();
            return;
          }

          initialized = true;
          send({
            type: 'ready',
            sentence: prepared.recalled ? '' : prepared.sentence,
            displayText: prepared.recalled ? '' : (prepared.display_text ?? prepared.sentence),
            expectedTokens: prepared.recalled ? [] : prepared.expected_tokens,
            requestDigestB64u: prepared.request_digest_b64u,
            recalled: Boolean(prepared.recalled),
            mock: this.mockMode,
          });
        }
      },

      onBinaryChunk: (bytes: Uint8Array) => {
        if (committed || !initialized) return;
        const evenLen = bytes.length - (bytes.length % 2);
        if (evenLen <= 0) return;
        const space = MAX_PCM_BYTES - pcmBytes;
        const take = Math.min(evenLen, space);
        if (take > 0) {
          const chunk = bytes.subarray(0, take);
          pcmBuffer.set(chunk, pcmBytes);
          pcmBytes += take;
          sttStream?.sendPcmChunk(chunk);
        }
        if (pcmBytes >= MAX_PCM_BYTES) {
          void commit('max_duration');
        }
      },

      onDisconnect: () => {
        committed = true;
        clearEarlyTimer();
        sttStream?.close();
      },
    };
  }

  private async executeVerifyCore(params: {
    owner: string;
    request: SaySoRequestInput;
    contacts: string[];
    audio: WasmAudioResult;
    transcriptOverride?: string;
    ms: Record<string, number>;
    started: number;
  }): Promise<VerifyWireOutput> {
    let saltHex: string | undefined;
    let storedOpening: StoredMultisigOpening | null = null;
    let otherSignerTemplatesB64: string[] = [];

    if (params.request.kind === 'multisig_propose' || params.request.kind === 'multisig_hide_note') {
      saltHex = toHex(crypto.getRandomValues(new Uint8Array(32)));
    } else if (params.request.kind === 'multisig_confirm') {
      const prep = await this.deps.multisigStore.prepareConfirm(
        params.request.multisig,
        params.request.commitment_hex,
        params.owner,
      );
      if (!prep.opening) return this.signRefusal('proposal_missing', params.ms, params.started);
      if (prep.attemptsExhausted) return this.signRefusal('attempts_exhausted', params.ms, params.started);
      storedOpening = prep.opening;
      otherSignerTemplatesB64 = prep.otherSignerTemplatesB64;
    }

    const parallelStart = this.now();
    const [consumed, speakerReply, transcript, summaryPasses] = await Promise.all([
      this.deps.voiceStore.consumeAudioAndGetTemplate(
        params.owner,
        params.audio.audio_digest_b64u!,
        params.started,
      ),
      params.audio.gate_passes
        ? this.deps.speaker.embed(params.audio.canonical_wav_b64!, params.audio.audio_digest_hex!)
        : Promise.resolve(null),
      params.transcriptOverride !== undefined
        ? Promise.resolve(params.transcriptOverride)
        : params.audio.gate_passes
          ? this.deps.stt.transcribeBatch(params.audio.canonical_wav_b64!)
          : Promise.resolve(null),
      params.request.kind === 'community_note' && this.deps.stt.checkNoteSummary
        ? this.deps.stt.checkNoteSummary(params.request.note_text, params.request.summary)
        : Promise.resolve(true),
    ]);
    params.ms.critical_parallel = this.now() - parallelStart;
    if (speakerReply) params.ms.redimnet = speakerReply.modelMs;

    return this.finalizeAndSign({
      owner: params.owner,
      request: params.request,
      contacts: params.contacts,
      audio: params.audio,
      consumed,
      speakerEmbeddingB64: speakerReply?.embeddingLeB64 ?? null,
      otherSignerTemplatesB64,
      transcript,
      summaryPasses,
      saltHex,
      storedOpening,
      ms: params.ms,
      started: params.started,
    });
  }

  private async finalizeAndSign(params: {
    owner: string;
    request: SaySoRequestInput;
    contacts: string[];
    audio: WasmAudioResult;
    consumed: { audioReused: boolean; template: { epoch: number; templateSvt1B64: string } | null };
    speakerEmbeddingB64: string | null;
    otherSignerTemplatesB64: string[];
    transcript: string | null;
    summaryPasses: boolean | null;
    saltHex: string | undefined;
    storedOpening: StoredMultisigOpening | null;
    ms: Record<string, number>;
    started: number;
  }): Promise<VerifyWireOutput> {
    if (params.request.kind === 'community_note' && params.summaryPasses === null) {
      return this.signRefusal('summary_check_unavailable', params.ms, params.started);
    }

    const ready = this.deps.wasm.call<WasmVerdictReady>({
      cmd: 'evaluate_verify',
      owner: params.owner,
      request: params.request,
      contacts: params.contacts,
      audio_digest_b64u: params.audio.audio_digest_b64u,
      gate_passes: Boolean(params.audio.gate_passes),
      audio_reused: params.consumed.audioReused,
      template_svt1_b64: params.consumed.template?.templateSvt1B64 ?? null,
      embedding_le_b64: params.speakerEmbeddingB64,
      other_signer_templates_b64: params.otherSignerTemplatesB64,
      transcript: params.transcript,
      summary_passes: params.summaryPasses,
      now_ms: this.now(),
      verifier_version: this.verifierVersion,
      salt_hex: params.saltHex,
      stored_proposal: params.storedOpening ?? undefined,
    });

    if (params.consumed.template) {
      if (
        (params.request.kind === 'multisig_propose' || params.request.kind === 'multisig_hide_note') &&
        (ready.outcome === 'accept' || ready.outcome === 'step_up') &&
        ready.multisig &&
        params.saltHex
      ) {
        const prepared = this.deps.wasm.call<{ multisig_commitment_hex?: string }>({
          cmd: 'prepare',
          owner: params.owner,
          request: params.request,
          contacts: params.contacts,
          salt_hex: params.saltHex,
        });
        if (prepared.multisig_commitment_hex) {
          const opening: StoredMultisigOpening =
            params.request.kind === 'multisig_propose'
              ? {
                  proposal_id: params.request.proposal_id,
                  receiver: params.request.receiver,
                  amount_yocto: params.request.amount_yocto,
                  salt_hex: params.saltHex,
                }
              : {
                  proposal_id: params.request.proposal_id,
                  note_id: params.request.note_id,
                  salt_hex: params.saltHex,
                };
          await this.deps.multisigStore.saveProposal(
            params.request.multisig,
            prepared.multisig_commitment_hex,
            opening,
            params.owner,
            params.consumed.template.templateSvt1B64,
          );
        }
      } else if (params.request.kind === 'multisig_confirm') {
        if (ready.outcome === 'accept' || ready.outcome === 'step_up') {
          await this.deps.multisigStore.recordConfirmOutcome(
            params.request.multisig,
            params.request.commitment_hex,
            params.owner,
            ready.outcome,
            params.consumed.template.templateSvt1B64,
          );
        } else if (ready.reason === 'words') {
          await this.deps.multisigStore.recordConfirmOutcome(
            params.request.multisig,
            params.request.commitment_hex,
            params.owner,
            'words_refusal',
            params.consumed.template.templateSvt1B64,
          );
        }
      }
    }

    const signStart = this.now();
    const signatureB64 = await this.deps.signer.signMessageB64(ready.verdict_message_b64);
    params.ms.sign = this.now() - signStart;
    params.ms.total = this.now() - params.started;

    const out: VerifyWireOutput = {
      kind: 'seams_voice_verify_output_v2',
      verdict_json: ready.verdict_json,
      signature_b64: signatureB64,
      public_key: this.deps.signer.publicKeyNear,
      policy_text: ready.policy_text,
      ms: params.ms,
      detail: null,
    };
    if (ready.multisig) out.multisig = ready.multisig;
    return out;
  }

  private async signRefusal(
    reason: string,
    ms: Record<string, number>,
    started: number,
  ): Promise<VerifyWireOutput> {
    const ready = this.deps.wasm.call<WasmVerdictReady>({
      cmd: 'refuse_verdict',
      reason,
      now_ms: this.now(),
      verifier_version: this.verifierVersion,
    });
    const signatureB64 = await this.deps.signer.signMessageB64(ready.verdict_message_b64);
    ms.total = this.now() - started;
    return {
      kind: 'seams_voice_verify_output_v2',
      verdict_json: ready.verdict_json,
      signature_b64: signatureB64,
      public_key: this.deps.signer.publicKeyNear,
      policy_text: null,
      ms,
      detail: null,
    };
  }

  private refuseEnroll(
    reason: string,
    ms: Record<string, number>,
    started: number,
  ): EnrollWireOutput {
    return {
      kind: 'seams_voice_enrollment_v3',
      outcome: 'refuse',
      reason,
      template_epoch: null,
      agreement_milli: null,
      verifier_public_key: this.deps.signer.publicKeyNear,
      ms: { ...ms, total: this.now() - started },
    };
  }
}
