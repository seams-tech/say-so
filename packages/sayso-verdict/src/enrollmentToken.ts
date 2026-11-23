/**
 * Short-lived HMAC-SHA256 tokens (`<base64url(payload)>.<base64url(mac)>`) minted
 * by an application backend so browsers can call `POST /v1/enroll`, `POST /v1/verify`,
 * and `GET /v1/stream?token=...` directly without exposing a server API key or
 * allowing unauthenticated billing / DDoS against Workers AI and SpeakerContainer.
 *
 * Enrollment tokens (`sayso:enroll-token:v1:`) and verify/stream tokens
 * (`sayso:verify-token:v1:`) use distinct HMAC domain prefixes so they cannot be
 * interchanged even if both share the same secret.
 */

const utf8 = new TextEncoder();
const ENROLL_TOKEN_PREFIX = 'sayso:enroll-token:v1:';
const VERIFY_TOKEN_PREFIX = 'sayso:verify-token:v1:';
const DEFAULT_ENROLL_TTL_MS = 300_000; // 5 minutes
const DEFAULT_VERIFY_TTL_MS = 120_000; // 2 minutes

export interface CreateEnrollmentTokenOptions {
  userId: string;
  /** Shared HMAC secret matching `SAYSO_ENROLL_SECRET` on the Verifier Worker. */
  secret: string;
  /** Token lifetime in ms. Default: 300,000 ms (5 min). */
  ttlMs?: number;
  nowMs?: number;
}

export interface VerifyEnrollmentTokenOptions {
  token: string;
  expectedUserId: string;
  secret: string;
  nowMs?: number;
}

export type EnrollmentTokenCheck =
  | { ok: true; userId: string; expiresAtMs: number }
  | { ok: false; code: 'malformed' | 'bad_signature' | 'expired' | 'user_mismatch' };

export interface CreateVerifyTokenOptions {
  userId: string;
  /** Shared HMAC secret matching `SAYSO_AUTH_SECRET` (or fallback `SAYSO_ENROLL_SECRET`) on the Verifier Worker. */
  secret: string;
  /**
   * Optional 32-byte `intentDigest` (from `createIntent()`) or 43-char base64url digest.
   * When set, the Verifier Worker refuses any verify/stream intent with a different digest.
   */
  intentDigest?: Uint8Array | string;
  /** Token lifetime in ms. Default: 120,000 ms (2 min). */
  ttlMs?: number;
  nowMs?: number;
}

export interface VerifyVerifyTokenOptions {
  token: string;
  secret: string;
  /** Optional expected `user_id`. When omitted (e.g. on WS upgrade), caller checks `userId` on `init`. */
  expectedUserId?: string;
  /** Optional expected `intentDigest` (32 bytes or base64url). Checked when both are present. */
  expectedIntentDigest?: Uint8Array | string;
  nowMs?: number;
}

export type VerifyTokenCheck =
  | { ok: true; userId: string; intentDigestB64u?: string; expiresAtMs: number }
  | { ok: false; code: 'malformed' | 'bad_signature' | 'expired' | 'user_mismatch' | 'intent_mismatch' };

export async function createEnrollmentToken(options: CreateEnrollmentTokenOptions): Promise<string> {
  if (!options.userId || !options.secret) {
    throw new RangeError('userId and secret are required');
  }
  const now = options.nowMs ?? Date.now();
  const ttl = options.ttlMs ?? DEFAULT_ENROLL_TTL_MS;
  const nonceBytes = crypto.getRandomValues(new Uint8Array(12));
  const payload = JSON.stringify({
    u: options.userId,
    e: now + ttl,
    n: toBase64Url(nonceBytes),
  });
  const payloadB64u = toBase64Url(utf8.encode(payload));
  const mac = await hmacSha256(options.secret, `${ENROLL_TOKEN_PREFIX}${payloadB64u}`);
  return `${payloadB64u}.${toBase64Url(mac)}`;
}

export async function verifyEnrollmentToken(
  options: VerifyEnrollmentTokenOptions,
): Promise<EnrollmentTokenCheck> {
  const verified = await verifySignedPayload(options.token, options.secret, ENROLL_TOKEN_PREFIX);
  if (!verified.ok) return verified;

  const { parsed } = verified;
  if (typeof parsed.u !== 'string' || !parsed.u || typeof parsed.e !== 'number' || !Number.isSafeInteger(parsed.e)) {
    return { ok: false, code: 'malformed' };
  }
  const now = options.nowMs ?? Date.now();
  if (parsed.e <= now) {
    return { ok: false, code: 'expired' };
  }
  if (parsed.u !== options.expectedUserId) {
    return { ok: false, code: 'user_mismatch' };
  }
  return { ok: true, userId: parsed.u, expiresAtMs: parsed.e };
}

