# G2: speaker embeddings of two speaker-service builds on the same clips, scored as SaySo scores
# them. Run it with `python3 -I`, through run.sh.
#
#   python3 -I bench/g2/run.py --manifest <manifest.json> --clips <dir> --work <dir> \
#     --service sayso=http://127.0.0.1:18081 --service phala=http://127.0.0.1:18082 \
#     --reference phala --out <result.json>
#
# The math is the math of sayso-wasm `embedding.rs` and `audio.rs`, which is the same as the
# voice-verifier of speak-to-sign: a unit embedding, the enrollment agreement (every pair at or
# above the cutoff), the unit mean as the template, and the floor of the cosine in thousandths.
# The result has scores and decisions, never an embedding.
import argparse
import base64
import json
import os
import secrets
import struct
import subprocess
import time
import urllib.request

import numpy as np

SAMPLE_RATE = 16_000
MIN_SAMPLES = SAMPLE_RATE // 2  # the speaker service refuses a shorter clip
MAX_SAMPLES = 8 * SAMPLE_RATE
CUTOFF_MILLI = 450
GATE_FRAME = 512
GATE_LEVEL_RMS = np.float32(0.006)
GATE_MIN_VOICED_MS = 600
GATE_MAX_CLIPPED_PERMILLE = 10
ENROLLMENT = "owner_enrollment"


def decode(source, target):
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", source, "-ac", "1", "-ar", str(SAMPLE_RATE),
         "-f", "s16le", "-acodec", "pcm_s16le", target],
        check=True,
    )
    return np.fromfile(target, dtype="<i2")


def canonical_wav(pcm):
    """The 44-byte header WAV that sayso-wasm `wav_bytes` writes."""
    data = pcm.astype("<i2").tobytes()
    header = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 1, 1, SAMPLE_RATE, SAMPLE_RATE * 2, 2, 16) + b"data" + struct.pack("<I", len(data))
    return header + data


def energy_gate(pcm):
    voiced = 0
    for start in range(0, len(pcm), GATE_FRAME):
        frame = pcm[start:start + GATE_FRAME].astype(np.float32) / np.float32(32_768.0)
        rms = np.sqrt(np.sum(frame * frame, dtype=np.float32) / np.float32(len(frame)))
        if rms >= GATE_LEVEL_RMS:
            voiced += len(frame)
    clipped = int(np.sum((pcm == 32767) | (pcm == -32768)))
    voiced_ms = voiced * 1_000 // SAMPLE_RATE
    clipped_permille = clipped * 1_000 // len(pcm) if len(pcm) else 0
    passes = voiced_ms >= GATE_MIN_VOICED_MS and clipped_permille <= GATE_MAX_CLIPPED_PERMILLE
    return {"voiced_ms": voiced_ms, "clipped_permille": clipped_permille, "passes": passes}


def unit(raw):
    """`Embedding::from_raw`: divide by the f64 norm, keep f32."""
    values = np.asarray(raw, dtype=np.float32)
    norm = np.sqrt(np.sum(values.astype(np.float64) ** 2))
    return (values.astype(np.float64) / norm).astype(np.float32)


def similarity_milli(left, right):
    return int(np.floor(np.sum(left.astype(np.float64) * right.astype(np.float64)) * 1_000.0))


def template_of(samples):
    """`agreement`: every pair at or above the cutoff, then the unit mean (summed in f32)."""
    agreement = min(similarity_milli(a, b) for i, a in enumerate(samples) for b in samples[i + 1:])
    if agreement < CUTOFF_MILLI:
        return None, agreement
    mean = np.zeros(len(samples[0]), dtype=np.float32)
    for sample in samples:
        mean += sample / np.float32(len(samples))
    return unit(mean), agreement


def embed(url, wav):
    body = json.dumps({"audio_wav_b64": base64.b64encode(wav).decode(), "nonce": secrets.token_hex(32)}).encode()
    request = urllib.request.Request(f"{url}/v1/embed", body, {"Content-Type": "application/json"})
    started = time.monotonic()
    with urllib.request.urlopen(request, timeout=300) as response:
        reply = json.load(response)
    wall_ms = round((time.monotonic() - started) * 1_000)
    raw = np.frombuffer(base64.b64decode(reply["embedding_b64"]), dtype="<f4")
    return unit(raw), {"model_ms": reply.get("model_ms"), "wall_ms": wall_ms}


