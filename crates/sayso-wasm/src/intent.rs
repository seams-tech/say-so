//! General-purpose spoken intent validation and canonical SHA-256 digests (zero chain/Borsh deps).
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::embedding::from_hex;
use crate::verdict::Reason;
use crate::words::{normalize_sentence_tokens, MAX_SENTENCE_WORDS};

pub const INTENT_DIGEST_DOMAIN: &[u8] = b"sayso:intent:v1\0";
pub const SPOKEN_TEXT_DIGEST_DOMAIN: &[u8] = b"sayso:spoken:v1\0";
pub const MAX_USER_ID_BYTES: usize = 128;
pub const MAX_ACTION_BYTES: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntentInput {
    pub user_id: String,
    pub action: String,
    pub payload_sha256_hex: String,
    pub sentence: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedIntent {
    pub user_id: String,
    pub action: String,
    pub payload_sha256: [u8; 32],
    pub expected_tokens: Vec<String>,
    pub canonical_sentence: String,
    pub display_text: String,
}

pub fn validate_user_id(user_id: &str) -> Result<&str, Reason> {
    if user_id.is_empty()
        || user_id.len() > MAX_USER_ID_BYTES
        || user_id.bytes().any(|b| b < 0x21 || b == 0x7f)
    {
        return Err(Reason::Unsupported);
    }
    Ok(user_id)
}

pub fn validate_action(action: &str) -> Result<&str, Reason> {
    let valid_byte =
        |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-:/".contains(&b);
    if action.is_empty() || action.len() > MAX_ACTION_BYTES || !action.bytes().all(valid_byte) {
        return Err(Reason::Unsupported);
    }
    Ok(action)
}

pub fn lowercase_hex_32(text: &str) -> Result<[u8; 32], Reason> {
    let lowercase = text
        .bytes()
        .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    from_hex::<32>(text)
        .filter(|_| lowercase)
        .ok_or(Reason::Unsupported)
}

pub fn validate_intent(input: &IntentInput) -> Result<ValidatedIntent, Reason> {
    let user_id = validate_user_id(&input.user_id)?.to_string();
    let action = validate_action(&input.action)?.to_string();
    let payload_sha256 = lowercase_hex_32(&input.payload_sha256_hex)?;
    let display_text = input.sentence.trim().to_string();
    if display_text.is_empty() || display_text.len() > 160 {
        return Err(Reason::Unsupported);
    }
    let expected_tokens = normalize_sentence_tokens(&display_text).ok_or(Reason::Unsupported)?;
    if expected_tokens.is_empty() || expected_tokens.len() > MAX_SENTENCE_WORDS {
        return Err(Reason::Unsupported);
    }
    let canonical_sentence = expected_tokens.join(" ");
    Ok(ValidatedIntent {
        user_id,
        action,
        payload_sha256,
        expected_tokens,
        canonical_sentence,
        display_text,
    })
}

/// Canonical `intent_digest`:
/// `SHA-256("sayso:intent:v1\0" || lp(user_id) || lp(action) || payload_sha256 || lp(canonical_sentence))`
/// where `lp(s) = u32_le(s.len()) || s.as_bytes()`.
pub fn intent_digest(intent: &ValidatedIntent) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(INTENT_DIGEST_DOMAIN);
    update_lp(&mut hasher, &intent.user_id);
    update_lp(&mut hasher, &intent.action);
    hasher.update(intent.payload_sha256);
    update_lp(&mut hasher, &intent.canonical_sentence);
    hasher.finalize().into()
}

/// Canonical `spoken_text_digest`: `SHA-256("sayso:spoken:v1\0" || canonical_sentence)`.
pub fn spoken_text_digest(canonical_sentence: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(SPOKEN_TEXT_DIGEST_DOMAIN);
    hasher.update(canonical_sentence.as_bytes());
    hasher.finalize().into()
}

fn update_lp(hasher: &mut Sha256, text: &str) {
    hasher.update((text.len() as u32).to_le_bytes());
    hasher.update(text.as_bytes());
}
