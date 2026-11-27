# Gate G2: the speaker container against the Phala build

G2 asks if ReDimNet B1 in the SaySo speaker container gives the same accept and refuse results
as the earlier verifier, at SaySo's cutoff of 450 milli. The earlier verifier is the Phala build
of `crates/speaker-service` in speak-to-sign (`ghcr.io/seams-tech/speaker-service@sha256:2f3475cd…`).
The Phala deployment has no funding, so the script runs that same image on this machine.

## Run

```sh
bench/g2/run.sh <fixtures-dir> target/g2      # free, about 5 minutes on Apple silicon
```

- `<fixtures-dir>` holds the clips and `voiceid-fixture-manifest.json`. The clips are private:
  do not commit, upload or log them. The script sends them only to the two local containers.
- The script starts both images with Docker, decodes each clip with `ffmpeg` to 16 kHz mono
  PCM16, and writes the canonical WAV of `sayso-wasm` for both services.
- It deletes the decoded audio and the containers at the end. `target/g2/result.json` keeps
  scores and decisions, but no embedding.

## What the script computes

`run.py` uses the math of `sayso-wasm` (`embedding.rs`, `audio.rs`). The voice-verifier of
speak-to-sign has the same math, so the embedding is the only part that can differ.

1. The energy gate of each clip. A clip that fails it refuses as `quality` before a model runs.
2. The embedding of each clip from each service. A clip shorter than 0.5 s gets no embedding.
3. The template: the three `owner_enrollment` clips must agree in each pair at 450 milli or more.
   The template is their unit mean.
4. The score of each other clip: the floor of the cosine to the template, in thousandths. A clip
   passes at 450 or more.
5. The cosine between the two embeddings of each clip, and the largest score difference.

## Limits

- Docker on Apple silicon runs the linux/amd64 images under emulation. So the times in
  `result.json` are not production times. Gate G3 measures time on Cloudflare.
- The decision of a clip does not include the word check. A `wrong_phrase` clip is the owner's
  voice, so the speaker check alone can accept it.
