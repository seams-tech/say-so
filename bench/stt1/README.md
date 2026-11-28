# Gate G1: SaySo's word check on the STT-1 transaction sentences

G1 asks two numbers of the speech-to-text step: the share of correct readings that SaySo
accepts, and the near misses that it accepts by mistake (false accepts). The baseline is NEAR AI
Whisper large-v3 with the slot rules of `spoken-intent`: 88.4% of correct readings and 0 false
accepts (seams-console `voiceId/stt-bench/reports/stt1-transaction-grammar-whisper-nearai-slots-2026-11-07.md`).

The set: 250 requests (200 transfers, 50 multisig approvals), 3,000 correct readings and 3,742
near misses, read by macOS `say`. The audio is not stored, so `build-corpus.sh` makes it again
from the exact tool and crate versions of the baseline. `build-corpus.sh <work-dir> today` makes
the same requests in the words of today's `spoken-intent` ("Today's grammar" below).
`grammar-tool.sh` names the commits of each corpus and rule set.

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
- `STT1_MODEL=nova-3` calls `@cf/deepgram/nova-3` instead, with no options, as the Worker's
  stream calls it. `STT1_NOVA_OPTIONS` sets query options, for example
  `numerals=true&smart_format=true`. It costs $0.0052 per audio minute, about $2.10 for the set.
- `STT1_PROMPT=<file>` sends the text of the file as Whisper's `initial_prompt`.
- `score-design-a.sh <work-dir> <transcripts.jsonl> <out-prefix>` scores transcripts under design
  A (below), with three rule sets: slot, forgiving and today. It builds the scorers on its first
  run. It reads either corpus.
- Workers AI calls of one account share its capacity. Do not run a transcription and a time
  measurement (`bench/g3`) at the same time.

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
`976167297`. `score-design-a.sh` runs both. The near misses that these rules accept are
homophones of the true receiver (64 and 107), which the baseline does not count as false
accepts.

The multisig sentences of STT-1 end with two challenge words, which today's `spoken-intent` does
not have. "Today's grammar" below measures the sentences of today.

## Other transcribers (2026-11-27)

The same 6,630 clips, or a part of them:

| Transcriber                                  | Design A, slot | Design A, forgiving | False accepts (A) | SaySo, every word | False accepts (SaySo) |
| -------------------------------------------- | -------------- | ------------------- | ----------------- | ----------------- | --------------------- |
| Whisper turbo (above)                        | 83.4%          | 86.1%               | 0 and 0           | 4.2%              | 0                     |
| Nova-3, `numerals` and `smart_format`        | 45.5%          | 60.2%               | 6 and 9           | 25.4%             | 8                     |
| Nova-3, no options                           | 62.1%          | 80.7%               | 0 and 0           | 33.7%             | 8                     |

- **Nova-3 with `numerals` drops a spoken "point".** "nine hundred sixty two point one" becomes
  "9621", which pays a request for 9,621. All the false accepts under design A (6 and 9) are
  such moved decimal points. SaySo's word check reads "9621" as the request's words too. On this set the
  account words refused those readings ("test net"), but a clean account reading would pass. So
  the Worker's stream sends no options since this run.
- The 8 false accepts of SaySo's word check with Nova-3 are sound-alike contacts, as with turbo
  and the punctuation variant.
- **A contact prompt makes turbo worse.** The 60 contacts in `initial_prompt` (results/
  `2026-11-27-contacts-prompt.txt`) took a clip from 1.27 s to 3.06 s and changed "eight thousand
  eight hundred eighty eight" to "88888". On the 803 correct readings of the first 67 requests it
  accepted 66.5% (slot) and 67.6% (forgiving), against 89.2% and 93.4% without the prompt, with
  no false accept in either. The run stopped there.
- The transcripts and score files are in `results/` (`nova-3`, `nova-3-words`,
  `whisper-large-v3-turbo-contacts-prompt`).

## Today's grammar (2026-11-28)

`build-corpus.sh <work-dir> today` builds the corpus with the grammar tool of seams-console
`e76d5b1c` and `spoken-intent` of speak-to-sign `8db52c1`:

- **The requests are those of STT-1.** The tool keeps the seeded draws, so seed 210 gives the same
  200 transfer sentences and the same 50 proposals. A multisig approval has no challenge words now,
  and a verifier version speaks eight check digits, not five. The swapped-challenge near miss is
  gone, so the set has 3,000 correct readings and 3,642 near misses (6,642 cases). The corpus file
  has the SHA-256 prefix `ef022ed3b47c8744`.
- **The audio.** 5,415 of the 5,502 transfer clips are byte for byte the clips of STT-1. macOS
  `say` gave other audio for the other 87 on 2026-11-28 (Daniel, Karen, Rishi, Moira, Tessa). In
  a test of three runs on one day, it gave the same audio each time. So the text of a corpus is
  exact, and its audio is exact only with the same voice files.
