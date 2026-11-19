//! SaySo pure WASM core (`wasm32-unknown-unknown` + native `rlib` for unit tests).
pub mod audio;
pub mod embedding;
pub mod policy;
pub mod request;
pub mod verdict;
pub mod words;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use spoken_intent::{confusion_set, render, request_digest, spoken_text_digest};

use crate::audio::{decode_pcm16_le, decode_wav, energy_gate, sha256, wav_bytes};
use crate::embedding::{
    agreement, f32_values_le, hex_string, model_sha256, similarity_milli, speaker_passes,
    Agreement, Embedding, TemplateRecord,
};
use crate::policy::{decide, Decision};
use crate::request::{build_request, RequestInput, StoredMultisigProposal};
use crate::verdict::{
    b64, b64u, verdict_json, verdict_message, MultisigOpening, Outcome, Reason, Verdict,
    VERDICT_TTL_MS,
};
use crate::words::{check_words, is_summary_request, matched_prefix_count, words_pass};

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
enum Command {
    Prepare {
        owner: String,
        request: RequestInput,
        #[serde(default)]
        contacts: Vec<String>,
        salt_hex: Option<String>,
        stored_proposal: Option<StoredMultisigProposal>,
    },
    StreamProgress {
        owner: String,
        request: RequestInput,
        #[serde(default)]
        contacts: Vec<String>,
        transcript: String,
        salt_hex: Option<String>,
        stored_proposal: Option<StoredMultisigProposal>,
    },
    AudioFromPcm {
        pcm_b64: String,
    },
    AudioFromWav {
        wav_b64: String,
    },
    EvaluateVerify {
        owner: String,
        request: RequestInput,
        #[serde(default)]
        contacts: Vec<String>,
        audio_digest_b64u: Option<String>,
        gate_passes: bool,
        audio_reused: bool,
        template_svt1_b64: Option<String>,
        embedding_le_b64: Option<String>,
        #[serde(default)]
        other_signer_templates_b64: Vec<String>,
        transcript: Option<String>,
        summary_passes: Option<bool>,
        now_ms: u64,
        verifier_version: Option<String>,
        salt_hex: Option<String>,
        stored_proposal: Option<StoredMultisigProposal>,
    },
    RefuseVerdict {
        reason: Reason,
        now_ms: u64,
        verifier_version: Option<String>,
        request_digest_b64u: Option<String>,
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
    policy_text: Option<&'static str>,
    multisig: Option<MultisigOpening>,
}

/// Pure JSON dispatcher used both natively in Rust tests and via WASM FFI in Cloudflare Workers.
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
        Command::Prepare {
            owner,
            request,
            contacts,
            salt_hex,
            stored_proposal,
        } => match build_request(
            &owner,
            &request,
            &contacts,
            salt_hex.as_deref(),
            stored_proposal.as_ref(),
        ) {
            Ok(built) => {
                let rendered = render(&built.request);
                let req_digest = b64u(&request_digest(&built.request));
                let text_digest = b64u(&spoken_text_digest(&built.request, &rendered));
                let tokens: Vec<&str> = rendered.spoken.iter().map(|t| t.as_str()).collect();
                json!({
                    "ok": true,
                    "sentence": rendered.spoken_text,
                    "display_text": rendered.display_text,
                    "expected_tokens": tokens,
                    "request_digest_b64u": req_digest,
                    "spoken_text_digest_b64u": (!built.recalled).then_some(text_digest),
                    "recalled": built.recalled,
                    "is_summary": is_summary_request(&built.request),
                    "multisig_commitment_hex": built.multisig_commitment.map(|c| hex_string(&c)),
                })
            }
            Err(reason) => json!({ "ok": false, "reason": reason }),
        },

