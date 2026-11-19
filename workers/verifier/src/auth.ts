/**
 * Enrollment authorization and strict CORS origin allowlist helpers.
 */
import { verifyEnrollmentToken } from '@sayso/verdict';

export interface AuthEnv {
  SAYSO_API_KEY?: string;
  SAYSO_ENROLL_SECRET?: string;
  SAYSO_DEV_MOCK?: string;
  SAYSO_ALLOWED_ORIGIN?: string;
}

export type EnrollmentAuthResult =
  | { ok: true; method: 'api_key' | 'enroll_token' | 'dev_mock' }
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

/**
 * Authorizes `POST /v1/enroll` for `userId`:
 * 1. Valid `Authorization: Bearer <SAYSO_API_KEY>` (server-to-server), OR
 * 2. Valid short-lived HMAC token in `X-SaySo-Enroll-Token` or `enrollment_token` body field
 *    signed with `SAYSO_ENROLL_SECRET` and bound to `userId`.
 * 3. In opt-in `SAYSO_DEV_MOCK=true` mode with neither secret set, allows local offline dev.
 * 4. Fails closed in production if neither secret is configured (`503`) or credentials fail (`401`).
 */
export async function authorizeEnrollment(params: {
  request: Request;
  userId: string;
  bodyToken?: string;
  env: AuthEnv;
  nowMs?: number;
}): Promise<EnrollmentAuthResult> {
  const apiKey = params.env.SAYSO_API_KEY?.trim() || '';
  const enrollSecret = params.env.SAYSO_ENROLL_SECRET?.trim() || '';
  const isMock = params.env.SAYSO_DEV_MOCK?.trim().toLowerCase() === 'true';

  if (!apiKey && !enrollSecret) {
    if (isMock) return { ok: true, method: 'dev_mock' };
    return {
      ok: false,
      status: 503,
      reason: 'enrollment_auth_not_configured',
    };
  }

  const authHeader = params.request.headers.get('Authorization')?.trim() ?? '';
  if (apiKey && authHeader.startsWith('Bearer ')) {
    const provided = authHeader.slice('Bearer '.length).trim();
    if (constantTimeEquals(provided, apiKey)) {
      return { ok: true, method: 'api_key' };
    }
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
