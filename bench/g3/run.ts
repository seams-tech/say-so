// G3: the time of SaySo's verify step on a lane, warm and with a cold speaker container.
//
//   SAYSO_API_KEY=... node bench/g3/run.ts <probe-url> <work-dir> <out.json> [warm] [cold] [idle-s]
//
// The probe Worker (bench/g3/probe) calls the lane's SaySo Worker through a service binding, as
// the Gateway does, and returns the time of that call. The voice is macOS `say` (Samantha), so
// no recording of a person leaves this machine. The script enrolls a new test user with three
// recordings, then sends `warm` verifies (default 40), then `cold` verifies (default 5), each
// after `idle-s` seconds with no request (default 300; the container sleeps after 3 minutes).
// Each verify is a transcript-only intent with its own sentence, so each recording is new.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createIntent, pcm16ToCanonicalWav } from '../../packages/sayso-verdict/src/index.ts';

const [probe, work, outPath, warmArg, coldArg, idleArg] = process.argv.slice(2);
const apiKey = process.env.SAYSO_API_KEY;
if (!probe || !work || !outPath || !apiKey) throw new Error('usage: SAYSO_API_KEY=... run.ts <probe-url> <work-dir> <out.json> [warm] [cold] [idle-s]');
const WARM = Number(warmArg ?? 40);
const COLD = Number(coldArg ?? 5);
const IDLE_MS = Number(idleArg ?? 300) * 1_000;
// The Worker allows 30 verifies a minute for one user.
const MIN_GAP_MS = 2_100;
const VOICE = 'Samantha';
mkdirSync(work, { recursive: true });

function speak(text: string, name: string): { b64: string; seconds: number } {
  const aiff = `${work}/${name}.aiff`;
  execFileSync('say', ['-v', VOICE, '-r', '180', '-o', aiff, text]);
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', aiff, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  return { b64: Buffer.from(pcm16ToCanonicalWav(pcm)).toString('base64'), seconds: pcm.length / 16_000 };
}

async function call(path: string, body: unknown): Promise<{ status: number; clientMs: number; bindingMs: number; json: any }> {
  const started = performance.now();
  const res = await fetch(new URL(path, probe), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const clientMs = Math.round(performance.now() - started);
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, clientMs, bindingMs: Number(res.headers.get('X-SaySo-Binding-Ms') ?? NaN), json };
}

const userId = `near:testnet:g3-${randomBytes(4).toString('hex')}.testnet`;
const enrollAudio = [
  'my voice approves the payments of this wallet',
  'please remember how i sound when i speak',
  'this is the third recording of my voice',
].map((text, i) => speak(text, `enroll-${i}`).b64);
const enroll = await call('/v1/enroll', { user_id: userId, audio_wav_b64: enrollAudio });
console.log(`enroll: ${enroll.status} ${enroll.json?.outcome ?? ''} ${enroll.json?.reason ?? ''} agreement ${enroll.json?.agreement_milli ?? '-'} ${enroll.clientMs} ms`);
if (enroll.json?.outcome !== 'accept') throw new Error(`enroll refused: ${JSON.stringify(enroll.json)}`);

const NAMES = ['bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy', 'mallory'];
interface Sample {
  kind: 'warm' | 'cold';
  i: number;
  status: number;
  outcome: string | null;
  reason: string | null;
  heard: string | null;
  audioSeconds: number;
  clientMs: number;
  bindingMs: number;
  serverMs: Record<string, number>;
}
const samples: Sample[] = [];

async function verify(kind: Sample['kind'], i: number): Promise<void> {
  const sentence = `send ${i + 2} near to ${NAMES[i % NAMES.length]} dot testnet`;
  const { intent } = await createIntent({
    userId,
    action: 'seams.near.transfer',
    payloadSha256: randomBytes(32),
    sentence,
    transcriptOnly: true,
  });
  const audio = speak(sentence, `${kind}-${i}`);
  const r = await call('/v1/verify', { intent, audio_wav_b64: audio.b64 });
  let verdict: any = {};
  try { verdict = JSON.parse(r.json?.verdict_json ?? '{}'); } catch { /* recorded as null below */ }
  const sample: Sample = {
    kind,
    i,
    status: r.status,
    outcome: verdict.outcome ?? null,
    reason: verdict.reason ?? r.json?.error ?? null,
    heard: verdict.heard ?? null,
    audioSeconds: audio.seconds,
    clientMs: r.clientMs,
    bindingMs: r.bindingMs,
    serverMs: r.json?.ms ?? {},
  };
  samples.push(sample);
  console.log(`${kind} ${i}: ${sample.status} ${sample.outcome} ${sample.reason ?? ''} client ${sample.clientMs} ms, binding ${sample.bindingMs} ms, server ${JSON.stringify(sample.serverMs)}`);
}

for (let i = 0; i < WARM; i += 1) {
  const started = Date.now();
  await verify('warm', i);
  await new Promise((r) => setTimeout(r, Math.max(0, MIN_GAP_MS - (Date.now() - started))));
}
for (let i = 0; i < COLD; i += 1) {
  await new Promise((r) => setTimeout(r, IDLE_MS));
  await verify('cold', WARM + i);
}

function pct(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
const summary = Object.fromEntries(
  (['warm', 'cold'] as const).map((kind) => {
    const of = samples.filter((s) => s.kind === kind);
    const stats = (key: 'clientMs' | 'bindingMs') => {
      const v = of.map((s) => s[key]).filter(Number.isFinite);
      return { p50: pct(v, 50), p95: pct(v, 95), max: v.length ? Math.max(...v) : null };
    };
    return [kind, { n: of.length, accepted: of.filter((s) => s.outcome === 'accept').length, client: stats('clientMs'), binding: stats('bindingMs') }];
  }),
);
writeFileSync(outPath, JSON.stringify({ probe: new URL(probe).host, userId, voice: VOICE, enroll: { status: enroll.status, agreement_milli: enroll.json?.agreement_milli, clientMs: enroll.clientMs, bindingMs: enroll.bindingMs, serverMs: enroll.json?.ms }, summary, samples }, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
