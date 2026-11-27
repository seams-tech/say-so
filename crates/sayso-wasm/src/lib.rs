//! SaySo pure WASM core (`wasm32-unknown-unknown` + native `rlib`, zero Web3/chain deps).
pub mod audio;
pub mod embedding;
pub mod intent;
pub mod verdict;
pub mod words;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::audio::{decode_pcm16_le, decode_wav, energy_gate, sha256, wav_bytes};
use crate::embedding::{
    agreement, f32_values_le, hex_string, model_sha256, similarity_milli, speaker_passes,
    Agreement, Embedding, TemplateRecord,
};
use crate::intent::{intent_digest, spoken_text_digest, validate_intent, IntentInput};
use crate::verdict::{
    b64, b64u, verdict_json, verdict_message, Outcome, Reason, Verdict, VERDICT_TTL_MS,
};
use crate::words::check_words;

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
enum Command {
    Prepare {
        intent: IntentInput,
    },
    StreamProgress {
        intent: IntentInput,
        transcript: String,
    },
    AudioFromPcm {
        pcm_b64: String,
    },
    AudioFromWav {
        wav_b64: String,
    },
    EvaluateVerify {
        intent: IntentInput,
        audio_digest_b64u: Option<String>,
        gate_passes: bool,
        audio_reused: bool,
        template_svt1_b64: Option<String>,
        embedding_le_b64: Option<String>,
        transcript: Option<String>,
        now_ms: u64,
        verifier_version: Option<String>,
    },
    RefuseVerdict {
        reason: Reason,
        now_ms: u64,
        verifier_version: Option<String>,
        user_id: Option<String>,
        action: Option<String>,
        intent_digest_b64u: Option<String>,
        spoken_text_digest_b64u: Option<String>,
        audio_digest_b64u: Option<String>,
    },
    EvaluateEnroll {
        embeddings_le_b64: Vec<String>,
        previous_epoch: u32,
    },
}

#[derive(Serialize)]
struct SignedVerdictReady {
    ok: bool,
    outcome: Outcome,
    reason: Option<Reason>,
    verdict_json: String,
    verdict_message_b64: String,
    expires_at_ms: u64,
}

