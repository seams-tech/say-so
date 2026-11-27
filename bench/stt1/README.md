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
