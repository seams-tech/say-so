# Gate G3: the time of the verify step on a lane

G3 asks for the time of SaySo's verify step on a lane: p95 of 4 s or less, also when the
speaker container starts cold. A lane's SaySo Worker has no public route. Its Gateway calls it
through a service binding. So the run uses a short-lived probe Worker with the same kind of
binding.

## Run

```sh
cd workers/verifier
npx wrangler deploy -c ../../bench/g3/probe/wrangler.jsonc    # prints the probe URL
cd ../..
SAYSO_API_KEY=... node bench/g3/run.ts <probe-url> target/g3 target/g3/result.json 40 5 300
cd workers/verifier && npx wrangler delete -c ../../bench/g3/probe/wrangler.jsonc
```

- `SAYSO_API_KEY` is the key of the lane's Worker. The probe adds no authorization: the SaySo
  Worker checks the key that the script sends.
- The voice is macOS `say` (Samantha), so no recording of a person leaves the machine.
- The script enrolls a new test user with three recordings. Then it sends 40 warm verifies and
  5 cold verifies. Each cold verify comes after 300 s with no request, because the container
  sleeps after 3 minutes.
- Each verify is a transcript-only intent with its own sentence, so each recording is new.
- The Workers AI cost is less than one cent for each run.

## What the result holds

For each verify, `result.json` has three times:

- `bindingMs`: the time of the service binding call in the probe. This is the time that the
  Gateway waits for SaySo.
- `clientMs`: the time from this machine through the probe. It adds the network path to
  Cloudflare.
- `serverMs`: the times that SaySo reports: `critical_parallel` (speech-to-text, speaker and
  storage in parallel), `redimnet` (the speaker model) and `total`.

The time of the Gateway itself and of the browser upload is not in the result.
