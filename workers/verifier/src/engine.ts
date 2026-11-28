import type {
  EnrollWireOutput,
  RenderWireOutput,
  TemplateDeleteWireOutput,
  StreamClientMessage,
  StreamServerMessage,
  VerifyWireOutput,
} from '@seams/sayso-client';
import type { SaySoIntentInput } from '@seams/sayso-verdict';
import type { VoiceStore } from './accountVoiceDo.ts';
import { toBase64, type VerdictSigner } from './crypto.ts';
import type { SpeakerClient } from './speaker.ts';
import type { SttLiveStream, SttProvider } from './stt.ts';
import type { SaySoCore } from './wasm.ts';

const MAX_PCM_BYTES = 8 * 16_000 * 2; // 8.0 s of 16 kHz PCM16 LE
const MIN_EARLY_CLOSE_SAMPLES = 10_240; // >= 640 ms before early-closing on token match
const DEFAULT_MAX_STREAM_MS = 15_000; // Hard wall-clock cap per stream session to protect STT billing

export interface StreamAuthConstraints {
  authorizedUserId?: string;
  authorizedIntentDigestB64u?: string;
}

export interface EngineDeps {
  wasm: SaySoCore;
  signer: VerdictSigner;
  voiceStore: VoiceStore;
  speaker: SpeakerClient;
  stt: SttProvider;
  /** True only when `SAYSO_DEV_MOCK=true` is explicitly opted in for local offline UI testing. */
  mockMode?: boolean;
  /** Written into `Verdict.verifier` (`"sayso/0.2.0"` or `"sayso/0.2.0+mock"`). */
  verifierVersion?: string;
  /** Trailing window after expected tokens match to catch negations like "... not". Default: 200 ms. */
  earlyCloseGuardMs?: number;
  /** Hard wall-clock timeout once STT stream opens. Default: 15,000 ms. */
  maxStreamMs?: number;
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
  ok: true;
  outcome: 'accept' | 'refuse';
  reason: string | null;
  verdict_json: string;
  verdict_message_b64: string;
  expires_at_ms: number;
}

/** sayso-wasm could not read the command. */
interface WasmUnreadable {
  ok: false;
  reason?: string;
  detail?: string;
}

export class SaySoEngine {
  private readonly deps: EngineDeps;
  private readonly mockMode: boolean;
  private readonly verifierVersion: string;
  private readonly earlyCloseGuardMs: number;
  private readonly maxStreamMs: number;
  private readonly now: () => number;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.mockMode = Boolean(deps.mockMode);
    this.verifierVersion = deps.verifierVersion ?? (this.mockMode ? 'sayso/0.2.0+mock' : 'sayso/0.2.0');
    this.earlyCloseGuardMs = deps.earlyCloseGuardMs ?? 200;
    this.maxStreamMs = deps.maxStreamMs ?? DEFAULT_MAX_STREAM_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  render(intent: SaySoIntentInput): RenderWireOutput {
    return this.deps.wasm.call<RenderWireOutput>({
      cmd: 'prepare',
      intent,
    });
  }

  async enroll(userId: string, wavB64List: string[]): Promise<EnrollWireOutput> {
    const started = this.now();
    const ms: Record<string, number> = {};
    if (!userId || wavB64List.length !== 3) {
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
      this.deps.voiceStore.getTemplate(userId),
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
        kind: 'sayso_enrollment_v1',
        outcome: 'refuse',
        reason: evalRes.reason ?? 'speaker',
        template_epoch: null,
        agreement_milli: evalRes.agreement_milli ?? null,
        verifier_public_key_hex: this.deps.signer.publicKeyHex,
        ms: { ...ms, total: this.now() - started },
      };
    }

    const doStart = this.now();
    await this.deps.voiceStore.saveTemplate(userId, evalRes.template_epoch, evalRes.template_svt1_b64);
    ms.storage = this.now() - doStart;
    ms.total = this.now() - started;

