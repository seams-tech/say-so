// A test variant, not SaySo code: before the word check, write the punctuation of an account
// name as words ("eric.testnet" -> "eric dot testnet", "bob-1" -> "bob dash 1",
// "lab_7" -> "lab underscore 7"), as the Wallet's sentences say them.
//   node bench/stt1/variant.ts <transcripts.jsonl> <out.jsonl>
import { readFileSync, writeFileSync } from 'node:fs';
const [inPath, outPath] = process.argv.slice(2);
const account = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*\.(testnet|near)\.?$/i;
const spell = (word: string) =>
  word.replace(/\.$/, '').replace(/\./g, ' dot ').replace(/-/g, ' dash ').replace(/_/g, ' underscore ')
    .replace(/(\d)/g, ' $1 ').replace(/\s+/g, ' ').trim();
const rows = readFileSync(inPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
writeFileSync(outPath, rows.map((r) => JSON.stringify({
  ...r,
  transcript: r.transcript == null ? null : r.transcript.split(/\s+/).map((w: string) => (account.test(w) ? spell(w) : w)).join(' '),
})).join('\n') + '\n');
console.log('rows', rows.length);
