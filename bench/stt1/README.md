# Gate G1: SaySo's word check on the STT-1 transaction sentences

G1 asks two numbers of the speech-to-text step: the share of correct readings that SaySo
accepts, and the near misses that it accepts by mistake (false accepts). The baseline is NEAR AI
Whisper large-v3 with the slot rules of `spoken-intent`: 88.4% of correct readings and 0 false
accepts (seams-console `voiceId/stt-bench/reports/stt1-transaction-grammar-whisper-nearai-slots-2026-11-07.md`).

The set: 250 requests (200 transfers, 50 multisig approvals), 3,000 correct readings and 3,742
near misses, read by macOS `say`. The audio is not stored, so `build-corpus.sh` makes it again
from the exact tool and crate versions of the baseline.

## Run

```sh
bench/stt1/build-corpus.sh /tmp/stt1                                  # free, about 40 minutes
node bench/stt1/score.ts /tmp/stt1/corpus.json /tmp/stt1/cases.jsonl --oracle /tmp/stt1/oracle.json
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
  node bench/stt1/transcribe.ts /tmp/stt1/cases.jsonl /tmp/stt1/transcripts.jsonl   # costs money
node bench/stt1/score.ts /tmp/stt1/corpus.json /tmp/stt1/cases.jsonl /tmp/stt1/transcripts.jsonl /tmp/stt1/g1.json
```

- `--oracle` scores the case texts as transcripts: the word check alone, with a perfect
  transcriber.
- `transcribe.ts` calls `@cf/openai/whisper-large-v3-turbo` as the Worker does (a 16-bit WAV in
  base64, `language: "en"`). At $0.000513 per audio minute, the about 490 audio minutes cost
  about $0.25. The first 10,000 neurons (about 214 audio minutes) of each day are free. A case
  longer than the Worker's 8 s cap is not sent, and counts as refused.

## Guard policies

`score.ts` scores each case two times:

- `values`: every word is guarded except the template words (`send`, `to`, `approve`,
  `proposal`, `add`, `remove`, `member`, `set`, `threshold`, `verifier`, `version`).
- `all`: every word is guarded, so only an exact match after normalization passes.

`variant.ts` is a test, not SaySo code. It writes the punctuation of an account name as words
before the check ("eric.testnet" as "eric dot testnet"), to show what such a rule would gain.

## Results of 2026-11-27

`results/` holds the transcripts (6,630 sent, 112 over 8 s) and the three score files. The run
sent 401 audio minutes. The corpus has the SHA-256 prefix `2bac4446cfbe78ff`.

| Text step                                    | Correct readings       | Transfers | Multisig | False accepts |
| -------------------------------------------- | ---------------------- | --------- | -------- | ------------- |
| Baseline (NEAR AI Whisper + slot rules)      | 2,652 of 3,000 (88.4%) | 94.6%     | 63.7%    | 0             |
| Perfect transcripts, every word guarded      | 2,664 of 3,000 (88.8%) | 90.0%     | 84.0%    | 0             |
| Whisper turbo, every word guarded            | 125 of 3,000 (4.2%)    | 2.2%      | 12.0%    | 0             |
| Whisper turbo, values guarded                | 180 of 3,000 (6.0%)    | 2.2%      | 21.2%    | 33            |
| Whisper turbo + `variant.ts`, every word     | 1,410 of 3,000 (47.0%) | 53.8%     | 19.8%    | 5             |

Why SaySo refuses the correct readings:

- Whisper writes an account as "eric.testnet", and SaySo makes one word of it.
- Whisper writes a name that sounds the same in another way: "eric" for "erik". The recipient is
  guarded, so the reading refuses. This was 816 of the refused transfers in the variant.
- Whisper writes digits as a number: "10374" becomes "ten thousand three hundred seventy four",
  but the sentence says "one zero three seven four". It writes "Approved" for "approve".
- SaySo drops the digits of a mixed word: "8888net" becomes "net".
- The 5 false accepts of the variant are sound-alike contacts ("jon" heard as "John"). Only a
  contact list can refuse them.

## Design A: a parser decides the words of a transcript-only verdict

The same transcripts, decided by `spoken-intent` with the contacts (`txg-text rulecrate` and
`score_whisper_crate.py` of seams-console, the scorer of the baseline):

| Transcriber, `spoken-intent` rules              | Correct readings       | Transfers | Multisig | False accepts |
| ----------------------------------------------- | ---------------------- | --------- | -------- | ------------- |
| NEAR AI Whisper large-v3, slot rules (baseline) | 2,652 of 3,000 (88.4%) | 94.6%     | 63.7%    | 0             |
| Workers AI turbo, slot rules (`3a284a874`)      | 2,501 of 3,000 (83.4%) | 90.5%     | 55.8%    | 0             |
| NEAR AI Whisper large-v3, forgiving rules       | 2,733 of 3,000 (91.1%) | 98.0%     | 63.7%    | 0             |
| Workers AI turbo, forgiving rules (`976167297`) | 2,582 of 3,000 (86.1%) | 93.9%     | 55.8%    | 0             |

The commits are of seams-wallet `crates/spoken-intent` (it moved to speak-to-sign on
2026-11-09). The grammar tool is seams-console `cc8acf90` for `3a284a874` and `679317d5` for
`976167297`. To score again, unpack both commits as `build-corpus.sh` does, then run
`txg-text rulecrate <corpus.json> <cases.jsonl> <heard.jsonl> <out.jsonl>`, where each
`heard.jsonl` row is `{"caseId", "heard"}` from the transcripts, and
`score_whisper_crate.py <out.jsonl> <report.json>`. The near misses that these rules accept
are homophones of the true receiver (64 and 107), which the baseline does not count as false
accepts.
