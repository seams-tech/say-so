# SaySo

Nothing moves without your say-so.

SaySo is a standalone, zero-Web3, Cloudflare-native spoken-intent authorization library. A user authorizes one exact action—an AI-agent payout, a production deployment, a database reset, or any API call—by saying the canonical sentence aloud.

SaySo checks **who spoke** (ReDimNet B1 192-float speaker template) and **which words were spoken** (spoken-English normalization with strict negation and number guards), then signs a compact 12-field Ed25519 JSON verdict (`sayso_verdict_v1`) bound to `user_id`, `action`, `intent_digest` (SHA-256 of your payload + sentence), and `audio_digest` (single-use canonical WAV SHA-256).

Any backend verifies the verdict with standard WebCrypto Ed25519 via `@sayso/verdict` (zero dependencies).

## Architecture

```mermaid
flowchart LR
  Mic["Browser AudioWorklet<br/>16 kHz mono PCM16"]
  Worker["Cloudflare Worker<br/>+ sayso-wasm (188 KB)"]
  Nova["Workers AI<br/>@cf/deepgram/nova-3 WS"]
  Speaker["Cloudflare Container<br/>ReDimNet B1 AVX2 (scale-to-zero)"]
  DO["SQLite Durable Object<br/>AccountVoiceDO (SVT1 + Replay + Rate Limit)"]
  Sign["WebCrypto Ed25519<br/>sayso_verdict_v1"]

  Mic -->|"wss:///v1/stream live PCM"| Worker
  Worker -->|"live PCM frames"| Nova
  Worker -->|"canonical WAV"| Speaker
  Worker -->|"0-RTT SQLite"| DO
  Worker --> Sign
```

## Verifying a Verdict & Minting Enrollment Tokens (`@sayso/verdict`)

```ts
import {
  createEnrollmentToken,
  createIntent,
  MemoryVerdictReplayGuard,
  verifyVerdict,
} from '@sayso/verdict';

// 1. Mint a short-lived enrollment token on your authenticated backend so the browser
//    can enroll `alice@acme.com` directly with the SaySo Worker:
const enrollmentToken = await createEnrollmentToken({
  userId: 'alice@acme.com',
  secret: process.env.SAYSO_ENROLL_SECRET!,
});

// 2. Verify a signed verdict on your backend (with single-use replay protection):
const replayGuard = new MemoryVerdictReplayGuard(); // or Redis/SQL VerdictReplayGuard
const { intentDigest } = await createIntent({
  userId: 'alice@acme.com',
  action: 'stripe/payout',
  payload: JSON.stringify({ recipient: 'acct_9182', amount_usd: 45 }),
  sentence: 'Approve payout $45',
});

const result = await verifyVerdict({
  verdictJson,
  signatureB64,
  publicKey: process.env.SAYSO_PUBLIC_KEY_HEX!,
  userId: 'alice@acme.com',
  action: 'stripe/payout',
  intentDigest,
  replayGuard,
});

if (!result.ok) throw new Error(result.refusal.code);
```

## Quick Start

```bash
pnpm install
pnpm test
pnpm typecheck
```

### One-Command Offline Local UI Testing (`SAYSO_DEV_MOCK=true`)

```bash
cp workers/verifier/.dev.vars.example workers/verifier/.dev.vars
pnpm dev   # Launches Worker (:8787, local mock mode) + Demo (:5179) together
```

### Deploy to Cloudflare

```bash
cd workers/verifier
# 1. Verdict Ed25519 signing seed (required; Worker fails closed in production if unset):
openssl rand -hex 32 | npx wrangler secret put VERDICT_SECRET_KEY_HEX
# 2. Enrollment auth secret (for short-lived HMAC browser enrollment tokens):
openssl rand -hex 32 | npx wrangler secret put SAYSO_ENROLL_SECRET
# (Optional) Server-to-server Bearer API key for proxied enrollments:
openssl rand -hex 32 | npx wrangler secret put SAYSO_API_KEY
# 3. Deploy Worker + SQLite AccountVoiceDO + scale-to-zero SpeakerContainer:
npx wrangler deploy
```

> To host `redimnet-b1.onnx` in your own R2 bucket or GitHub Release, override `MODEL_URL` in [`crates/speaker-service/Dockerfile`](crates/speaker-service/Dockerfile); the SHA-256 pin (`e04dd7a6a1e23fc7b89e47682ea9d0a3946cf7bc59d07922c3db3efc52ae4269`) is verified at both image build and container boot.
