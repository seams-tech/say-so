/**
 * Zero-dependency WebCrypto Ed25519 verifier for SaySo signed verdicts (`sayso_verdict_v1`).
 * Works identically in browsers, Node 20+, Cloudflare Workers, Deno, and Bun.
 */

import type { VerdictReplayGuard } from './replay.ts';

export const VERDICT_DOMAIN = 'sayso:verdict:v1';
export const VERDICT_KIND = 'sayso_verdict_v1';
export const VERDICT_LIFE_MS = 120_000;
export const MAX_VERDICT_LIFE_MS = VERDICT_LIFE_MS + 30_000;

export type VerdictOutcome = 'accept' | 'refuse';

export interface SaySoVerdict {
  kind: typeof VERDICT_KIND;
  verifier: string;
  user_id: string | null;
  action: string | null;
  /** base64url (no padding) SHA-256 intent digest */
  intent_digest: string | null;
  /** base64url (no padding) SHA-256 spoken text digest */
  spoken_text_digest: string | null;
  /** base64url (no padding) SHA-256 canonical WAV digest */
  audio_digest: string | null;
  outcome: VerdictOutcome;
  reason: string | null;
  expires_at_ms: number;
  speaker_score_milli: number | null;
  /** Present only on `words` refusal; `null` on `accept`. */
  heard: string | null;
}

export type VerdictRefusal =
  | { code: 'bad_public_key' }
  | { code: 'bad_signature_encoding' }
  | { code: 'bad_signature' }
  | { code: 'malformed'; detail: string }
  | { code: 'wrong_kind'; kind: string }
  | { code: 'refused'; reason: string | null; verdict: SaySoVerdict }
  | { code: 'expired'; expiresAtMs: number; verdict: SaySoVerdict }
  | { code: 'not_yet_valid'; expiresAtMs: number; verdict: SaySoVerdict }
  | { code: 'user_mismatch'; verdict: SaySoVerdict }
  | { code: 'action_mismatch'; verdict: SaySoVerdict }
  | { code: 'intent_mismatch'; verdict: SaySoVerdict }
  | { code: 'spoken_text_mismatch'; verdict: SaySoVerdict }
  | { code: 'audio_mismatch'; verdict: SaySoVerdict }
  | { code: 'verdict_replayed'; verdict: SaySoVerdict };

export type VerdictCheck =
  | { ok: true; verdict: SaySoVerdict }
  | { ok: false; refusal: VerdictRefusal };

/** 32-byte digest as raw bytes, 64 hex chars, or 43-char unpadded base64url. */
export type Digest = Uint8Array | string;

export interface VerifyVerdictInput {
  /** Raw signed JSON string returned by the SaySo verifier. Do not re-serialize. */
  verdictJson: string;
  /** Standard base64 64-byte Ed25519 signature. */
  signatureB64: string;
  /** Pinned verifier Ed25519 public key: 32 bytes, 64 hex chars, or 43-char base64url. */
  publicKey: Uint8Array | string;
  /** Expected user ID (optional). */
  userId?: string;
  /** Expected action string (optional). */
  action?: string;
  /** Expected 32-byte intent digest from `createIntent()` (recommended!). */
  intentDigest?: Digest;
  /** Expected 32-byte spoken text digest (optional). */
  spokenTextDigest?: Digest;
  /** Expected 32-byte canonical WAV audio digest (optional). */
  audioDigest?: Digest;
  /** Override clock in ms since UNIX epoch. Default: `Date.now()`. */
  nowMs?: number;
  /** Optional single-use replay guard to reject duplicate verdict submissions before expiry. */
  replayGuard?: VerdictReplayGuard;
}

const VERDICT_FIELDS = [
  'kind',
  'verifier',
  'user_id',
  'action',
  'intent_digest',
  'spoken_text_digest',
  'audio_digest',
  'outcome',
  'reason',
  'expires_at_ms',
  'speaker_score_milli',
  'heard',
] as const;

const utf8 = new TextEncoder();

export async function verdictMessage(verdictJson: string): Promise<Uint8Array<ArrayBuffer>> {
  const prefix = utf8.encode(VERDICT_DOMAIN);
  const body = utf8.encode(verdictJson);
  const preimage = new Uint8Array(prefix.length + body.length);
  preimage.set(prefix, 0);
  preimage.set(body, prefix.length);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', preimage));
}

