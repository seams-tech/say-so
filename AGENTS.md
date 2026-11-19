# SaySo: Guide for AI Agents

SaySo is the Cloudflare-native spoken-intent authorization repository (`Workers` + `Workers AI @cf/deepgram/nova-3` WebSocket + pure scale-to-zero `Cloudflare Containers ReDimNet B1` + `SQLite Durable Objects`).

## Key Invariants

1. **Wire compatibility with Speak-to-Sign (`seams_voice_signed_verdict_v2`):**
   - `crates/sayso-wasm/src/verdict.rs` signs `SHA-256("seams:outlayer:voice-verdict:v2" || verdict_json)` over the exact 13-field JSON layout checked by `crates/voice-verdict` and `packages/voice-verdict`.
   - Voice templates use the 808-byte `SVT1` binary layout (`crates/sayso-wasm/src/embedding.rs`) with `REDIMNET_SHA256_HEX = e04dd7a6a1e23fc7b89e47682ea9d0a3946cf7bc59d07922c3db3efc52ae4269` and cutoff `0.45` (`450` milli).
2. **Never trust client-computed speaker embeddings or transcripts in production:**
   - `mock_transcript` frames and spectral fallback embeddings are active ONLY when `SAYSO_DEV_MOCK === 'true'`, which tags verdicts `"verifier": "sayso/0.1.0+mock"`.
3. **Rebuild WASM after editing Rust:**
   - Run `pnpm build:wasm` whenever `crates/spoken-intent` or `crates/sayso-wasm` changes so `workers/verifier/src/wasm/sayso_wasm.wasm` stays in sync.
4. **Verify all checks:**
   - Run `pnpm test && pnpm typecheck` from the root.
