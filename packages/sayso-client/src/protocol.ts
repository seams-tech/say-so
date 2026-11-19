export type SaySoRequestInput =
  | { kind: 'confirmation'; context: string; payload_sha256_hex: string; summary: string }
  | { kind: 'transfer'; receiver: string; amount_yocto: string }
  | { kind: 'community_note'; contract: string; post_id: number; note_text: string; summary: string }
  | { kind: 'note_rating'; contract: string; note_id: number; rating: 'helpful' | 'somewhat_helpful' | 'not_helpful' }
  | {
      kind: 'market_bet';
      market: string;
      token: string;
      market_id: number;
      outcome: 'yes' | 'no';
      amount_units: string;
    }
  | {
      kind: 'merge_approval';
      contract: string;
      repo_sha256_hex: string;
      pull_request: number;
      base: string;
      head_commit_hex: string;
    }
  | { kind: 'transaction'; receiver: string; actions_sha256_hex: string; summary: string }
  | { kind: 'signed_message'; payload_sha256_hex: string; summary: string }
  | { kind: 'multisig_propose'; multisig: string; proposal_id: number; receiver: string; amount_yocto: string }
  | { kind: 'multisig_hide_note'; multisig: string; proposal_id: number; note_id: number }
  | { kind: 'multisig_confirm'; multisig: string; proposal_id: number; commitment_hex: string };

export interface VerifyWireOutput {
  kind: 'seams_voice_verify_output_v2';
  verdict_json: string;
  signature_b64: string | null;
  public_key: string | null;
  policy_text: string | null;
  ms: Record<string, number>;
  detail: string | null;
  multisig?: { commitment: string; salt: string };
}

export interface EnrollWireOutput {
  kind: 'seams_voice_enrollment_v3';
  outcome: 'accept' | 'refuse';
  reason: string | null;
  template_epoch: number | null;
  agreement_milli: number | null;
  verifier_public_key: string;
  ms: Record<string, number>;
}

export interface RenderWireOutput {
  ok: boolean;
  sentence?: string;
  display_text?: string;
  expected_tokens?: string[];
  request_digest_b64u?: string;
  spoken_text_digest_b64u?: string | null;
  recalled?: boolean;
  is_summary?: boolean;
  reason?: string;
}

export type StreamClientMessage =
  | {
      type: 'init';
      owner: string;
      request: SaySoRequestInput;
      contacts?: string[];
    }
  | {
      type: 'end';
      clientSpeechEndedAtMs?: number;
    }
  | {
      /** Ignored unless Worker has opt-in `SAYSO_DEV_MOCK=true`. */
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
      requestDigestB64u: string;
      recalled: boolean;
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
