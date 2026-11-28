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
- `serverMs`: the `ms` record that SaySo returns with each verify. Speech to text, the speaker
  and storage run in parallel, and each has its own time from the start of that parallel part:
  - `stt`: the Whisper turbo call on Workers AI, with its hedge. `stt_calls` is 2 when the
    first call had not answered after `STT_HEDGE_AFTER_MS` (`workers/verifier/src/stt.ts`), so
    a second call started; `stt_answer` is the call that answered.
  - `speaker`: the call to the speaker container, with a container start when it is cold.
  - `redimnet`: the speaker model alone, inside `speaker`.
  - `storage`: the Durable Object that consumes the audio digest and reads the template.
  - `critical_parallel`: the parallel part, so the slowest of the three; `total`: the engine.

The summary gives p50, p95 and the maximum of each time, for warm and for cold verifies. It
also gives `outside_engine` (`bindingMs` less `total`: authorization, the rate limit and the
JSON work of the Worker), `slowest`, the count of verifies that each parallel part set, and
`hedge`, the count of verifies that started a second turbo call and that it answered.

The time of the Gateway itself and of the browser upload is not in the result.

## The control: the turbo call alone

`pairs.ts` calls the Whisper turbo model through the Workers AI REST API from this machine, with
no SaySo code in the path. It sends pairs of two equal calls at the same time, as the hedged
call does, and gives the correlation of the two times of a pair. A hedge helps only when one
slow call does not make the other slow too.

```sh
CLOUDFLARE_API_TOKEN=... node bench/g3/pairs.ts target/g3-pairs target/g3/pairs.json 40
```

Its times include the path from this machine to the API, so compare their spread with the
Worker's `stt` times, not their level. Do not run it while a transcription batch runs.