export async function createVerifyToken(options: CreateVerifyTokenOptions): Promise<string> {
  if (!options.userId || !options.secret) {
    throw new RangeError('userId and secret are required');
  }
  const now = options.nowMs ?? Date.now();
  const ttl = options.ttlMs ?? DEFAULT_VERIFY_TTL_MS;
  const nonceBytes = crypto.getRandomValues(new Uint8Array(12));
  const body: { u: string; e: number; n: string; i?: string } = {
    u: options.userId,
    e: now + ttl,
    n: toBase64Url(nonceBytes),
  };
  if (options.intentDigest !== undefined) {
    body.i = normalizeDigestB64u(options.intentDigest);
  }
  const payloadB64u = toBase64Url(utf8.encode(JSON.stringify(body)));
  const mac = await hmacSha256(options.secret, `${VERIFY_TOKEN_PREFIX}${payloadB64u}`);
  return `${payloadB64u}.${toBase64Url(mac)}`;
}

export async function verifyVerifyToken(options: VerifyVerifyTokenOptions): Promise<VerifyTokenCheck> {
  const verified = await verifySignedPayload(options.token, options.secret, VERIFY_TOKEN_PREFIX);
  if (!verified.ok) return verified;

  const { parsed } = verified;
  if (typeof parsed.u !== 'string' || !parsed.u || typeof parsed.e !== 'number' || !Number.isSafeInteger(parsed.e)) {
    return { ok: false, code: 'malformed' };
  }
  if (parsed.i !== undefined && (typeof parsed.i !== 'string' || !parsed.i)) {
    return { ok: false, code: 'malformed' };
  }
  const now = options.nowMs ?? Date.now();
  if (parsed.e <= now) {
    return { ok: false, code: 'expired' };
  }
  if (options.expectedUserId !== undefined && parsed.u !== options.expectedUserId) {
    return { ok: false, code: 'user_mismatch' };
  }
  if (parsed.i !== undefined && options.expectedIntentDigest !== undefined) {
    const expectedB64u = normalizeDigestB64u(options.expectedIntentDigest);
    if (parsed.i !== expectedB64u) {
      return { ok: false, code: 'intent_mismatch' };
    }
  }
  return {
    ok: true,
    userId: parsed.u,
    ...(parsed.i !== undefined ? { intentDigestB64u: parsed.i } : {}),
    expiresAtMs: parsed.e,
  };
}

async function verifySignedPayload(
  token: string,
  secret: string,
  prefix: string,
): Promise<
  | { ok: true; parsed: { u?: unknown; e?: unknown; i?: unknown } }
  | { ok: false; code: 'malformed' | 'bad_signature' }
> {
  const parts = token.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, code: 'malformed' };
  }
  const [payloadB64u, sigB64u] = parts;
  const sigBytes = fromBase64Url(sigB64u);
  if (!sigBytes || sigBytes.length !== 32) {
    return { ok: false, code: 'malformed' };
  }

  const expectedMac = await hmacSha256(secret, `${prefix}${payloadB64u}`);
  let diff = 0;
  for (let i = 0; i < 32; i += 1) diff |= expectedMac[i] ^ sigBytes[i];
  if (diff !== 0) {
    return { ok: false, code: 'bad_signature' };
  }

  const payloadBytes = fromBase64Url(payloadB64u);
  if (!payloadBytes) return { ok: false, code: 'malformed' };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as {
      u?: unknown;
      e?: unknown;
      i?: unknown;
    };
    return { ok: true, parsed };
  } catch {
    return { ok: false, code: 'malformed' };
  }
}

function normalizeDigestB64u(digest: Uint8Array | string): string {
  if (typeof digest === 'string') {
    const trimmed = digest.trim();
    if (!trimmed) throw new RangeError('intentDigest cannot be empty');
    return trimmed;
  }
  if (digest.length !== 32) {
    throw new RangeError('intentDigest must be 32 bytes');
  }
  return toBase64Url(digest);
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, utf8.encode(message));
  return new Uint8Array(mac);
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const std = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
    const bin = atob(std);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
