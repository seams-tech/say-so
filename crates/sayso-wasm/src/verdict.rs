//! Exact 13-field `seams_voice_signed_verdict_v2` JSON builder and signing preimage.
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::audio::sha256;
use crate::words::{cut_at, MAX_HEARD_BYTES};

pub const VERDICT_DOMAIN: &[u8] = b"seams:outlayer:voice-verdict:v2";
pub const VERDICT_KIND: &str = "seams_voice_signed_verdict_v2";
pub const VERIFIER_VERSION: &str = "sayso/0.1.0";
pub const VERDICT_TTL_MS: u64 = 120_000;
pub const MAX_OUTPUT_BYTES: usize = 1024;

pub fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

pub fn b64u(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Accept,
    StepUp,
    Refuse,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Quality,
    Speaker,
    Words,
    AudioReused,
    AudioInvalid,
    TemplateMissing,
    Unsupported,
    SpeakerUnavailable,
    Storage,
    TemplateExists,
    TranscriberUnavailable,
    TranscriberNotAttested,
    NotAuthorized,
    AuthorizationUnavailable,
    ProposalMissing,
    SameSpeaker,
    AttemptsExhausted,
    DetectorUnavailable,
    SummaryMismatch,
    SummaryCheckUnavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Verdict {
    pub kind: String,
    pub renderer: String,
    pub verifier: String,
    pub request_digest: Option<String>,
    pub spoken_text_digest: Option<String>,
    pub audio_digest: Option<String>,
    pub outcome: Outcome,
    pub reason: Option<Reason>,
    pub policy_rule: Option<String>,
    pub expires_at_ms: u64,
    pub speaker_score_milli: Option<i32>,
    pub word_margin_milli: Option<i32>,
    pub heard: Option<String>,
}

impl Verdict {
    pub fn new(now_ms: u64, verifier_version: Option<&str>) -> Self {
        Self {
            kind: VERDICT_KIND.to_string(),
            renderer: spoken_intent::RENDERER_VERSION.to_string(),
            verifier: verifier_version.unwrap_or(VERIFIER_VERSION).to_string(),
            request_digest: None,
            spoken_text_digest: None,
            audio_digest: None,
            outcome: Outcome::Refuse,
            reason: Some(Reason::Unsupported),
            policy_rule: None,
            expires_at_ms: now_ms.saturating_add(VERDICT_TTL_MS),
            speaker_score_milli: None,
            word_margin_milli: None,
            heard: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MultisigOpening {
    pub commitment: String,
    pub salt: String,
}

pub fn verdict_json(verdict: &Verdict) -> String {
    let mut fit = verdict.clone();
    if let Some(text) = &fit.heard {
        fit.heard = Some(cut_at(text, MAX_HEARD_BYTES));
    }
    let mut json = serde_json::to_string(&fit).expect("verdict serializes");
    for cap in [120usize, 60, 0] {
        if json.len() + 260 <= MAX_OUTPUT_BYTES {
            break;
        }
        fit.heard = verdict
            .heard
            .as_ref()
            .filter(|_| cap > 0)
            .map(|text| cut_at(text, cap));
        json = serde_json::to_string(&fit).expect("verdict serializes");
    }
    json
}

pub fn verdict_message(verdict_json: &[u8]) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(VERDICT_DOMAIN.len() + verdict_json.len());
    preimage.extend_from_slice(VERDICT_DOMAIN);
    preimage.extend_from_slice(verdict_json);
    sha256(&preimage)
}
