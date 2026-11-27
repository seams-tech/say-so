import type { SaySoIntentInput } from '@sayso/verdict';

export interface VerifyWireOutput {
  kind: 'sayso_verify_output_v1';
  verdict_json: string;
  signature_b64: string | null;
  /** Standard 64-character lowercase hex Ed25519 public key. */
  public_key_hex: string | null;
  ms: Record<string, number>;
  detail: string | null;
}

export interface EnrollWireOutput {
  kind: 'sayso_enrollment_v1';
  outcome: 'accept' | 'refuse';
  reason: string | null;
  template_epoch: number | null;
  agreement_milli: number | null;
  verifier_public_key_hex: string;
  ms: Record<string, number>;
}

export interface RenderWireOutput {
  ok: boolean;
  sentence?: string;
  display_text?: string;
  expected_tokens?: string[];
  /** Positions in `expected_tokens` where a misheard word is never forgiven. */
  guarded_word_indexes?: number[];
  intent_digest_b64u?: string;
  spoken_text_digest_b64u?: string;
  reason?: string;
}

export type StreamClientMessage =
  | {
      type: 'init';
      intent: SaySoIntentInput;
    }
  | {
      type: 'end';
      clientSpeechEndedAtMs?: number;
    }
  | {
      /** Ignored unless Worker runs with opt-in `SAYSO_DEV_MOCK=true`. */
      type: 'mock_transcript';
      transcript: string;
      isFinal: boolean;
      speechFinal: boolean;
    };

export type StreamServerMessage =
  | {
      type: 'ready';
      sentence: string;
      displayText: string;
      expectedTokens: string[];
      intentDigestB64u: string;
      mock: boolean;
    }
  | {
      type: 'transcript';
      heard: string;
      heardTokens: string[];
      matchedPrefixCount: number;
      expectedCount: number;
      isFinal: boolean;
      passesNow: boolean;
    }
  | {
      type: 'verdict';
      sampleCount: number;
      closedBy: 'token_match' | 'stt_speech_final' | 'client_end' | 'max_duration';
      output: VerifyWireOutput;
    }
  | {
      type: 'error';
      reason: string;
      detail?: string;
    };
