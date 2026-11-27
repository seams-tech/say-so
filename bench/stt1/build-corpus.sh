#!/bin/sh
# Builds the STT-1 corpus and its synthetic audio, as the Refactor 210 baseline of 2026-11-07
# had them: the grammar tool of seams-console 78b05bdb and spoken-intent of seams-wallet
# dfc9e5179, seed 210, macOS `say` with 6 voices at 160 and 210 words per minute.
#
#   bench/stt1/build-corpus.sh <work-dir> [seams-console clone] [seams-wallet clone]
#
# It writes <work-dir>/corpus.json, <work-dir>/cases.jsonl and <work-dir>/audio/ (about 6,650
# raw f32 files, 1.9 GB). Keep <work-dir> outside the repository. It needs macOS, ffmpeg, cargo
# with the crates of the grammar tool in its cache, and the two clones with those commits.
set -eu
work=$1
console=${2:-$HOME/Dev/purin-labs/seams-console}
wallet=${3:-$HOME/Dev/rust/seams-wallet}

mkdir -p "$work/src/seams-console" "$work/src/seams-wallet"
git -C "$console" archive 78b05bdb voiceId/stt-bench/transaction-grammar | tar -x -C "$work/src/seams-console"
git -C "$wallet" archive dfc9e5179 crates/spoken-intent | tar -x -C "$work/src/seams-wallet"

bench=$work/src/seams-console/voiceId/stt-bench
(cd "$bench" && cargo run --release --offline --quiet \
  --manifest-path transaction-grammar/grammar/Cargo.toml --target-dir "$work/target" \
  -- corpus 210 "$work/corpus.json")
python3 -I "$bench/transaction-grammar/make_audio.py" "$work/corpus.json" "$work/audio" "$work/cases.jsonl"
