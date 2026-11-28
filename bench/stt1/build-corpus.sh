#!/bin/sh
# Builds a G1 corpus and its synthetic audio: 250 requests (200 transfers, 50 multisig
# approvals) from seed 210, read by macOS `say` with 6 voices at 160 and 210 words per minute.
#
#   bench/stt1/build-corpus.sh <work-dir> [stt1 | today]
#
# - stt1 (the default): STT-1, as the Refactor 210 baseline of 2026-11-07 had it.
# - today: the same seeded requests in the words of today's `spoken-intent`. The 200 transfers
#   are the sentences of STT-1. The 50 multisig approvals are its proposals with no challenge
#   words, and a verifier version speaks eight check digits, not five.
# grammar-tool.sh names the commits of each.
#
# It writes <work-dir>/corpus.json, <work-dir>/cases.jsonl and <work-dir>/audio/ (about 6,650
# raw f32 files, 1.9 GB). Keep <work-dir> outside the repository. It needs macOS, ffmpeg, cargo
# with the crates of the grammar tool in its cache, and the clones of grammar-tool.sh.
set -eu
work=$1
. "$(dirname "$0")/grammar-tool.sh"
grammar_tool "${2:-stt1}" "$work"
"$tool" corpus 210 "$work/corpus.json"
python3 -I "$bench/transaction-grammar/make_audio.py" "$work/corpus.json" "$work/audio" "$work/cases.jsonl"