    return {
      kind: 'sayso_enrollment_v1',
      outcome: 'accept',
      reason: null,
      template_epoch: evalRes.template_epoch,
      agreement_milli: evalRes.agreement_milli ?? null,
      verifier_public_key_hex: this.deps.signer.publicKeyHex,
      ms,
    };
  }

  /**
   * Deletes the voice template of `userId`, for example when the user turns voice approval off.
   * A later verify refuses with `template_missing` until the user enrolls again.
   */
  async deleteTemplate(userId: string): Promise<TemplateDeleteWireOutput> {
    return { kind: 'sayso_template_delete_v1', deleted: await this.deps.voiceStore.deleteTemplate(userId) };
  }

  async verifyBatch(params: {
    intent: SaySoIntentInput;
    audioWavB64: string;
    mockTranscript?: string;
  }): Promise<VerifyWireOutput> {
    const started = this.now();
    const ms: Record<string, number> = {};

    // Refuse an intent that sayso-wasm does not accept before the audio is consumed and
    // before the speaker and transcriber calls, which cost money.
    const prepared = this.render(params.intent);
    if (!prepared.ok) {
      return this.signRefusal(prepared.reason ?? 'unsupported', ms, started);
    }

    const audio = this.deps.wasm.call<WasmAudioResult>({
      cmd: 'audio_from_wav',
      wav_b64: params.audioWavB64,
    });
    ms.decode = this.now() - started;

    if (!audio.ok || !audio.canonical_wav_b64 || !audio.audio_digest_b64u || !audio.audio_digest_hex) {
      return this.signRefusal('audio_invalid', ms, started);
    }

    const parallelStart = this.now();
    const part = <T>(key: string, promise: Promise<T>) => this.timePart(ms, key, parallelStart, promise);
    const [consumed, speakerReply, transcript] = await Promise.all([
      part(
        'storage',
        this.deps.voiceStore.consumeAudioAndGetTemplate(params.intent.user_id, audio.audio_digest_b64u, started),
      ),
      audio.gate_passes
        ? part('speaker', this.deps.speaker.embed(audio.canonical_wav_b64, audio.audio_digest_hex))
        : Promise.resolve(null),
      this.mockMode && params.mockTranscript !== undefined
        ? Promise.resolve(params.mockTranscript)
        : audio.gate_passes
          ? part('stt', this.deps.stt.transcribeBatch(audio.canonical_wav_b64, ms))
          : Promise.resolve(null),
    ]);
    ms.critical_parallel = this.now() - parallelStart;
    if (speakerReply) ms.redimnet = speakerReply.modelMs;

    return this.finalizeAndSign({
      intent: params.intent,
      audio,
      consumed,
      speakerEmbeddingB64: speakerReply?.embeddingLeB64 ?? null,
      transcript,
      ms,
      started,
    });
  }

  attachStreamSession(
    send: (msg: StreamServerMessage) => void,
    closeSocket: () => void,
    authConstraints?: StreamAuthConstraints,
  ): {
    onTextMessage: (raw: string) => Promise<void>;
    onBinaryChunk: (bytes: Uint8Array) => void;
    onDisconnect: () => void;
  } {
    const pcmBuffer = new Uint8Array(MAX_PCM_BYTES);
    let pcmBytes = 0;
    let initialized = false;
    let committed = false;
    let earlyCloseTimer: ReturnType<typeof setTimeout> | null = null;
    let maxSessionTimer: ReturnType<typeof setTimeout> | null = null;
    let sttStream: SttLiveStream | null = null;
    let latestTranscript = '';
    let intent!: SaySoIntentInput;

    const clearEarlyTimer = () => {
      if (earlyCloseTimer !== null) {
        clearTimeout(earlyCloseTimer);
        earlyCloseTimer = null;
      }
    };

    const clearMaxSessionTimer = () => {
      if (maxSessionTimer !== null) {
        clearTimeout(maxSessionTimer);
        maxSessionTimer = null;
      }
    };

    const commit = async (
      closedBy: 'token_match' | 'stt_speech_final' | 'client_end' | 'max_duration',
    ) => {
      if (committed || !initialized) return;
      committed = true;
      clearEarlyTimer();
      clearMaxSessionTimer();

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
      const part = <T>(key: string, promise: Promise<T>) => this.timePart(ms, key, parallelStart, promise);
      const [flushedTranscript, consumed, speakerReply] = await Promise.all([
        sttStream ? part('stt', sttStream.finishAndFlush()) : Promise.resolve(latestTranscript || null),
        part(
          'storage',
          this.deps.voiceStore.consumeAudioAndGetTemplate(intent.user_id, audio.audio_digest_b64u, commitStarted),
        ),
        audio.gate_passes
          ? part('speaker', this.deps.speaker.embed(audio.canonical_wav_b64, audio.audio_digest_hex))
          : Promise.resolve(null),
      ]);
      sttStream?.close();
      ms.critical_parallel = this.now() - parallelStart;
      if (speakerReply) ms.redimnet = speakerReply.modelMs;

      const finalTranscript = flushedTranscript ?? (latestTranscript || null);
      const output = await this.finalizeAndSign({
        intent,
        audio,
        consumed,
        speakerEmbeddingB64: speakerReply?.embeddingLeB64 ?? null,
        transcript: finalTranscript,
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
          intent = msg.intent;

          if (authConstraints?.authorizedUserId && intent?.user_id !== authConstraints.authorizedUserId) {
            committed = true;
            send({
              type: 'error',
              reason: 'unauthorized_user',
              detail: 'intent user_id does not match verify token',
            });
            closeSocket();
            return;
          }

          const prepared = this.deps.wasm.call<{
            ok: boolean;
            sentence?: string;
            display_text?: string;
            expected_tokens?: string[];
            intent_digest_b64u?: string;
            reason?: string;
          }>({
            cmd: 'prepare',
            intent,
          });

          if (!prepared.ok || !prepared.sentence || !prepared.expected_tokens || !prepared.intent_digest_b64u) {
            committed = true;
            const out = await this.signRefusal(prepared.reason ?? 'unsupported', {}, this.now());
            send({ type: 'verdict', sampleCount: 0, closedBy: 'client_end', output: out });
            closeSocket();
            return;
          }

          if (
            authConstraints?.authorizedIntentDigestB64u &&
            prepared.intent_digest_b64u !== authConstraints.authorizedIntentDigestB64u
          ) {
            committed = true;
            send({
              type: 'error',
              reason: 'unauthorized_intent',
              detail: 'intent digest does not match verify token',
            });
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
                intent,
                transcript: ev.transcript,
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
          maxSessionTimer = setTimeout(() => {
            void commit('max_duration');
          }, this.maxStreamMs);
          send({
            type: 'ready',
            sentence: prepared.sentence,
            displayText: prepared.display_text ?? prepared.sentence,
            expectedTokens: prepared.expected_tokens,
            intentDigestB64u: prepared.intent_digest_b64u,
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
        clearMaxSessionTimer();
        sttStream?.close();
      },
    };
  }

  private async finalizeAndSign(params: {
    intent: SaySoIntentInput;
    audio: WasmAudioResult;
    consumed: { audioReused: boolean; template: { epoch: number; templateSvt1B64: string } | null };
    speakerEmbeddingB64: string | null;
    transcript: string | null;
    ms: Record<string, number>;
    started: number;
  }): Promise<VerifyWireOutput> {
    return this.signVerdict(
      {
        cmd: 'evaluate_verify',
        intent: params.intent,
        audio_digest_b64u: params.audio.audio_digest_b64u,
        gate_passes: Boolean(params.audio.gate_passes),
        audio_reused: params.consumed.audioReused,
        template_svt1_b64: params.consumed.template?.templateSvt1B64 ?? null,
        embedding_le_b64: params.speakerEmbeddingB64,
        transcript: params.transcript,
        now_ms: this.now(),
        verifier_version: this.verifierVersion,
      },
      params.ms,
      params.started,
    );
  }

  /**
   * Records in `ms[key]` the time from `since` until `promise` settles. The verify paths run
   * speech to text, the speaker and storage in parallel, so `critical_parallel` alone does not
   * say which part was slow. In a Worker the clock moves only across I/O, and each part ends in
   * I/O, so the time is that of the part.
   */
  private timePart<T>(ms: Record<string, number>, key: string, since: number, promise: Promise<T>): Promise<T> {
    return promise.finally(() => {
      ms[key] = this.now() - since;
    });
  }

  private signRefusal(
    reason: string,
    ms: Record<string, number>,
    started: number,
  ): Promise<VerifyWireOutput> {
    return this.signVerdict(
      { cmd: 'refuse_verdict', reason, now_ms: this.now(), verifier_version: this.verifierVersion },
      ms,
      started,
    );
  }

  /**
   * Signs the verdict that sayso-wasm builds for `command`. Both verify paths check the
   * caller's intent with `prepare` first, so a command that sayso-wasm cannot read is a fault
   * of the Worker.
   */
  private async signVerdict(
    command: Record<string, unknown>,
    ms: Record<string, number>,
    started: number,
  ): Promise<VerifyWireOutput> {
    const ready = this.deps.wasm.call<WasmVerdictReady | WasmUnreadable>(command);
    if (!ready.ok) {
      throw new Error(`sayso-wasm could not read '${String(command.cmd)}': ${ready.detail ?? ready.reason}`);
    }
    const signStart = this.now();
    const signatureB64 = await this.deps.signer.signMessageB64(ready.verdict_message_b64);
    ms.sign = this.now() - signStart;
    ms.total = this.now() - started;
    return {
      kind: 'sayso_verify_output_v1',
      verdict_json: ready.verdict_json,
      signature_b64: signatureB64,
      public_key_hex: this.deps.signer.publicKeyHex,
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
      kind: 'sayso_enrollment_v1',
      outcome: 'refuse',
      reason,
      template_epoch: null,
      agreement_milli: null,
      verifier_public_key_hex: this.deps.signer.publicKeyHex,
      ms: { ...ms, total: this.now() - started },
    };
  }
}
