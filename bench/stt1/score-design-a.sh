#!/bin/sh
# Scores transcripts under design A: `spoken-intent` decides the words of a transcript-only
# verdict, with the contacts, as Wallet core and the co-signer will. It uses the scorer of the
# Refactor 210 baseline: `txg-text rulecrate` and `score_whisper_crate.py` of seams-console.
#
#   bench/stt1/score-design-a.sh <work-dir> <transcripts.jsonl> <out-prefix>
#
# <work-dir> is the folder of build-corpus.sh. <transcripts.jsonl> is the output of
# transcribe.ts. The script writes <out-prefix>-slot.json and <out-prefix>-forgiving.json:
# - slot: the slot rules, `spoken-intent` of seams-wallet 3a284a874 with seams-console cc8acf90.
# - forgiving: the forgiving rules, seams-wallet 976167297 with seams-console 679317d5.
# The first run builds each rule set into <work-dir>/target-<name>; it needs cargo with the
# crates in its cache. It makes no network call.
set -eu
work=$1
transcripts=$2
out=$3
console=${SEAMS_CONSOLE:-$HOME/Dev/rust/seams-console}
wallet=${SEAMS_WALLET:-$HOME/Dev/rust/seams-wallet}

# A row of transcribe.ts becomes a row of rulecrate: {caseId, heard}, or {caseId, error}.
node -e '
  const fs = require("node:fs");
  const rows = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map((l) => JSON.parse(l));
  process.stdout.write(rows.map((r) => JSON.stringify(
    typeof r.transcript === "string" ? { caseId: r.caseId, heard: r.transcript }
      : { caseId: r.caseId, error: r.status === "over_8_s" ? "over_8_s" : `stt_${r.status}` },
  )).join("\n") + "\n");
' "$transcripts" > "$out-heard.jsonl"

for set in slot:cc8acf90:3a284a874 forgiving:679317d5:976167297; do
  name=${set%%:*}
  rest=${set#*:}
  console_rev=${rest%%:*}
  wallet_rev=${rest#*:}
  src=$work/src-$name
  tool=$work/target-$name/release/txg-text
  if [ ! -x "$tool" ]; then
    rm -rf "$src"
    mkdir -p "$src/seams-console" "$src/seams-wallet"
    git -C "$console" archive "$console_rev" voiceId/stt-bench/transaction-grammar | tar -x -C "$src/seams-console"
    git -C "$wallet" archive "$wallet_rev" crates/spoken-intent | tar -x -C "$src/seams-wallet"
    cargo build --release --offline --quiet \
      --manifest-path "$src/seams-console/voiceId/stt-bench/transaction-grammar/grammar/Cargo.toml" \
      --target-dir "$work/target-$name"
  fi
  "$tool" rulecrate "$work/corpus.json" "$work/cases.jsonl" "$out-heard.jsonl" "$out-decisions-$name.jsonl"
  (cd "$src/seams-console/voiceId/stt-bench" &&
    python3 -I transaction-grammar/score_whisper_crate.py "$out-decisions-$name.jsonl" "$out-$name.json")
done
