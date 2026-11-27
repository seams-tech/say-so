# @seams/sayso-client

The browser client of the SaySo verifier. It records 16 kHz PCM with an AudioWorklet, streams it to `wss://…/v1/stream` or sends one WAV to `POST /v1/verify`, and checks the signed verdict with [`@seams/sayso-verdict`](https://www.npmjs.com/package/@seams/sayso-verdict).

```sh
npm install @seams/sayso-client
```

```ts
import { SaySoClient } from '@seams/sayso-client';
import { createIntent } from '@seams/sayso-verdict';

const client = new SaySoClient({
  baseUrl: 'https://sayso.example.com',
  verifierPublicKey: SAYSO_PUBLIC_KEY_HEX,
});
const built = await createIntent({ userId, action, payload, sentence });
const { wire, checked } = await client.verifyBatch({
  intent: built.intent,
  wav,
  expectedIntentDigest: built.intentDigest,
  verifyToken, // from your backend: createVerifyToken in @seams/sayso-verdict
});
```

Check the verdict again on your backend before you act on it. The [SaySo README](https://github.com/seams-tech/say-so#readme) describes the verifier and its routes.
