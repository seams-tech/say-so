/**
 * Single-use replay guard for verified SaySo verdicts (`verdict.audio_digest`).
 *
 * Pass a `VerdictReplayGuard` (backed by Redis, Postgres, D1, or `MemoryVerdictReplayGuard`)
 * into `verifyVerdict({ ..., replayGuard })` so the same signed verdict JSON cannot be
 * submitted twice within its 120 s TTL.
 */

export interface VerdictReplayGuard {
  /**
   * Atomically records `audioDigest` if absent until `expiresAtMs`.
   * Returns `true` if this is the first time seeing `audioDigest`, or `false` if replayed.
   */
  consumeOnce(audioDigest: string, expiresAtMs: number): boolean | Promise<boolean>;
}

/**
 * In-memory single-process `VerdictReplayGuard` with automatic expiry pruning.
 * Suitable for single-instance servers and tests; use Redis/SQL for multi-instance backends.
 */
export class MemoryVerdictReplayGuard implements VerdictReplayGuard {
  private readonly seen = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  consumeOnce(audioDigest: string, expiresAtMs: number): boolean {
    const current = this.now();
    for (const [key, exp] of this.seen.entries()) {
      if (exp <= current) this.seen.delete(key);
    }
    if (this.seen.has(audioDigest)) return false;
    this.seen.set(audioDigest, expiresAtMs);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}
