# SaySo: Guide for AI Agents

SaySo is a standalone, zero-Web3 Cloudflare-native spoken-intent authorization library (`Workers` + `Workers AI @cf/deepgram/nova-3` WebSocket + pure scale-to-zero `Cloudflare Containers ReDimNet B1` + SQLite `AccountVoiceDO`).

## Key Invariants

1. **Zero chain / Web3 dependencies:**
   - No NEAR, Borsh, Base58, OutLayer, or blockchain SDKs anywhere in the repo.
   - `sayso_verdict_v1` is a 12-field JSON object signed with standard Ed25519 over `SHA-256("sayso:verdict:v1" || verdict_json)` and verified via WebCrypto (`@seams/sayso-verdict`).
2. **Never trust client-computed speaker embeddings or transcripts in production:**
   - `mock_transcript` frames and spectral fallback embeddings are active ONLY when `SAYSO_DEV_MOCK === 'true'`, which tags verdicts `"verifier": "sayso/0.2.0+mock"`.
3. **Rebuild WASM after editing Rust:**
   - Run `pnpm build:wasm` whenever `crates/sayso-wasm` changes so `workers/verifier/src/wasm/sayso_wasm.wasm` stays in sync.
4. **Verify all checks:**
   - Run `pnpm test && pnpm typecheck` from the root.
