//! Clean 12-field `sayso_verdict_v1` JSON builder and Ed25519 signing preimage.
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::audio::sha256;
use crate::words::{cut_at, MAX_HEARD_BYTES};

pub const VERDICT_DOMAIN: &[u8] = b"sayso:verdict:v1";
pub const VERDICT_KIND: &str = "sayso_verdict_v1";
pub const VERIFIER_VERSION: &str = "sayso/0.2.0";
pub const VERDICT_TTL_MS: u64 = 120_000;

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
    TranscriberUnavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Verdict {
    pub kind: String,
    pub verifier: String,
    pub user_id: Option<String>,
    pub action: Option<String>,
    pub intent_digest: Option<String>,
    pub spoken_text_digest: Option<String>,
    pub audio_digest: Option<String>,
    pub outcome: Outcome,
    pub reason: Option<Reason>,
    pub expires_at_ms: u64,
    pub speaker_score_milli: Option<i32>,
    /// The normalized words heard, on a `words` refusal. For a transcript-only intent, the
    /// transcript as written, on `accept`. Otherwise `null`.
    pub heard: Option<String>,
}

impl Verdict {
    pub fn new(now_ms: u64, verifier_version: Option<&str>) -> Self {
        Self {
            kind: VERDICT_KIND.to_string(),
            verifier: verifier_version.unwrap_or(VERIFIER_VERSION).to_string(),
            user_id: None,
            action: None,
            intent_digest: None,
            spoken_text_digest: None,
            audio_digest: None,
            outcome: Outcome::Refuse,
            reason: Some(Reason::Unsupported),
            expires_at_ms: now_ms.saturating_add(VERDICT_TTL_MS),
            speaker_score_milli: None,
            heard: None,
        }
    }
}

pub fn verdict_json(verdict: &Verdict) -> String {
    let mut fit = verdict.clone();
    if let Some(text) = &fit.heard {
        fit.heard = Some(cut_at(text, MAX_HEARD_BYTES));
    }
    serde_json::to_string(&fit).expect("verdict serializes")
}

/// `SHA-256("sayso:verdict:v1" || verdict_json)`: the 32-byte digest signed by Ed25519.
pub fn verdict_message(verdict_json: &[u8]) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(VERDICT_DOMAIN.len() + verdict_json.len());
    preimage.extend_from_slice(VERDICT_DOMAIN);
    preimage.extend_from_slice(verdict_json);
    sha256(&preimage)
}
