# The grammar tool of seams-console (`txg-text`), linked to one version of `spoken-intent`. It
# serves build-corpus.sh and score-design-a.sh: source this file, then call
#
#   grammar_tool <set> <work-dir>
#
# The first call for a set builds it into <work-dir>/target-<set>. Each call sets $tool (the
# binary) and $bench (the archived `voiceId/stt-bench` folder, with make_audio.py and the
# scorer). The sets, as the seams-console commit and the commit of `crates/spoken-intent`:
# - stt1: 78b05bdb, seams-wallet dfc9e5179. The corpus of the Refactor 210 baseline (2026-11-07).
# - slot: cc8acf90, seams-wallet 3a284a874. The slot rules.
# - forgiving: 679317d5, seams-wallet 976167297. The forgiving rules.
# - today: e76d5b1c, speak-to-sign 8db52c1. Today's grammar and rules: a multisig approval has no
#   challenge words, and the verifier adds the receiver of a multisig transfer to the contacts.
# The clones are $SEAMS_CONSOLE, $SEAMS_WALLET and $SPEAK_TO_SIGN (by default in ~/Dev/rust).
# The build needs cargo with the crates in its cache. It makes no network call.
grammar_tool() {
  case $1 in
    stt1) set -- "$1" "$2" 78b05bdb seams-wallet dfc9e5179 ;;
    slot) set -- "$1" "$2" cc8acf90 seams-wallet 3a284a874 ;;
    forgiving) set -- "$1" "$2" 679317d5 seams-wallet 976167297 ;;
    today) set -- "$1" "$2" e76d5b1c speak-to-sign 8db52c1 ;;
    *) echo "grammar-tool.sh: unknown set $1 (stt1, slot, forgiving or today)" >&2; return 2 ;;
  esac
  case $4 in
    seams-wallet) grammar_crate_clone=${SEAMS_WALLET:-$HOME/Dev/rust/seams-wallet} ;;
    speak-to-sign) grammar_crate_clone=${SPEAK_TO_SIGN:-$HOME/Dev/rust/speak-to-sign} ;;
  esac
  # The tool's Cargo.toml names the crate at ../../../../../<repository>/crates/spoken-intent.
  grammar_src=$2/src-$1
  bench=$grammar_src/seams-console/voiceId/stt-bench
  tool=$2/target-$1/release/txg-text
  [ -x "$tool" ] && return 0
  rm -rf "$grammar_src"
  mkdir -p "$grammar_src/seams-console" "$grammar_src/$4"
  git -C "${SEAMS_CONSOLE:-$HOME/Dev/rust/seams-console}" archive "$3" voiceId/stt-bench/transaction-grammar |
    tar -x -C "$grammar_src/seams-console"
  git -C "$grammar_crate_clone" archive "$5" crates/spoken-intent | tar -x -C "$grammar_src/$4"
  cargo build --release --offline --quiet \
    --manifest-path "$bench/transaction-grammar/grammar/Cargo.toml" --target-dir "$2/target-$1"
}
