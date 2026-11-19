/**
 * Short-lived HMAC-SHA256 enrollment tokens (`<base64url(payload)>.<base64url(mac)>`)
 * minted by an application backend so browsers can call `POST /v1/enroll` directly
 * without ever exposing a server API key or allowing arbitrary `user_id` overwrites.
 */

const utf8 = new TextEncoder();
const TOKEN_PREFIX = 'sayso:enroll-token:v1:';
const DEFAULT_TTL_MS = 300_000; // 5 minutes

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

export async function createEnrollmentToken(options: CreateEnrollmentTokenOptions): Promise<string> {
  if (!options.userId || !options.secret) {
    throw new RangeError('userId and secret are required');
  }
  const now = options.nowMs ?? Date.now();
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const nonceBytes = crypto.getRandomValues(new Uint8Array(12));
  const payload = JSON.stringify({
    u: options.userId,
    e: now + ttl,
    n: toBase64Url(nonceBytes),
  });
  const payloadB64u = toBase64Url(utf8.encode(payload));
  const mac = await hmacSha256(options.secret, `${TOKEN_PREFIX}${payloadB64u}`);
  return `${payloadB64u}.${toBase64Url(mac)}`;
}

export async function verifyEnrollmentToken(
  options: VerifyEnrollmentTokenOptions,
): Promise<EnrollmentTokenCheck> {
  const parts = options.token.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, code: 'malformed' };
  }
  const [payloadB64u, sigB64u] = parts;
  const sigBytes = fromBase64Url(sigB64u);
  if (!sigBytes || sigBytes.length !== 32) {
    return { ok: false, code: 'malformed' };
  }

  const expectedMac = await hmacSha256(options.secret, `${TOKEN_PREFIX}${payloadB64u}`);
  let diff = 0;
  for (let i = 0; i < 32; i += 1) diff |= expectedMac[i] ^ sigBytes[i];
  if (diff !== 0) {
    return { ok: false, code: 'bad_signature' };
  }

  const payloadBytes = fromBase64Url(payloadB64u);
  if (!payloadBytes) return { ok: false, code: 'malformed' };
  let parsed: { u?: unknown; e?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as { u?: unknown; e?: unknown };
  } catch {
    return { ok: false, code: 'malformed' };
  }
  if (typeof parsed.u !== 'string' || typeof parsed.e !== 'number' || !Number.isSafeInteger(parsed.e)) {
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
