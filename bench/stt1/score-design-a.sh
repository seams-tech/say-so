#!/bin/sh
# Scores transcripts under design A: `spoken-intent` decides the words of a transcript-only
# verdict, with the contacts, as Wallet core and the co-signer will. It uses the scorer of the
# Refactor 210 baseline: `txg-text rulecrate` and `score_whisper_crate.py` of seams-console.
#
#   bench/stt1/score-design-a.sh <work-dir> <transcripts.jsonl> <out-prefix>
#
# <work-dir> is the folder of build-corpus.sh, with either corpus. <transcripts.jsonl> is the
# output of transcribe.ts. The script writes <out-prefix>-<set>.json for three rule sets of
# grammar-tool.sh: slot, forgiving and today. It makes no network call.
set -eu
work=$1
transcripts=$2
out=$3
# The scorer runs in the tool folder, so the output prefix must not be relative.
case $out in /*) ;; *) out=$PWD/$out ;; esac
. "$(dirname "$0")/grammar-tool.sh"

# A row of transcribe.ts becomes a row of rulecrate: {caseId, heard}, or {caseId, error}.
node -e '
  const fs = require("node:fs");
  const rows = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map((l) => JSON.parse(l));
  process.stdout.write(rows.map((r) => JSON.stringify(
    typeof r.transcript === "string" ? { caseId: r.caseId, heard: r.transcript }
      : { caseId: r.caseId, error: r.status === "over_8_s" ? "over_8_s" : `stt_${r.status}` },
  )).join("\n") + "\n");
' "$transcripts" > "$out-heard.jsonl"

for name in slot forgiving today; do
  grammar_tool "$name" "$work"
  "$tool" rulecrate "$work/corpus.json" "$work/cases.jsonl" "$out-heard.jsonl" "$out-decisions-$name.jsonl"
  (cd "$bench" && python3 -I transaction-grammar/score_whisper_crate.py "$out-decisions-$name.jsonl" "$out-$name.json")
done
