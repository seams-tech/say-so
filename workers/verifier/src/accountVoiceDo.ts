/**
 * Per-account SQLite Durable Object (`AccountVoiceDO`).
 *
 * Holds:
 * 1. The 808-byte `SVT1` ReDimNet voice template + epoch (`template` table).
 * 2. Atomic single-use `audio_digest` rows (`used_audio` table) so no recording
 *    can pass or be replayed twice, even across concurrent calls.
 */

export interface StoredVoiceTemplate {
  epoch: number;
  templateSvt1B64: string;
}

export interface VoiceStore {
  getTemplate(owner: string): Promise<StoredVoiceTemplate | null>;
  saveTemplate(owner: string, epoch: number, templateSvt1B64: string): Promise<void>;
  consumeAudioAndGetTemplate(
    owner: string,
    audioDigestB64u: string,
    nowMs: number,
  ): Promise<{ audioReused: boolean; template: StoredVoiceTemplate | null }>;
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
  const stubFor = (owner: string) => ns.get(ns.idFromName(owner));
  return {
    async getTemplate(owner) {
      const res = await stubFor(owner).fetch('https://do/template');
      const data = (await res.json()) as { template: StoredVoiceTemplate | null };
      return data.template;
    },
    async saveTemplate(owner, epoch, templateSvt1B64) {
      await stubFor(owner).fetch('https://do/template', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epoch, templateSvt1B64 }),
      });
    },
    async consumeAudioAndGetTemplate(owner, audioDigestB64u, nowMs) {
      const res = await stubFor(owner).fetch('https://do/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioDigestB64u, nowMs }),
      });
      return (await res.json()) as { audioReused: boolean; template: StoredVoiceTemplate | null };
    },
  };
}
