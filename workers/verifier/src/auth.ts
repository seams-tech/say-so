/**
 * Edge authorization (enrollment + verify/stream HMAC tokens and Bearer API key)
 * and strict CORS origin allowlist helpers.
 */
import { verifyEnrollmentToken, verifyVerifyToken } from '@seams/sayso-verdict';

export interface AuthEnv {
  SAYSO_API_KEY?: string;
  SAYSO_ENROLL_SECRET?: string;
  /** Optional dedicated HMAC secret for `/v1/verify` and `/v1/stream`. Falls back to `SAYSO_ENROLL_SECRET`. */
  SAYSO_AUTH_SECRET?: string;
  SAYSO_DEV_MOCK?: string;
  SAYSO_ALLOWED_ORIGIN?: string;
}

export type EnrollmentAuthResult =
  | { ok: true; method: 'api_key' | 'enroll_token' | 'dev_mock' }
  | { ok: false; status: 401 | 503; reason: string };

export type VerifyAuthResult =
  | {
      ok: true;
      method: 'api_key' | 'verify_token' | 'dev_mock';
      userId?: string;
      intentDigestB64u?: string;
    }
  | { ok: false; status: 401 | 503; reason: string };

function constantTimeEquals(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i += 1) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function matchesBearerApiKey(request: Request, apiKey: string): boolean {
  if (!apiKey) return false;
  const authHeader = request.headers.get('Authorization')?.trim() ?? '';
  if (!authHeader.startsWith('Bearer ')) return false;
  const provided = authHeader.slice('Bearer '.length).trim();
  return constantTimeEquals(provided, apiKey);
}

/**
 * Authorizes `POST /v1/enroll` for `userId`:
 * 1. Valid `Authorization: Bearer <SAYSO_API_KEY>` (server-to-server), OR
 * 2. Valid short-lived HMAC token in `X-SaySo-Enroll-Token` or `enrollment_token` body field
 *    signed with `SAYSO_ENROLL_SECRET` (or `SAYSO_AUTH_SECRET`) and bound to `userId`.
 * 3. In opt-in `SAYSO_DEV_MOCK=true` mode with no secrets set, allows local offline dev.
 * 4. Fails closed in production if no secret is configured (`503`) or credentials fail (`401`).
 */
export async function authorizeEnrollment(params: {
  request: Request;
  userId: string;
  bodyToken?: string;
  env: AuthEnv;
  nowMs?: number;
}): Promise<EnrollmentAuthResult> {
  const apiKey = params.env.SAYSO_API_KEY?.trim() || '';
  const enrollSecret = params.env.SAYSO_ENROLL_SECRET?.trim() || params.env.SAYSO_AUTH_SECRET?.trim() || '';
  const isMock = params.env.SAYSO_DEV_MOCK?.trim().toLowerCase() === 'true';

  if (!apiKey && !enrollSecret) {
    if (isMock) return { ok: true, method: 'dev_mock' };
    return {
      ok: false,
      status: 503,
      reason: 'enrollment_auth_not_configured',
    };
  }

  if (matchesBearerApiKey(params.request, apiKey)) {
    return { ok: true, method: 'api_key' };
  }

  const token =
    params.request.headers.get('X-SaySo-Enroll-Token')?.trim() ||
    params.bodyToken?.trim() ||
    '';
  if (enrollSecret && token) {
    const check = await verifyEnrollmentToken({
      token,
      expectedUserId: params.userId,
      secret: enrollSecret,
      nowMs: params.nowMs,
    });
    if (check.ok) return { ok: true, method: 'enroll_token' };
    return { ok: false, status: 401, reason: `enroll_token_${check.code}` };
  }

  return { ok: false, status: 401, reason: 'unauthorized_enrollment' };
}

/**
 * Authorizes `GET /v1/stream` (before WebSocket upgrade) and `POST /v1/verify`
 * (before Workers AI or SpeakerContainer invocation):
 * 1. Valid `Authorization: Bearer <SAYSO_API_KEY>` (server-to-server), OR
 * 2. Valid short-lived HMAC verify token (`createVerifyToken`) in `X-SaySo-Verify-Token`,
 *    `?token=` query param (for browser `new WebSocket()`), or `verify_token` body field,
 *    signed with `SAYSO_AUTH_SECRET` (or fallback `SAYSO_ENROLL_SECRET`).
 * 3. In opt-in `SAYSO_DEV_MOCK=true` mode with no secrets set, allows local offline dev.
 * 4. Fails closed in production if no secret is configured (`503`) or credentials fail (`401`).
 */
export async function authorizeVerify(params: {
  request: Request;
  expectedUserId?: string;
  expectedIntentDigest?: Uint8Array | string;
  queryToken?: string;
  bodyToken?: string;
  env: AuthEnv;
  nowMs?: number;
}): Promise<VerifyAuthResult> {
  const apiKey = params.env.SAYSO_API_KEY?.trim() || '';
  const verifySecret = params.env.SAYSO_AUTH_SECRET?.trim() || params.env.SAYSO_ENROLL_SECRET?.trim() || '';
  const isMock = params.env.SAYSO_DEV_MOCK?.trim().toLowerCase() === 'true';

  if (!apiKey && !verifySecret) {
    if (isMock) return { ok: true, method: 'dev_mock' };
    return {
      ok: false,
      status: 503,
      reason: 'verify_auth_not_configured',
    };
  }

  if (matchesBearerApiKey(params.request, apiKey)) {
    return { ok: true, method: 'api_key' };
  }

  const token =
    params.request.headers.get('X-SaySo-Verify-Token')?.trim() ||
    params.queryToken?.trim() ||
    params.bodyToken?.trim() ||
    '';
  if (verifySecret && token) {
    const check = await verifyVerifyToken({
      token,
      secret: verifySecret,
      expectedUserId: params.expectedUserId,
      expectedIntentDigest: params.expectedIntentDigest,
      nowMs: params.nowMs,
    });
    if (check.ok) {
      return {
        ok: true,
        method: 'verify_token',
        userId: check.userId,
        ...(check.intentDigestB64u !== undefined ? { intentDigestB64u: check.intentDigestB64u } : {}),
      };
    }
    return { ok: false, status: 401, reason: `verify_token_${check.code}` };
  }

  return { ok: false, status: 401, reason: 'unauthorized_verify' };
}

/**
 * Resolves `Access-Control-Allow-Origin` against a comma-separated allowlist (`SAYSO_ALLOWED_ORIGIN`).
 * Supports `*` for dev or exact origin matching in production.
 */
export function resolveCorsOrigin(request: Request, allowedSetting?: string): string | null {
  const raw = allowedSetting?.trim() || '';
  if (!raw || raw === '*') return '*';
  const reqOrigin = request.headers.get('Origin')?.trim() ?? '';
  if (!reqOrigin) return null;
  const allowlist = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return allowlist.includes(reqOrigin) ? reqOrigin : null;
}