pub fn dispatch_json(input: &str) -> String {
    let parsed: Command = match serde_json::from_str(input) {
        Ok(cmd) => cmd,
        Err(error) => {
            return json!({
                "ok": false,
                "reason": "unsupported",
                "detail": error.to_string(),
            })
            .to_string();
        }
    };

    let response: Value = match parsed {
        Command::Prepare { intent } => match validate_intent(&intent) {
            Ok(valid) => json!({
                "ok": true,
                "sentence": valid.canonical_sentence,
                "display_text": valid.display_text,
                "expected_tokens": valid.expected_tokens,
                "guarded_word_indexes": valid.guarded_word_indexes,
                "transcript_only": valid.transcript_only,
                "intent_digest_b64u": b64u(&intent_digest(&valid)),
                "spoken_text_digest_b64u": b64u(&spoken_text_digest(&valid.canonical_sentence)),
            }),
            Err(reason) => json!({ "ok": false, "reason": reason }),
        },

        Command::StreamProgress { intent, transcript } => match validate_intent(&intent) {
            Ok(valid) => {
                let checked =
                    check_words(&transcript, &valid.expected_tokens, &valid.guarded_word_indexes);
                json!({
                    "ok": true,
                    "heard": checked.heard,
                    "heard_tokens": checked.heard_tokens,
                    "matched_prefix_count": checked.matched_prefix_count,
                    "expected_count": valid.expected_tokens.len(),
                    "matched_exact": checked.matched_exact,
                    // SaySo does not decide the words of a transcript-only intent, so the
                    // stream never closes early on them.
                    "passes_now": checked.passes && !valid.transcript_only,
                })
            }
            Err(reason) => json!({ "ok": false, "reason": reason }),
        },

        Command::AudioFromPcm { pcm_b64 } => match STANDARD
            .decode(pcm_b64.trim())
            .map_err(|_| "bad_base64")
            .and_then(|bytes| decode_pcm16_le(&bytes))
        {
            Ok(samples) => encode_audio_result(&samples),
            Err(detail) => json!({ "ok": false, "reason": Reason::AudioInvalid, "detail": detail }),
        },

        Command::AudioFromWav { wav_b64 } => match STANDARD
            .decode(wav_b64.trim())
            .map_err(|_| "bad_base64")
            .and_then(|bytes| decode_wav(&bytes))
        {
            Ok(samples) => encode_audio_result(&samples),
            Err(detail) => json!({ "ok": false, "reason": Reason::AudioInvalid, "detail": detail }),
        },

        Command::EvaluateVerify {
            intent,
            audio_digest_b64u,
            gate_passes,
            audio_reused,
            template_svt1_b64,
            embedding_le_b64,
            transcript,
            now_ms,
            verifier_version,
        } => {
            let result = evaluate_verify_inner(
                &intent,
                audio_digest_b64u,
                gate_passes,
                audio_reused,
                template_svt1_b64.as_deref(),
                embedding_le_b64.as_deref(),
                transcript.as_deref(),
                now_ms,
                verifier_version.as_deref(),
            );
            serde_json::to_value(result).expect("serializes")
        }

        Command::RefuseVerdict {
            reason,
            now_ms,
            verifier_version,
            user_id,
            action,
            intent_digest_b64u,
            spoken_text_digest_b64u,
            audio_digest_b64u,
        } => {
            let mut verdict = Verdict::new(now_ms, verifier_version.as_deref());
            verdict.outcome = Outcome::Refuse;
            verdict.reason = Some(reason);
            verdict.user_id = user_id;
            verdict.action = action;
            verdict.intent_digest = intent_digest_b64u;
            verdict.spoken_text_digest = spoken_text_digest_b64u;
            verdict.audio_digest = audio_digest_b64u;
            let text = verdict_json(&verdict);
            let msg = verdict_message(text.as_bytes());
            serde_json::to_value(SignedVerdictReady {
                ok: true,
                outcome: Outcome::Refuse,
                reason: Some(reason),
                verdict_json: text,
                verdict_message_b64: b64(&msg),
                expires_at_ms: verdict.expires_at_ms,
            })
            .expect("serializes")
        }

        Command::EvaluateEnroll {
            embeddings_le_b64,
            previous_epoch,
        } => {
            if embeddings_le_b64.len() != 3 {
                json!({ "ok": false, "reason": Reason::Unsupported })
            } else {
                let decoded: Option<Vec<Embedding>> = embeddings_le_b64
                    .iter()
                    .map(|item| {
                        let bytes = STANDARD.decode(item.trim()).ok()?;
                        let values = f32_values_le(&bytes)?;
                        Embedding::from_raw(&values)
                    })
                    .collect();
                match decoded {
                    None => json!({ "ok": false, "reason": Reason::SpeakerUnavailable }),
                    Some(samples) => match agreement(&samples) {
                        Agreement::Agreed {
                            template,
                            agreement_milli,
                        } => {
                            let epoch = previous_epoch.saturating_add(1);
                            let record = TemplateRecord {
                                epoch,
                                model_sha256: model_sha256(),
                                template,
                            };
                            json!({
                                "ok": true,
                                "outcome": Outcome::Accept,
                                "template_epoch": epoch,
                                "agreement_milli": agreement_milli,
                                "template_svt1_b64": b64(&record.encode()),
                            })
                        }
                        Agreement::Disagreed { agreement_milli } => json!({
                            "ok": false,
                            "outcome": Outcome::Refuse,
                            "reason": Reason::Speaker,
                            "agreement_milli": agreement_milli,
                        }),
                    },
                }
            }
        }
    };

    response.to_string()
}

fn encode_audio_result(samples: &[i16]) -> Value {
    let gate = energy_gate(samples);
    let canonical_wav = wav_bytes(samples);
    let digest = sha256(&canonical_wav);
    json!({
        "ok": true,
        "canonical_wav_b64": b64(&canonical_wav),
        "audio_digest_b64u": b64u(&digest),
        "audio_digest_hex": hex_string(&digest),
        "sample_count": samples.len(),
        "voiced_ms": gate.voiced_ms,
        "clipped_permille": gate.clipped_permille,
        "gate_passes": gate.passes(),
    })
}