        Command::StreamProgress {
            owner,
            request,
            contacts,
            transcript,
            salt_hex,
            stored_proposal,
        } => match build_request(
            &owner,
            &request,
            &contacts,
            salt_hex.as_deref(),
            stored_proposal.as_ref(),
        ) {
            Ok(built) => {
                let rendered = render(&built.request);
                let confusions = confusion_set(&built.request, &built.contacts);
                let checked =
                    check_words(&transcript, &built.contacts, &rendered.spoken, &confusions);
                let prefix = matched_prefix_count(&rendered.spoken, &checked.heard_tokens);
                let passes_now = words_pass(&built.request, &checked, &rendered.spoken);
                json!({
                    "ok": true,
                    "heard": checked.heard,
                    "heard_tokens": checked.heard_tokens,
                    "matched_prefix_count": prefix,
                    "expected_count": rendered.spoken.len(),
                    "matched_exact": checked.matched,
                    "passes_now": passes_now,
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
            owner,
            request,
            contacts,
            audio_digest_b64u,
            gate_passes,
            audio_reused,
            template_svt1_b64,
            embedding_le_b64,
            other_signer_templates_b64,
            transcript,
            summary_passes,
            now_ms,
            verifier_version,
            salt_hex,
            stored_proposal,
        } => {
            let result = evaluate_verify_inner(
                &owner,
                &request,
                &contacts,
                audio_digest_b64u,
                gate_passes,
                audio_reused,
                template_svt1_b64.as_deref(),
                embedding_le_b64.as_deref(),
                &other_signer_templates_b64,
                transcript.as_deref(),
                summary_passes,
                now_ms,
                verifier_version.as_deref(),
                salt_hex.as_deref(),
                stored_proposal.as_ref(),
            );
            serde_json::to_value(result).expect("serializes")
        }

        Command::RefuseVerdict {
            reason,
            now_ms,
            verifier_version,
            request_digest_b64u,
            spoken_text_digest_b64u,
            audio_digest_b64u,
        } => {
            let mut verdict = Verdict::new(now_ms, verifier_version.as_deref());
            verdict.outcome = Outcome::Refuse;
            verdict.reason = Some(reason);
            verdict.request_digest = request_digest_b64u;
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
                policy_text: None,
                multisig: None,
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
    owner: &str,
    request_input: &RequestInput,
    contacts: &[String],
    audio_digest_b64u: Option<String>,
    gate_passes: bool,
    audio_reused: bool,
    template_svt1_b64: Option<&str>,
    embedding_le_b64: Option<&str>,
    other_signer_templates_b64: &[String],
    transcript: Option<&str>,
    summary_passes: Option<bool>,
    now_ms: u64,
    verifier_version: Option<&str>,
    salt_hex: Option<&str>,
    stored_proposal: Option<&StoredMultisigProposal>,
) -> SignedVerdictReady {
    let mut verdict = Verdict::new(now_ms, verifier_version);
    let mut policy_text = None;
    let mut multisig = None;

    let step = |verdict: &mut Verdict,
                policy_text: &mut Option<&'static str>,
                multisig: &mut Option<MultisigOpening>|
     -> Result<Outcome, Reason> {
        let built = build_request(owner, request_input, contacts, salt_hex, stored_proposal)?;
        let rendered = render(&built.request);
        let text_digest = b64u(&spoken_text_digest(&built.request, &rendered));
        verdict.request_digest = Some(b64u(&request_digest(&built.request)));
        if !built.recalled {
            verdict.spoken_text_digest = Some(text_digest.clone());
        }

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

        for other_b64 in other_signer_templates_b64 {
            let other_bytes = STANDARD.decode(other_b64.trim()).map_err(|_| Reason::Storage)?;
            let other_record = TemplateRecord::decode(&other_bytes).ok_or(Reason::Storage)?;
            if speaker_passes(similarity_milli(&live_embedding, &other_record.template)) {
                return Err(Reason::SameSpeaker);
            }
        }

        let Some(transcript_text) = transcript else {
            return Err(Reason::TranscriberUnavailable);
        };
        let confusions = confusion_set(&built.request, &built.contacts);
        let checked = check_words(transcript_text, &built.contacts, &rendered.spoken, &confusions);
        if !built.recalled {
            verdict.word_margin_milli = checked.margin_milli;
        }
        if !words_pass(&built.request, &checked, &rendered.spoken) {
            if !checked.heard.is_empty() {
                verdict.heard = Some(checked.heard);
            }
            return Err(Reason::Words);
        }

        if let Some(false) = summary_passes {
            return Err(Reason::SummaryMismatch);
        }

        if built.recalled {
            verdict.spoken_text_digest = Some(text_digest);
            verdict.word_margin_milli = checked.margin_milli;
        }
        if let (Some(commitment), Some(salt)) = (built.multisig_commitment, built.multisig_salt) {
            *multisig = Some(MultisigOpening {
                commitment: b64u(&commitment),
                salt: b64u(&salt),
            });
        }

        match decide(&built.request) {
            Decision::Allow => Ok(Outcome::Accept),
            Decision::StepUp(rule) => {
                verdict.policy_rule = Some(rule.id.to_string());
                *policy_text = Some(rule.text);
                Ok(Outcome::StepUp)
            }
        }
    };

    match step(&mut verdict, &mut policy_text, &mut multisig) {
        Ok(outcome) => {
            verdict.outcome = outcome;
            verdict.reason = None;
        }
        Err(reason) => {
            verdict.outcome = Outcome::Refuse;
            verdict.reason = Some(reason);
            policy_text = None;
            multisig = None;
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
        policy_text,
        multisig,
    }
}

// ---------------------------------------------------------------------------
// Minimal C-ABI exports for Cloudflare Workers (`wasm32-unknown-unknown`).

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
    use ed25519_dalek::{Signer, SigningKey};
    use voice_verdict::{check_verdict, confirmation_borsh, Check, Outcome as CheckedOutcome};

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
    fn enroll_stream_and_verify_round_trip_matches_voice_verdict_crate() {
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
        assert_eq!(enroll_res["template_epoch"], 1);
        let template_b64 = enroll_res["template_svt1_b64"].as_str().unwrap().to_string();
        assert_eq!(STANDARD.decode(&template_b64).unwrap().len(), 808);

        let payload_hash = [0x42u8; 32];
        let payload_hex = hex_string(&payload_hash);
        let request = json!({
            "kind": "confirmation",
            "context": "agent/refund",
            "payload_sha256_hex": payload_hex,
            "summary": "approve refund forty five dollars",
        });

        let prep: Value = serde_json::from_str(&dispatch_json(
            &json!({
                "cmd": "prepare",
                "owner": "app:sayso",
                "request": request,
            })
            .to_string(),
        ))
        .unwrap();
        assert_eq!(prep["ok"], true);
        assert_eq!(prep["sentence"], "approve refund forty five dollars");

        let partial: Value = serde_json::from_str(&dispatch_json(
            &json!({
                "cmd": "stream_progress",
                "owner": "app:sayso",
                "request": request,
                "transcript": "approve refund forty",
            })
            .to_string(),
        ))
        .unwrap();
        assert_eq!(partial["matched_prefix_count"], 3);
        assert_eq!(partial["passes_now"], false);

        let exact: Value = serde_json::from_str(&dispatch_json(
            &json!({
                "cmd": "stream_progress",
                "owner": "app:sayso",
                "request": request,
                "transcript": "Approve refund forty-five dollars.",
            })
            .to_string(),
        ))
        .unwrap();
        assert_eq!(exact["matched_exact"], true);
        assert_eq!(exact["passes_now"], true);

        let negated: Value = serde_json::from_str(&dispatch_json(
            &json!({
                "cmd": "stream_progress",
                "owner": "app:sayso",
                "request": request,
                "transcript": "Approve refund forty five dollars not",
            })
            .to_string(),
        ))
        .unwrap();
        assert_eq!(negated["passes_now"], false);

        let audio: Value = serde_json::from_str(&dispatch_json(
            &json!({
                "cmd": "audio_from_pcm",
                "pcm_b64": tone_pcm_b64(1_200),
            })
            .to_string(),
        ))
        .unwrap();
        assert_eq!(audio["ok"], true);
        assert_eq!(audio["gate_passes"], true);
        let audio_digest_b64u = audio["audio_digest_b64u"].as_str().unwrap().to_string();
        let wav = STANDARD
            .decode(audio["canonical_wav_b64"].as_str().unwrap())
            .unwrap();
        let expected_audio_digest = sha256(&wav);

        let evaluated: Value = serde_json::from_str(&dispatch_json(
            &json!({
                "cmd": "evaluate_verify",
                "owner": "app:sayso",
                "request": request,
                "audio_digest_b64u": audio_digest_b64u,
                "gate_passes": true,
                "audio_reused": false,
                "template_svt1_b64": template_b64,
                "embedding_le_b64": axis_embedding_le_b64(0, 0.05),
                "transcript": "Approve refund forty-five dollars.",
                "now_ms": 1_760_000_000_000u64,
            })
            .to_string(),
        ))
        .unwrap();
        assert_eq!(evaluated["outcome"], "accept");

        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let verifying_key = signing_key.verifying_key().to_bytes();
        let message_bytes = STANDARD
            .decode(evaluated["verdict_message_b64"].as_str().unwrap())
            .unwrap();
        let sig = signing_key.sign(&message_bytes);
        let sig_b64 = b64(&sig.to_bytes());

        let borsh_bytes = confirmation_borsh(
            "app:sayso",
            "agent/refund",
            &payload_hash,
            "approve refund forty five dollars",
        )
        .unwrap();
        let expected_req_digest = voice_verdict::request_digest(&borsh_bytes).unwrap();

        let checked = check_verdict(
            evaluated["verdict_json"].as_str().unwrap(),
            &sig_b64,
            &verifying_key,
            &Check::at(1_760_000_050_000)
                .request(&expected_req_digest)
                .audio(&expected_audio_digest),
        )
        .expect("verdict passes seams-voice-verdict check");
        assert_eq!(checked.outcome, CheckedOutcome::Accept);
        assert_eq!(checked.verifier, "sayso/0.1.0");
        assert_eq!(checked.heard, None);
    }

    #[test]
    fn transfer_above_ten_near_triggers_step_up_and_supports_mock_tag() {
        let enroll_res: Value = serde_json::from_str(&dispatch_json(
            &json!({
                "cmd": "evaluate_enroll",
                "embeddings_le_b64": [
                    axis_embedding_le_b64(2, 0.0),
                    axis_embedding_le_b64(2, 0.05),
                    axis_embedding_le_b64(2, 0.1),
                ],
                "previous_epoch": 0,
            })
            .to_string(),
        ))
        .unwrap();
        let template_b64 = enroll_res["template_svt1_b64"].as_str().unwrap();

        let request = json!({
            "kind": "transfer",
            "receiver": "alice.testnet",
            "amount_yocto": "15000000000000000000000000",
        });
        let prep: Value = serde_json::from_str(&dispatch_json(
            &json!({
                "cmd": "prepare",
                "owner": "bob.testnet",
                "request": request,
            })
            .to_string(),
        ))
        .unwrap();
        let sentence = prep["sentence"].as_str().unwrap();

        let evaluated: Value = serde_json::from_str(&dispatch_json(
            &json!({
                "cmd": "evaluate_verify",
                "owner": "bob.testnet",
                "request": request,
                "audio_digest_b64u": b64u(&[3u8; 32]),
                "gate_passes": true,
                "audio_reused": false,
                "template_svt1_b64": template_b64,
                "embedding_le_b64": axis_embedding_le_b64(2, 0.02),
                "transcript": sentence,
                "now_ms": 1_760_000_000_000u64,
                "verifier_version": "sayso/0.1.0+mock",
            })
            .to_string(),
        ))
        .unwrap();
        assert_eq!(evaluated["outcome"], "step_up");
        assert_eq!(
            evaluated["policy_text"],
            "A voice payment above 10 NEAR needs a passkey."
        );
        let parsed: Value = serde_json::from_str(evaluated["verdict_json"].as_str().unwrap()).unwrap();
        assert_eq!(parsed["verifier"], "sayso/0.1.0+mock");
    }
}