export async function verifyVerdict(input: VerifyVerdictInput): Promise<VerdictCheck> {
  const pubKeyBytes = parsePublicKey(input.publicKey);
  if (!pubKeyBytes) return { ok: false, refusal: { code: 'bad_public_key' } };

  const signature = fromBase64(input.signatureB64);
  if (!signature || signature.length !== 64) {
    return { ok: false, refusal: { code: 'bad_signature_encoding' } };
  }

  const message = await verdictMessage(input.verdictJson);
  const validSig = await verifyEd25519(pubKeyBytes, signature, message);
  if (!validSig) return { ok: false, refusal: { code: 'bad_signature' } };

  const parsed = parseVerdict(input.verdictJson);
  if ('refusal' in parsed) return { ok: false, refusal: parsed.refusal };
  const verdict = parsed.verdict;

  if (verdict.outcome === 'refuse') {
    return { ok: false, refusal: { code: 'refused', reason: verdict.reason, verdict } };
  }

  const nowMs = input.nowMs ?? Date.now();
  if (verdict.expires_at_ms <= nowMs) {
    return { ok: false, refusal: { code: 'expired', expiresAtMs: verdict.expires_at_ms, verdict } };
  }
  if (verdict.expires_at_ms > nowMs + MAX_VERDICT_LIFE_MS) {
    return { ok: false, refusal: { code: 'not_yet_valid', expiresAtMs: verdict.expires_at_ms, verdict } };
  }

  if (input.userId !== undefined && verdict.user_id !== input.userId) {
    return { ok: false, refusal: { code: 'user_mismatch', verdict } };
  }
  if (input.action !== undefined && verdict.action !== input.action) {
    return { ok: false, refusal: { code: 'action_mismatch', verdict } };
  }
  if (input.intentDigest !== undefined && !sameDigest(verdict.intent_digest, input.intentDigest)) {
    return { ok: false, refusal: { code: 'intent_mismatch', verdict } };
  }
  if (input.spokenTextDigest !== undefined && !sameDigest(verdict.spoken_text_digest, input.spokenTextDigest)) {
    return { ok: false, refusal: { code: 'spoken_text_mismatch', verdict } };
  }
  if (input.audioDigest !== undefined && !sameDigest(verdict.audio_digest, input.audioDigest)) {
    return { ok: false, refusal: { code: 'audio_mismatch', verdict } };
  }
  if (input.replayGuard !== undefined) {
    if (!verdict.audio_digest) {
      return { ok: false, refusal: { code: 'malformed', detail: 'accepted verdict missing audio_digest' } };
    }
    const fresh = await input.replayGuard.consumeOnce(verdict.audio_digest, verdict.expires_at_ms);
    if (!fresh) {
      return { ok: false, refusal: { code: 'verdict_replayed', verdict } };
    }
  }

  return { ok: true, verdict };
}

export function parseVerdict(verdictJson: string): { verdict: SaySoVerdict } | { refusal: VerdictRefusal } {
  let raw: unknown;
  try {
    raw = JSON.parse(verdictJson);
  } catch (err) {
    return { refusal: { code: 'malformed', detail: err instanceof Error ? err.message : 'invalid json' } };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { refusal: { code: 'malformed', detail: 'verdict must be a JSON object' } };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.kind !== 'string') {
    return { refusal: { code: 'malformed', detail: 'missing kind' } };
  }
  if (obj.kind !== VERDICT_KIND) {
    return { refusal: { code: 'wrong_kind', kind: obj.kind } };
  }
  const keys = Object.keys(obj);
  if (keys.length !== VERDICT_FIELDS.length || !VERDICT_FIELDS.every((k) => k in obj)) {
    return { refusal: { code: 'malformed', detail: 'unexpected or missing verdict fields' } };
  }
  const optStr = (v: unknown) => v === null || typeof v === 'string';
  const optInt = (v: unknown) => v === null || (typeof v === 'number' && Number.isInteger(v));
  if (
    typeof obj.verifier !== 'string' ||
    !optStr(obj.user_id) ||
    !optStr(obj.action) ||
    !optStr(obj.intent_digest) ||
    !optStr(obj.spoken_text_digest) ||
    !optStr(obj.audio_digest) ||
    (obj.outcome !== 'accept' && obj.outcome !== 'refuse') ||
    !optStr(obj.reason) ||
    typeof obj.expires_at_ms !== 'number' ||
    !Number.isSafeInteger(obj.expires_at_ms) ||
    !optInt(obj.speaker_score_milli) ||
    !optStr(obj.heard)
  ) {
    return { refusal: { code: 'malformed', detail: 'invalid verdict field types' } };
  }
  return { verdict: obj as unknown as SaySoVerdict };
}

export function parsePublicKey(key: Uint8Array | string): Uint8Array<ArrayBuffer> | null {
  if (key instanceof Uint8Array) {
    return key.length === 32 ? new Uint8Array(key) : null;
  }
  const clean = key.trim().replace(/^ed25519:/i, '');
  if (/^[0-9a-fA-F]{64}$/.test(clean)) {
    return fromHex(clean);
  }
  if (/^[A-Za-z0-9_-]{43}$/.test(clean)) {
    const bytes = fromBase64Url(clean);
    return bytes && bytes.length === 32 ? bytes : null;
  }
  return null;
}

function sameDigest(signedB64u: string | null, expected: Digest): boolean {
  if (signedB64u === null) return false;
  const a = fromBase64Url(signedB64u);
  const b = parseDigest(expected);
  if (!a || !b || a.length !== 32 || b.length !== 32) return false;
  let diff = 0;
  for (let i = 0; i < 32; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function parseDigest(d: Digest): Uint8Array<ArrayBuffer> | null {
  if (d instanceof Uint8Array) return d.length === 32 ? new Uint8Array(d) : null;
  const clean = d.trim();
  if (/^[0-9a-fA-F]{64}$/.test(clean)) return fromHex(clean);
  if (/^[A-Za-z0-9_-]{43}$/.test(clean)) return fromBase64Url(clean);
  return null;
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(b64.trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function fromBase64Url(b64u: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(b64u)) return null;
  const std = b64u.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64u.length / 4) * 4, '=');
  return fromBase64(std);
}

async function verifyEd25519(
  pubKey: Uint8Array<ArrayBuffer>,
  signature: Uint8Array<ArrayBuffer>,
  message: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', pubKey, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, message);
  } catch {
    return false;
  }
}
