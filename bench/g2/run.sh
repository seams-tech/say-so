#!/bin/sh
# Gate G2: runs two speaker-service images on this machine and compares them on private clips.
#
#   bench/g2/run.sh <fixtures-dir> <work-dir>
#
# <fixtures-dir> holds the clips and voiceid-fixture-manifest.json. Keep <work-dir> outside the
# repository's tracked files (for example target/g2): it gets the decoded audio while the run
# lasts, and result.json. The script deletes the decoded audio and the containers at the end.
# The clips go only to the two local containers.
set -eu
fixtures=$1
work=$2
here=$(cd "$(dirname "$0")" && pwd)

# The SaySo container that sayso.seams.sh runs, and the Phala build of speak-to-sign
# (crates/speaker-service/docker-compose.yml). Both are linux/amd64; on Apple silicon Docker
# runs them under emulation.
SAYSO_IMAGE=${SAYSO_IMAGE:-registry.cloudflare.com/ea0d54352cf9d80e962154980504b428/sayso-verifier-speakercontainer:2caac3c4}
PHALA_IMAGE=${PHALA_IMAGE:-ghcr.io/seams-tech/speaker-service@sha256:2f3475cd954b50f0752f5687971b05911aba8e916d903d47f59166d6df86fdfd}
TEST_SEED=2222222222222222222222222222222222222222222222222222222222222222

mkdir -p "$work"
cleanup() {
  docker rm -f g2-sayso g2-phala > /dev/null 2>&1 || true
  rm -rf "$work/pcm"
}
trap cleanup EXIT INT TERM

docker run -d --rm --platform linux/amd64 --name g2-sayso -p 127.0.0.1:18081:8080 \
  -e SPEAKER_SIGNING_KEY_HEX=$TEST_SEED "$SAYSO_IMAGE" > /dev/null
# SPEAKER_DEV_KEY_HEX: the Phala build signs with this seed and does not call the dstack agent.
docker run -d --rm --platform linux/amd64 --name g2-phala -p 127.0.0.1:18082:8080 \
  -e SPEAKER_DEV_KEY_HEX=$TEST_SEED "$PHALA_IMAGE" > /dev/null

for port in 18081 18082; do
  tries=0
  until curl -fsS "http://127.0.0.1:$port/healthz" > /dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -gt 120 ]; then
      echo "the service on port $port did not start" >&2
      exit 1
    fi
    sleep 1
  done
done

python3 -I "$here/run.py" --manifest "$fixtures/voiceid-fixture-manifest.json" --clips "$fixtures" \
  --work "$work" --service sayso=http://127.0.0.1:18081 --service phala=http://127.0.0.1:18082 \
  --reference phala --out "$work/result.json"