#[allow(clippy::too_many_arguments)]
fn evaluate_verify_inner(
    intent_input: &IntentInput,
    audio_digest_b64u: Option<String>,
    gate_passes: bool,
    audio_reused: bool,
    template_svt1_b64: Option<&str>,
    embedding_le_b64: Option<&str>,
    transcript: Option<&str>,
    now_ms: u64,
    verifier_version: Option<&str>,
) -> SignedVerdictReady {
    let mut verdict = Verdict::new(now_ms, verifier_version);

    let step = |verdict: &mut Verdict| -> Result<(), Reason> {
        let valid = validate_intent(intent_input)?;
        verdict.user_id = Some(valid.user_id.clone());
        verdict.action = Some(valid.action.clone());
        verdict.intent_digest = Some(b64u(&intent_digest(&valid)));
        verdict.spoken_text_digest = Some(b64u(&spoken_text_digest(&valid.canonical_sentence)));

        let Some(audio_digest) = audio_digest_b64u else {
            return Err(Reason::AudioInvalid);
        };
        verdict.audio_digest = Some(audio_digest);
        if !gate_passes {
            return Err(Reason::Quality);
        }
        if audio_reused {
            return Err(Reason::AudioReused);
        }

        let Some(template_b64) = template_svt1_b64 else {
            return Err(Reason::TemplateMissing);
        };
        let template_bytes = STANDARD.decode(template_b64.trim()).map_err(|_| Reason::Storage)?;
        let record = TemplateRecord::decode(&template_bytes).ok_or(Reason::Storage)?;
        if record.model_sha256 != model_sha256() {
            return Err(Reason::TemplateMissing);
        }

        let Some(emb_b64) = embedding_le_b64 else {
            return Err(Reason::SpeakerUnavailable);
        };
        let emb_bytes = STANDARD
            .decode(emb_b64.trim())
            .map_err(|_| Reason::SpeakerUnavailable)?;
        let raw_values = f32_values_le(&emb_bytes).ok_or(Reason::SpeakerUnavailable)?;
        let live_embedding = Embedding::from_raw(&raw_values).ok_or(Reason::SpeakerUnavailable)?;

        let score = similarity_milli(&live_embedding, &record.template);
        verdict.speaker_score_milli = Some(score);
        if !speaker_passes(score) {
            return Err(Reason::Speaker);
        }

        let Some(transcript_text) = transcript else {
            return Err(Reason::TranscriberUnavailable);
        };
        if valid.transcript_only {
            // The caller decides the words from the transcript that the verdict signs.
            let heard = words::transcript_text(transcript_text);
            if heard.is_empty() {
                return Err(Reason::Words);
            }
            verdict.heard = Some(heard);
            return Ok(());
        }
        let checked =
            check_words(transcript_text, &valid.expected_tokens, &valid.guarded_word_indexes);
        if !checked.passes {
            if !checked.heard.is_empty() {
                verdict.heard = Some(checked.heard);
            }
            return Err(Reason::Words);
        }

        Ok(())
    };

    match step(&mut verdict) {
        Ok(()) => {
            verdict.outcome = Outcome::Accept;
            verdict.reason = None;
        }
        Err(reason) => {
            verdict.outcome = Outcome::Refuse;
            verdict.reason = Some(reason);
        }
    }

    let text = verdict_json(&verdict);
    let msg = verdict_message(text.as_bytes());
    SignedVerdictReady {
        ok: true,
        outcome: verdict.outcome,
        reason: verdict.reason,
        verdict_json: text,
        verdict_message_b64: b64(&msg),
        expires_at_ms: verdict.expires_at_ms.min(now_ms.saturating_add(VERDICT_TTL_MS)),
    }
}