- **Today's rules** (`score-design-a.sh`, set `today`) give a multisig transfer the contacts of its
  receiver, as the verifier does (`known_accounts`), and its row the receiver fields of the
  scorer's homophone rule. The other multisig kinds read no contacts, as before.

The run sent 6,560 clips (387 audio minutes, about $0.20); 82 are longer than 8 s. Design A:

| Corpus, rules                          | Correct readings           | Transfers              | Multisig (of sent) | False accepts  |
| -------------------------------------- | -------------------------- | ---------------------- | ------------------ | -------------- |
| STT-1, slot (`3a284a874`)              | 2,501 of 3,000 (83.4%)     | 2,173 of 2,400 (90.5%) | 328 of 588 (55.8%) | 0 of 3,742     |
| STT-1, forgiving (`976167297`)         | 2,582 of 3,000 (86.1%)     | 2,254 of 2,400 (93.9%) | 328 of 588 (55.8%) | 0 of 3,742     |
| STT-1, today's rules (`8db52c1`)       | 2,597 of 3,000 (86.6%)     | 2,269 of 2,400 (94.5%) | 328 of 588 (55.8%) | 0 of 3,742     |
| Today's corpus, slot                   | 2,541 of 3,000 (84.7%)     | 2,187 of 2,400 (91.1%) | 354 of 597 (59.3%) | 0 of 3,642     |
| Today's corpus, forgiving              | 2,619 of 3,000 (87.3%)     | 2,265 of 2,400 (94.4%) | 354 of 597 (59.3%) | 0 of 3,642     |
| **Today's corpus, today's rules**      | **2,668 of 3,000 (88.9%)** | 2,279 of 2,400 (95.0%) | 389 of 597 (65.2%) | **0 of 3,642** |
| Today's corpus, perfect transcripts    | 2,997 of 3,000 (99.9%)     | 2,400 of 2,400         | 597 of 597         | 0 of 3,642     |

- **G1 passes as written, by a small margin.** Today's rules read 2,668 correct readings; the
  baseline is 2,652 (88.4%). The margin is 16 readings (0.5 points).
- **The two sets compare.** On the same audio, turbo gives the same decisions: on the 5,415
  byte-identical transfer clips, 3 transcripts and no decision differ from the run of
  2026-11-27. The transfer change (+10 with today's rules) comes from the 87 clips with new audio.
- **The multisig gain has two parts.** With no challenge words, the forgiving rules go from 328 to
  354: Whisper often heard the two challenge words in another way ("fork and needle" for "falcon
  needle"), and 9 more clips are 8 s or shorter. The contacts of a multisig transfer add 35 more (54 to 89 of 117 multisig transfers),
  because the recipient step now matches the receiver by sound.
- The accepted near misses (65, 108 and 122) are homophones of the true receiver. The scorer does
  not count them as false accepts, as for the baseline.
- The score files keep the `model` and `date` strings of the 2026-11-07 scorer; they are not the
  run's model and date.

What today's rules still refuse (correct multisig readings, today's rules):

| Kind                  | Accepted   | The most common cause                                                  |
| --------------------- | ---------- | ---------------------------------------------------------------------- |
| Add member            | 8 of 120   | "Ad Member" or "at Member" for "add member"                            |
| Remove member         | 65 of 120  | A sound-alike name ("Parole", "Eric") or network ("TestNut"): a member sentence has no recipient step |
| Multisig transfer     | 89 of 117  | "and" or "cent" for "send", a joined "to" ("Tvalt")                    |
| Set threshold         | 110 of 120 | "2-2" for "to two"                                                     |
| Set verifier version  | 117 of 120 | "115 54062": digits in two groups                                      |

- **A test variant, not today's rules:** the transcripts with each whole word "ad" written as
  "add" read 2,701 of 3,000 (90.0%), add member 41 of 120, with 0 false accepts
  (`2026-11-28-today-g1-turbo-ad-variant.json`).
- **SaySo's 16-word limit holds for a transcript-only intent too.** SaySo refuses the intent of 32
  requests (20 transfers, 5 multisig transfers, 7 verifier versions): 384 correct readings. With
  that limit, today's rules read 2,311 of 3,000 (77.0%), or 2,311 of the 2,616 readings that SaySo
  takes (88.3%). The baseline did not have this limit. STT-1 had 28 such requests.

Files in `results/`: `2026-11-28-today-whisper-large-v3-turbo-transcripts.jsonl.gz`,
`2026-11-28-today-g1-turbo-{slot,forgiving,today}.json`, `2026-11-28-today-g1-oracle-today.json`,
`2026-11-28-today-g1-turbo-ad-variant.json` and `2026-11-28-stt1-g1-turbo-today.json` (STT-1 with
today's rules).
