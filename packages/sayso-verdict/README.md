# @seams/sayso-verdict

Checks a signed SaySo verdict (`sayso_verdict_v1`) and builds the intent that the verdict binds. It has no dependencies and uses only WebCrypto, so it runs in Node, a browser and a Cloudflare Worker.

```sh
npm install @seams/sayso-verdict
```

```ts
import { createIntent, verifyVerdict } from '@seams/sayso-verdict';

const { intent, intentDigest } = await createIntent({
  userId: 'alice@acme.com',
  action: 'bank/transfer',
  payload: JSON.stringify({ to: 'acct_9182', amount_usd: 45 }),
  sentence: 'Send $45 to Bob Miller',
  guardedWordIndexes: [1, 2, 3, 5, 6], // no forgiveness in "forty five dollars" and "bob miller"
});

// Send `intent` to the SaySo verifier with the recording. Then check its answer:
const result = await verifyVerdict({
  verdictJson,
  signatureB64,
  publicKey: SAYSO_PUBLIC_KEY_HEX,
  userId: 'alice@acme.com',
  action: 'bank/transfer',
  intentDigest,
});
if (!result.ok) throw new Error(result.refusal.code);
```

What it gives:

- `createIntent`: the intent, its `intentDigest` and the words that the user must say.
- `verifyVerdict`: the Ed25519 signature, the kind, the outcome, the expiry and each binding that you pass (user, action, intent, spoken text, audio). A `VerdictReplayGuard` makes a verdict single-use.
- `createEnrollmentToken` and `createVerifyToken`: short-lived HMAC tokens that let a browser call the verifier.
- `canonicalWav`, `pcm16ToCanonicalWav` and `audioDigest`: the audio form that the verdict's `audio_digest` covers.

The [SaySo README](https://github.com/seams-tech/say-so#readme) describes the verifier, the guarded words and the digest formats.