def category(entry):
    relation = entry["expectedRelation"]
    if relation == "different_speaker":
        return "different_speaker_synthetic" if entry["speakerLabel"].startswith("synthetic") else "different_speaker_owner_variant"
    return relation


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--clips", required=True)
    parser.add_argument("--work", required=True)
    parser.add_argument("--service", action="append", required=True, help="name=url")
    parser.add_argument("--reference", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    services = dict(item.split("=", 1) for item in args.service)
    others = [name for name in services if name != args.reference]

    manifest = json.load(open(args.manifest))
    os.makedirs(os.path.join(args.work, "pcm"), exist_ok=True)
    clips = []
    for entry in manifest["entries"]:
        pcm = decode(os.path.join(args.clips, entry["audioFileName"]),
                      os.path.join(args.work, "pcm", entry["fixtureId"] + ".pcm"))
        clips.append({"entry": entry, "pcm": pcm, "gate": energy_gate(pcm)})

    # One warm-up call each, so that the first timed clip does not carry the start of the plan.
    warm = canonical_wav(np.zeros(SAMPLE_RATE, dtype=np.int16))
    for url in services.values():
        embed(url, warm)

    embeddings = {name: {} for name in services}
    timing = {name: [] for name in services}
    for clip in clips:
        if not MIN_SAMPLES <= len(clip["pcm"]) <= MAX_SAMPLES:
            continue
        wav = canonical_wav(clip["pcm"])
        for name, url in services.items():
            vector, times = embed(url, wav)
            embeddings[name][clip["entry"]["fixtureId"]] = vector
            timing[name].append({**times, "audio_ms": len(clip["pcm"]) * 1_000 // SAMPLE_RATE})

    enrollment = [clip["entry"]["fixtureId"] for clip in clips if clip["entry"]["expectedRelation"] == ENROLLMENT]
    if len(enrollment) != 3:
        raise SystemExit(f"SaySo enrolls with 3 clips; the manifest has {len(enrollment)}")
    if not all(clip["gate"]["passes"] for clip in clips if clip["entry"]["fixtureId"] in enrollment):
        raise SystemExit("an enrollment clip fails the energy gate")
    templates = {}
    for name in services:
        template, agreement = template_of([embeddings[name][fixture] for fixture in enrollment])
        templates[name] = {"template": template, "agreement_milli": agreement}

    rows = []
    for clip in clips:
        entry = clip["entry"]
        fixture = entry["fixtureId"]
        row = {
            "fixtureId": fixture,
            "category": category(entry),
            "speakerLabel": entry["speakerLabel"],
            "expectedRelation": entry["expectedRelation"],
            "samples": len(clip["pcm"]),
            "gate": clip["gate"],
            "services": {},
        }
        for name in services:
            if fixture in enrollment:
                decision, score = "enrollment", None
            elif not clip["gate"]["passes"]:
                decision, score = "refuse:quality", None
            elif fixture not in embeddings[name]:
                decision, score = "refuse:audio_invalid", None
            elif templates[name]["template"] is None:
                decision, score = "refuse:template_missing", None
            else:
                score = similarity_milli(embeddings[name][fixture], templates[name]["template"])
                decision = "accept" if score >= CUTOFF_MILLI else "refuse:speaker"
            row["services"][name] = {"score_milli": score, "decision": decision}
        for name in others:
            if fixture in embeddings[name] and fixture in embeddings[args.reference]:
                left, right = embeddings[name][fixture], embeddings[args.reference][fixture]
                row["services"][name]["cosine_to_reference"] = float(np.sum(left.astype(np.float64) * right.astype(np.float64)))
        rows.append(row)

    summary = {}
    for row in rows:
        group = summary.setdefault(row["category"], {"clips": 0, **{name: {} for name in services}, "agree": {name: 0 for name in others}})
        group["clips"] += 1
        for name in services:
            decision = row["services"][name]["decision"]
            group[name][decision] = group[name].get(decision, 0) + 1
        for name in others:
            group["agree"][name] += row["services"][name]["decision"] == row["services"][args.reference]["decision"]

    comparison = {}
    for name in others:
        cosines = [row["services"][name]["cosine_to_reference"] for row in rows if "cosine_to_reference" in row["services"][name]]
        differences = [abs(row["services"][name]["score_milli"] - row["services"][args.reference]["score_milli"])
                       for row in rows if row["services"][name]["score_milli"] is not None and row["services"][args.reference]["score_milli"] is not None]
        comparison[name] = {
            "embedded_clips": len(cosines),
            "cosine_min": min(cosines),
            "cosine_max": max(cosines),
            "cosine_mean": float(np.mean(cosines)),
            "max_score_difference_milli": max(differences) if differences else None,
            "decisions_differ": sum(row["services"][name]["decision"] != row["services"][args.reference]["decision"] for row in rows),
            "template_cosine_to_reference": float(np.sum(templates[name]["template"].astype(np.float64) * templates[args.reference]["template"].astype(np.float64)))
            if templates[name]["template"] is not None and templates[args.reference]["template"] is not None else None,
        }
    near = [
        {"fixtureId": row["fixtureId"], "category": row["category"], **{name: row["services"][name]["score_milli"] for name in services}}
        for row in rows
        if any(row["services"][name]["score_milli"] is not None and abs(row["services"][name]["score_milli"] - CUTOFF_MILLI) <= 50 for name in services)
    ]
    result = {
        "cutoff_milli": CUTOFF_MILLI,
        "reference": args.reference,
        "services": services,
        "enrollment": {name: {"agreement_milli": templates[name]["agreement_milli"], "clips": enrollment} for name in services},
        "summary": summary,
        "comparison": comparison,
        "near_cutoff_within_50_milli": near,
        "timing": {
            name: {
                "clips": len(timing[name]),
                "wall_ms_mean": round(float(np.mean([t["wall_ms"] for t in timing[name]]))),
                "wall_ms_max": max(t["wall_ms"] for t in timing[name]),
                "model_ms_mean": round(float(np.mean([t["model_ms"] for t in timing[name] if t["model_ms"] is not None]))),
            }
            for name in services
        },
        "rows": rows,
    }
    with open(args.out, "w") as out:
        json.dump(result, out, indent=2)
    print(json.dumps({key: result[key] for key in ("enrollment", "summary", "comparison", "near_cutoff_within_50_milli", "timing")}, indent=2))


if __name__ == "__main__":
    main()
