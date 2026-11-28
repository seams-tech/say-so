// A control for G3: the Whisper turbo call alone, outside SaySo, through the Workers AI REST
// API from this machine.
//
//   CLOUDFLARE_API_TOKEN=... node bench/g3/pairs.ts <work-dir> <out.json> [pairs] [gap-s]
//
// Sends `pairs` pairs (default 40) of two equal calls at the same time, as the hedged call of
// SaySo does when it starts its second call, with `gap-s` seconds between pairs (default 2.1).
// Each pair has a new `say` recording. The result gives the time of each call, the time of the
// faster call of each pair, and the correlation of the two times of a pair. A hedge helps only
// when one slow call does not make the other slow too. The times include the path from this
// machine to the API, so compare their spread, not their level, with the Worker's `stt` times.
import { mkdirSync, writeFileSync } from 'node:fs';
import { pct, speak } from './voice.ts';

const [work, outPath, pairsArg, gapArg] = process.argv.slice(2);
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? 'ea0d54352cf9d80e962154980504b428';
if (!work || !outPath || !token) throw new Error('usage: CLOUDFLARE_API_TOKEN=... pairs.ts <work-dir> <out.json> [pairs] [gap-s]');
const PAIRS = Number(pairsArg ?? 40);
const GAP_MS = Number(gapArg ?? 2.1) * 1_000;
const URL = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/openai/whisper-large-v3-turbo`;
mkdirSync(work, { recursive: true });

async function once(b64: string): Promise<{ ms: number; ok: boolean; text: string | null }> {
  const started = performance.now();
  const res = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: b64, language: 'en' }),
  });
  const json = (await res.json().catch(() => null)) as { success?: boolean; result?: { text?: string } } | null;
  return { ms: Math.round(performance.now() - started), ok: res.ok && Boolean(json?.success), text: json?.result?.text?.trim() ?? null };
}

const NAMES = ['bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy', 'mallory'];
const rows: Array<{ i: number; audioSeconds: number; a: number; b: number; ok: boolean; text: string | null }> = [];
for (let i = 0; i < PAIRS; i += 1) {
  const started = Date.now();
  const audio = speak(work, `send ${i + 2} near to ${NAMES[i % NAMES.length]} dot testnet`, `pair-${i}`);
  const [a, b] = await Promise.all([once(audio.b64), once(audio.b64)]);
  rows.push({ i, audioSeconds: audio.seconds, a: a.ms, b: b.ms, ok: a.ok && b.ok, text: a.text });
  console.log(`pair ${i}: ${a.ms} ms, ${b.ms} ms ${a.ok && b.ok ? '' : 'FAILED'} ${a.text ?? ''}`);
  await new Promise((r) => setTimeout(r, Math.max(0, GAP_MS - (Date.now() - started))));
}

function correlation(x: number[], y: number[]): number {
  const mx = x.reduce((s, v) => s + v, 0) / x.length;
  const my = y.reduce((s, v) => s + v, 0) / y.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i += 1) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return Number((sxy / Math.sqrt(sxx * syy)).toFixed(3));
}
const ok = rows.filter((r) => r.ok);
const single = ok.flatMap((r) => [r.a, r.b]);
const faster = ok.map((r) => Math.min(r.a, r.b));
const stats = (v: number[]) => ({ p50: pct(v, 50), p95: pct(v, 95), max: v.length ? Math.max(...v) : null });
const summary = {
  pairs: rows.length,
  failed: rows.length - ok.length,
  single: stats(single),
  faster: stats(faster),
  pairCorrelation: correlation(ok.map((r) => r.a), ok.map((r) => r.b)),
  // The first call of each pair against the first call of the pair before it.
  lag1Correlation: correlation(ok.slice(1).map((r) => r.a), ok.slice(0, -1).map((r) => r.a)),
};
writeFileSync(outPath, JSON.stringify({ summary, rows }, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
