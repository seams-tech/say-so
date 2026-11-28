// G1 transcriber: a Workers AI speech model, called as the SaySo Worker calls it
// (`workers/verifier/src/stt.ts`).
//
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node bench/stt1/transcribe.ts <cases.jsonl> <out.jsonl> [limit]
//
// STT1_MODEL picks the model:
// - `turbo` (default): `@cf/openai/whisper-large-v3-turbo` as transcribeBatch calls it, a base64
//   canonical WAV with language "en". STT1_PROMPT names a text file whose text goes in
//   `initial_prompt`.
// - `nova-3`: `@cf/deepgram/nova-3`, sent as one WAV file. STT1_NOVA_OPTIONS holds its query
//   options; the default is none, as the Worker's stream sends. The run of 2026-11-27 with
//   `numerals=true&smart_format=true` is in results/.
//
// Each audio file is raw f32 mono 16 kHz (make_audio.py). It becomes the 16-bit WAV that the
// browser client sends. A case longer than SaySo's 8 s cap is not sent: the Worker refuses it
// as audio_invalid. The script skips cases that are in <out.jsonl> already, so it can resume.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { pcm16ToCanonicalWav } from '../../packages/sayso-verdict/src/index.ts';

const [casesPath, outPath, limitArg] = process.argv.slice(2);
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required');
const MAX_SAMPLES = 8 * 16_000;
const CONCURRENCY = Number(process.env.STT1_CONCURRENCY ?? 6);
const MODEL = process.env.STT1_MODEL ?? 'turbo';
if (MODEL !== 'turbo' && MODEL !== 'nova-3') throw new Error(`STT1_MODEL must be turbo or nova-3, not ${MODEL}`);
const PROMPT = process.env.STT1_PROMPT ? readFileSync(process.env.STT1_PROMPT, 'utf8').trim() : undefined;
if (PROMPT && MODEL !== 'turbo') throw new Error('STT1_PROMPT works only with turbo');
const NOVA_OPTIONS = process.env.STT1_NOVA_OPTIONS ?? '';
const RUN = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run`;
const URL = MODEL === 'turbo'
  ? `${RUN}/@cf/openai/whisper-large-v3-turbo`
  : `${RUN}/@cf/deepgram/nova-3?language=en${NOVA_OPTIONS ? `&${NOVA_OPTIONS}` : ''}`;

interface Case { caseId: string; audio: string }
const done = new Set<string>();
if (existsSync(outPath)) {
  for (const line of readFileSync(outPath, 'utf8').split('\n')) if (line) done.add(JSON.parse(line).caseId);
}
let todo = readFileSync(casesPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Case)
  .filter((c) => !done.has(c.caseId));
if (limitArg) todo = todo.slice(0, Number(limitArg));

function wavBase64(f32Path: string): { b64: string; samples: number } {
  const raw = readFileSync(f32Path);
  const floats = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const pcm = new Int16Array(floats.length);
  for (let i = 0; i < floats.length; i += 1) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(floats[i] * 32767)));
  if (pcm.length > MAX_SAMPLES) return { b64: '', samples: pcm.length };
  return { b64: Buffer.from(pcm16ToCanonicalWav(pcm)).toString('base64'), samples: pcm.length };
}

interface RunBody {
  success?: boolean;
  result?: { text?: string; results?: { channels?: { alternatives?: { transcript?: string }[] }[] } };
}

function request(b64: string): RequestInit {
  if (MODEL === 'nova-3') {
    return {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'audio/wav' },
      body: Buffer.from(b64, 'base64'),
    };
  }
  return {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: b64, language: 'en', ...(PROMPT ? { initial_prompt: PROMPT } : {}) }),
  };
}

async function transcribe(b64: string): Promise<{ text: string | null; status: number }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // A network error (a reset or a read timeout) is retried as a 5xx answer is.
    const res = await fetch(URL, request(b64)).catch(() => null);
    if (!res || res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
      continue;
    }
    const body = (await res.json()) as RunBody;
    const text = MODEL === 'nova-3'
      ? body.result?.results?.channels?.[0]?.alternatives?.[0]?.transcript
      : body.result?.text;
    return { text: body.success ? text?.trim() || null : null, status: res.status };
  }
  return { text: null, status: 0 };
}

let next = 0;
let written = 0;
let audioSeconds = 0;
async function worker(): Promise<void> {
  while (next < todo.length) {
    const c = todo[next++];
    const { b64, samples } = wavBase64(c.audio);
    const row = b64
      ? { caseId: c.caseId, seconds: samples / 16_000, ...(await transcribe(b64)) }
      : { caseId: c.caseId, seconds: samples / 16_000, text: null, status: 'over_8_s' };
    if (b64) audioSeconds += samples / 16_000;
    appendFileSync(outPath, JSON.stringify({ caseId: row.caseId, transcript: row.text, seconds: row.seconds, status: row.status }) + '\n');
    written += 1;
    if (written % 250 === 0) console.log(`${written}/${todo.length}, ${(audioSeconds / 60).toFixed(1)} audio min sent`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`done: ${written} cases, ${(audioSeconds / 60).toFixed(1)} audio minutes sent`);
