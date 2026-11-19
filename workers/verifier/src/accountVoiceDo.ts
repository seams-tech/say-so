/**
 * Per-user SQLite Durable Object (`AccountVoiceDO`).
 *
 * Holds:
 * 1. The 808-byte `SVT1` ReDimNet voice template + epoch (`template` table).
 * 2. Atomic single-use `audio_digest` rows (`used_audio` table) so no recording
 *    can pass or be replayed twice, even across concurrent calls.
 * 3. Per-user sliding-window rate limits (`rate_events` table) to prevent Workers AI abuse.
 */

export interface StoredVoiceTemplate {
  epoch: number;
  templateSvt1B64: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export interface VoiceStore {
  getTemplate(userId: string): Promise<StoredVoiceTemplate | null>;
  saveTemplate(userId: string, epoch: number, templateSvt1B64: string): Promise<void>;
  consumeAudioAndGetTemplate(
    userId: string,
    audioDigestB64u: string,
    nowMs: number,
  ): Promise<{ audioReused: boolean; template: StoredVoiceTemplate | null }>;
  checkRateLimit?(
    userId: string,
    bucket: string,
    limit: number,
    windowMs: number,
    nowMs: number,
  ): Promise<RateLimitResult>;
}

const AUDIO_RETENTION_MS = 7 * 24 * 3_600_000;

export class AccountVoiceDO {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState) {
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS template (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        epoch INTEGER NOT NULL,
        svt1_b64 TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS used_audio (
        digest_b64u TEXT PRIMARY KEY,
        used_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rate_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bucket TEXT NOT NULL,
        at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rate_bucket_at ON rate_events (bucket, at_ms);
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/template') {
      return Response.json({ template: this.readTemplate() });
    }
    if (request.method === 'PUT' && url.pathname === '/template') {
      const body = (await request.json()) as { epoch: number; templateSvt1B64: string };
      this.sql.exec(
        `INSERT INTO template (id, epoch, svt1_b64, updated_at_ms)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch, svt1_b64 = excluded.svt1_b64, updated_at_ms = excluded.updated_at_ms`,
        body.epoch,
        body.templateSvt1B64,
        Date.now(),
      );
      return Response.json({ ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/consume') {
      const body = (await request.json()) as { audioDigestB64u: string; nowMs: number };
      this.sql.exec(`DELETE FROM used_audio WHERE used_at_ms < ?`, body.nowMs - AUDIO_RETENTION_MS);
      const existing = this.sql
        .exec(`SELECT digest_b64u FROM used_audio WHERE digest_b64u = ?`, body.audioDigestB64u)
        .toArray();
      const audioReused = existing.length > 0;
      if (!audioReused) {
        this.sql.exec(
          `INSERT INTO used_audio (digest_b64u, used_at_ms) VALUES (?, ?)`,
          body.audioDigestB64u,
          body.nowMs,
        );
      }
      return Response.json({ audioReused, template: this.readTemplate() });
    }
    if (request.method === 'POST' && url.pathname === '/rate-limit') {
      const body = (await request.json()) as {
        bucket: string;
        limit: number;
        windowMs: number;
        nowMs: number;
      };
      const cutoff = body.nowMs - body.windowMs;
      this.sql.exec(`DELETE FROM rate_events WHERE bucket = ? AND at_ms <= ?`, body.bucket, cutoff);
      const rows = this.sql
        .exec(`SELECT at_ms FROM rate_events WHERE bucket = ? ORDER BY at_ms ASC`, body.bucket)
        .toArray() as Array<{ at_ms: number }>;
      if (rows.length >= body.limit) {
        const oldest = Number(rows[0].at_ms);
        const retryAfterSec = Math.max(1, Math.ceil((oldest + body.windowMs - body.nowMs) / 1_000));
        return Response.json({ allowed: false, remaining: 0, retryAfterSec });
      }
      this.sql.exec(`INSERT INTO rate_events (bucket, at_ms) VALUES (?, ?)`, body.bucket, body.nowMs);
      return Response.json({
        allowed: true,
        remaining: Math.max(0, body.limit - rows.length - 1),
        retryAfterSec: 0,
      });
    }
    return new Response('Not Found', { status: 404 });
  }

  private readTemplate(): StoredVoiceTemplate | null {
    const rows = this.sql.exec(`SELECT epoch, svt1_b64 FROM template WHERE id = 1`).toArray();
    if (rows.length === 0) return null;
    const row = rows[0] as { epoch: number; svt1_b64: string };
    return { epoch: Number(row.epoch), templateSvt1B64: String(row.svt1_b64) };
  }
}

export function createDurableObjectVoiceStore(ns: DurableObjectNamespace): VoiceStore {
  const stubFor = (userId: string) => ns.get(ns.idFromName(userId));
  return {
    async getTemplate(userId) {
      const res = await stubFor(userId).fetch('https://do/template');
      const data = (await res.json()) as { template: StoredVoiceTemplate | null };
      return data.template;
    },
    async saveTemplate(userId, epoch, templateSvt1B64) {
      await stubFor(userId).fetch('https://do/template', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epoch, templateSvt1B64 }),
      });
    },
    async consumeAudioAndGetTemplate(userId, audioDigestB64u, nowMs) {
      const res = await stubFor(userId).fetch('https://do/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioDigestB64u, nowMs }),
      });
      return (await res.json()) as { audioReused: boolean; template: StoredVoiceTemplate | null };
    },
    async checkRateLimit(userId, bucket, limit, windowMs, nowMs) {
      const res = await stubFor(userId).fetch('https://do/rate-limit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucket, limit, windowMs, nowMs }),
      });
      return (await res.json()) as RateLimitResult;
    },
  };
}