#[no_mangle]
pub extern "C" fn sayso_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr` and `cap` must come from [`sayso_alloc`] or [`sayso_call`].
#[no_mangle]
pub unsafe extern "C" fn sayso_dealloc(ptr: *mut u8, cap: usize) {
    if !ptr.is_null() && cap > 0 {
        drop(Vec::from_raw_parts(ptr, 0, cap));
    }
}

/// # Safety
/// `ptr..ptr+len` must be valid UTF-8 allocated via [`sayso_alloc`].
#[no_mangle]
pub unsafe extern "C" fn sayso_call(ptr: *const u8, len: usize) -> u64 {
    let slice = std::slice::from_raw_parts(ptr, len);
    let input = std::str::from_utf8(slice).unwrap_or("{}");
    let output = dispatch_json(input).into_bytes().into_boxed_slice();
    let out_len = output.len() as u64;
    let out_ptr = Box::into_raw(output) as *mut u8 as usize as u64;
    (out_ptr << 32) | out_len
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey, Verifier};

    fn axis_embedding_le_b64(axis: usize, angle: f32) -> String {
        let mut values = vec![0.0f32; 192];
        values[axis] = angle.cos();
        values[(axis + 1) % 192] = angle.sin();
        let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
        b64(&bytes)
    }

    fn tone_pcm_b64(ms: usize) -> String {
        let samples: Vec<i16> = (0..(ms * 16))
            .map(|i| ((i as f32 * 0.1).sin() * 8_000.0) as i16)
            .collect();
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        b64(&bytes)
    }

    #[test]
    fn enroll_normalize_negation_guard_and_ed25519_verdict() {
        let enroll_res: Value = serde_json::from_str(&dispatch_json(
            &json!({
                "cmd": "evaluate_enroll",
                "embeddings_le_b64": [
                    axis_embedding_le_b64(0, 0.0),
                    axis_embedding_le_b64(0, 0.1),
                    axis_embedding_le_b64(0, 0.2),
                ],
                "previous_epoch": 0,
            })
            .to_string(),
        ))
        .unwrap();
        assert_eq!(enroll_res["ok"], true);
        let template_b64 = enroll_res["template_svt1_b64"].as_str().unwrap();

        let intent = json!({
            "user_id": "alice@acme.com",
            "action": "stripe/payout",
            "payload_sha256_hex": "42".repeat(32),
            "sentence": "Approve payout $45",
        });

        let prep: Value = serde_json::from_str(&dispatch_json(
            &json!({ "cmd": "prepare", "intent": intent }).to_string(),
        ))
        .unwrap();
        assert_eq!(prep["ok"], true);
        assert_eq!(prep["sentence"], "approve payout forty five dollars");

        for good in [
            "Approve payout $45.",
            "approve payout 45 dollars",
            "Approve payout forty-five dollars!",
        ] {
            let prog: Value = serde_json::from_str(&dispatch_json(
                &json!({ "cmd": "stream_progress", "intent": intent, "transcript": good })
                    .to_string(),
            ))
            .unwrap();
            assert_eq!(prog["passes_now"], true, "expected pass for {good}");
        }

        for bad in [
            "Approve payout $45 not",
            "Do not approve payout $45",
            "Approve payout $46",
        ] {
            let prog: Value = serde_json::from_str(&dispatch_json(
                &json!({ "cmd": "stream_progress", "intent": intent, "transcript": bad })
                    .to_string(),
            ))
            .unwrap();
            assert_eq!(prog["passes_now"], false, "expected refusal for {bad}");
        }

        let audio: Value = serde_json::from_str(&dispatch_json(
            &json!({ "cmd": "audio_from_pcm", "pcm_b64": tone_pcm_b64(1_000) }).to_string(),
        ))
        .unwrap();
        assert_eq!(audio["gate_passes"], true);

        let evaluated: Value = serde_json::from_str(&dispatch_json(
            &json!({
                "cmd": "evaluate_verify",
                "intent": intent,
                "audio_digest_b64u": audio["audio_digest_b64u"],
                "gate_passes": true,
                "audio_reused": false,
                "template_svt1_b64": template_b64,
                "embedding_le_b64": axis_embedding_le_b64(0, 0.05),
                "transcript": "Approve payout $45.",
                "now_ms": 1_760_000_000_000u64,
            })
            .to_string(),
        ))
        .unwrap();
        assert_eq!(evaluated["outcome"], "accept");

        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let msg = STANDARD
            .decode(evaluated["verdict_message_b64"].as_str().unwrap())
            .unwrap();
        let sig = signing_key.sign(&msg);
        assert!(signing_key.verifying_key().verify(&msg, &sig).is_ok());
        let parsed: Verdict =
            serde_json::from_str(evaluated["verdict_json"].as_str().unwrap()).unwrap();
        assert_eq!(parsed.kind, "sayso_verdict_v1");
        assert_eq!(parsed.verifier, "sayso/0.2.0");
        assert_eq!(parsed.user_id.as_deref(), Some("alice@acme.com"));
        assert_eq!(parsed.heard, None);
    }

    fn call(command: Value) -> Value {
        serde_json::from_str(&dispatch_json(&command.to_string())).unwrap()
    }

    #[test]
    fn guarded_word_indexes_reach_prepare_and_the_word_check() {
        let plain = json!({
            "user_id": "near:testnet:alice.testnet",
            "action": "seams.near.transfer",
            "payload_sha256_hex": "42".repeat(32),
            "sentence": "send ten near to bob dot testnet",
        });
        let mut guarded = plain.clone();
        guarded["guarded_word_indexes"] = json!([1, 2, 4, 5, 6]);

        let prepared = call(json!({ "cmd": "prepare", "intent": guarded }));
        assert_eq!(prepared["ok"], true);
        assert_eq!(prepared["guarded_word_indexes"], json!([1, 2, 4, 5, 6]));
        let prepared_plain = call(json!({ "cmd": "prepare", "intent": plain }));
        assert_eq!(prepared_plain["guarded_word_indexes"], json!([]));
        assert_ne!(prepared["intent_digest_b64u"], prepared_plain["intent_digest_b64u"]);

        let passes_now = |intent: &Value, transcript: &str| {
            call(json!({ "cmd": "stream_progress", "intent": intent, "transcript": transcript }))
                ["passes_now"]
                .clone()
        };
        assert_eq!(passes_now(&plain, "send ten near to rob dot testnet"), true);
        assert_eq!(passes_now(&guarded, "send ten near to rob dot testnet"), false);
        assert_eq!(passes_now(&guarded, "sent ten near to bob dot testnet"), true);

        // Indexes outside the sentence are a refusal with a reason. A value that is not a
        // list of numbers does not parse, and the Worker signs the refusal for it.
        let mut outside = plain.clone();
        outside["guarded_word_indexes"] = json!([7]);
        assert_eq!(
            call(json!({ "cmd": "prepare", "intent": outside })),
            json!({ "ok": false, "reason": "unsupported" })
        );
        let mut both = guarded.clone();
        both["transcript_only"] = json!(true);
        assert_eq!(
            call(json!({ "cmd": "prepare", "intent": both })),
            json!({ "ok": false, "reason": "unsupported" })
        );
        let mut malformed = plain.clone();
        malformed["guarded_word_indexes"] = json!("bob");
        let refused = call(json!({ "cmd": "prepare", "intent": malformed }));
        assert_eq!(refused["ok"], false);
        assert_eq!(refused["reason"], "unsupported");
    }

    #[test]
    fn a_transcript_only_verdict_signs_the_transcript_and_not_a_word_decision() {
        let enrolled = call(json!({
            "cmd": "evaluate_enroll",
            "embeddings_le_b64": [
                axis_embedding_le_b64(0, 0.0),
                axis_embedding_le_b64(0, 0.1),
                axis_embedding_le_b64(0, 0.2),
            ],
            "previous_epoch": 0,
        }));
        let intent = json!({
            "user_id": "near:testnet:alice.testnet",
            "action": "seams.near.transfer",
            "payload_sha256_hex": "42".repeat(32),
            "sentence": "send ten near to bob dot testnet",
            "transcript_only": true,
        });
        let prepared = call(json!({ "cmd": "prepare", "intent": intent }));
        assert_eq!(prepared["transcript_only"], true);
        // The words match, but SaySo does not decide them, so the stream does not close early.
        let progress = call(json!({
            "cmd": "stream_progress",
            "intent": intent,
            "transcript": "send ten near to bob dot testnet",
        }));
        assert_eq!(progress["passes_now"], false);

        let verify = |transcript: &str| {
            let evaluated = call(json!({
                "cmd": "evaluate_verify",
                "intent": intent,
                "audio_digest_b64u": "A".repeat(43),
                "gate_passes": true,
                "audio_reused": false,
                "template_svt1_b64": enrolled["template_svt1_b64"],
                "embedding_le_b64": axis_embedding_le_b64(0, 0.05),
                "transcript": transcript,
                "now_ms": 1_760_000_000_000u64,
            }));
            serde_json::from_str::<Verdict>(evaluated["verdict_json"].as_str().unwrap()).unwrap()
        };
        // Words that differ still give an accept: the caller reads them from `heard`.
        let accepted = verify("Send 10 NEAR to rob.testnet.");
        assert_eq!(accepted.outcome, Outcome::Accept);
        assert_eq!(accepted.heard.as_deref(), Some("Send 10 NEAR to rob.testnet."));
        assert_eq!(
            accepted.intent_digest.as_deref(),
            prepared["intent_digest_b64u"].as_str()
        );
        let silent = verify("   ");
        assert_eq!(silent.outcome, Outcome::Refuse);
        assert_eq!(silent.reason, Some(Reason::Words));
    }
}
