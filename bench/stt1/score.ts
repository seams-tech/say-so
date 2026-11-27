// G1 scorer: SaySo's own word check on the STT-1 cases.
//
//   node bench/stt1/score.ts <corpus.json> <cases.jsonl> <transcripts.jsonl | --oracle> <out.json>
//
// transcripts.jsonl holds one {"caseId", "transcript"} per line. With --oracle, each transcript
// is the text that the case speaks (a perfect transcriber).
//
// A correct reading passes when sayso-wasm accepts its transcript for the request's intent. A
// near miss is a false accept when sayso-wasm accepts its transcript for the intent of the
// request that it imitates. Each case runs under two guard policies:
//   values: every word except the template words is guarded (the plan's example guards);
//   all:    every word is guarded, so only an exact match after normalization passes.
import { readFileSync, writeFileSync } from 'node:fs';
import { createIntent } from '../../packages/sayso-verdict/src/index.ts';
import { SaySoCore } from '../../workers/verifier/src/wasm.ts';

const [corpusPath, casesPath, transcriptsArg, outPath] = process.argv.slice(2);
const wasm = await SaySoCore.fromBytes(
  readFileSync(new URL('../../workers/verifier/src/wasm/sayso_wasm.wasm', import.meta.url)),
);

const TEMPLATE_WORDS = new Set([
  'send', 'to', 'approve', 'proposal', 'add', 'remove', 'member', 'set', 'threshold', 'verifier', 'version',
]);
type Policy = 'values' | 'all';
const POLICIES: Policy[] = ['values', 'all'];

interface Request { id: string; kind: string; spoken: string }
interface Case { caseId: string; requestId: string; role: 'correct' | 'near_miss'; missKind: string | null; text: string }

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as { requests: Request[] };
const requests = new Map(corpus.requests.map((r) => [r.id, r]));
const cases = readFileSync(casesPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Case);
const transcripts = new Map<string, string | null>();
if (transcriptsArg === '--oracle') {
  for (const c of cases) transcripts.set(c.caseId, c.text);
} else {
  for (const line of readFileSync(transcriptsArg, 'utf8').trim().split('\n')) {
    const row = JSON.parse(line) as { caseId: string; transcript: string | null };
    transcripts.set(row.caseId, row.transcript);
  }
}

// One intent for each request and policy, or the reason that SaySo refuses the intent.
type Built = { intent: unknown } | { refused: string };
const intents = new Map<string, Built>();
for (const request of corpus.requests) {
  const words = request.spoken.split(' ');
  for (const policy of POLICIES) {
    const guards = words.flatMap((w, i) => (policy === 'all' || !TEMPLATE_WORDS.has(w) ? [i] : []));
    let built: Built;
    try {
      const made = await createIntent({
        userId: 'near:testnet:stt1.testnet',
        action: `seams.near.${request.kind}`,
        payloadSha256: '00'.repeat(32),
        sentence: request.spoken,
        guardedWordIndexes: guards,
      });
      built = { intent: made.intent };
    } catch (error) {
      built = { refused: error instanceof RangeError && /16|speakable/.test(error.message) ? 'over_16_words' : String(error) };
    }
    intents.set(`${request.id}/${policy}`, built);
  }
}

type Tally = { cases: number; accepted: number; intentRefused: number; noTranscript: number };
const blank = (): Tally => ({ cases: 0, accepted: 0, intentRefused: 0, noTranscript: 0 });
const result: Record<string, unknown> = {};
const examples: Record<string, string[]> = {};
for (const policy of POLICIES) {
  const byGroup: Record<string, Tally> = {};
  const add = (group: string, f: (t: Tally) => void) => f((byGroup[group] ??= blank()));
  for (const c of cases) {
    const request = requests.get(c.requestId)!;
    const groups = c.role === 'correct'
      ? ['correct', `correct/${request.kind === 'transfer' ? 'transfer' : 'multisig'}`]
      : ['near_miss', `near_miss/${c.missKind}`];
    const built = intents.get(`${request.id}/${policy}`)!;
    const transcript = transcripts.get(c.caseId);
    let accepted = false;
    let outcome: 'intent' | 'none' | 'checked' = 'checked';
    if ('refused' in built) outcome = 'intent';
    else if (transcript == null || transcript.trim() === '') outcome = 'none';
    else {
      const progress = wasm.call<{ ok: boolean; passes_now?: boolean }>({
        cmd: 'stream_progress',
        intent: built.intent,
        transcript,
      });
      accepted = progress.ok && progress.passes_now === true;
    }
    for (const group of groups) {
      add(group, (t) => {
        t.cases += 1;
        if (accepted) t.accepted += 1;
        if (outcome === 'intent') t.intentRefused += 1;
        if (outcome === 'none') t.noTranscript += 1;
      });
    }
    if (c.role === 'near_miss' && accepted) {
      const list = (examples[`${policy}/${c.missKind}`] ??= []);
      if (list.length < 3) list.push(`want "${request.spoken}" | heard "${transcript}"`);
    }
  }
  result[policy] = byGroup;
}
const overLimit = corpus.requests.filter((r) => 'refused' in intents.get(`${r.id}/all`)!);
const summary = {
  transcripts: transcriptsArg,
  requests: corpus.requests.length,
  cases: cases.length,
  requestsOver16Words: overLimit.length,
  requestsOver16WordsByKind: overLimit.reduce<Record<string, number>>((m, r) => ((m[r.kind] = (m[r.kind] ?? 0) + 1), m), {}),
  policies: result,
  falseAcceptExamples: examples,
};
writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');

for (const policy of POLICIES) {
  const g = result[policy] as Record<string, Tally>;
  const pct = (t: Tally = blank()) =>
    `${t.accepted}/${t.cases} (${t.cases ? ((100 * t.accepted) / t.cases).toFixed(1) : '-'}%)`;
  console.log(`${policy}: correct ${pct(g.correct)}; transfers ${pct(g['correct/transfer'])}; multisig ${pct(g['correct/multisig'])}; intent refused ${(g.correct ?? blank()).intentRefused}; no transcript ${(g.correct ?? blank()).noTranscript}; false accepts ${pct(g.near_miss)}`);
  for (const [group, t] of Object.entries(g)) {
    if (group.startsWith('near_miss/') && t.accepted > 0) console.log(`  false accepts ${group}: ${t.accepted}/${t.cases}`);
  }
}
console.log(`requests over 16 words: ${overLimit.length}`, summary.requestsOver16WordsByKind);
