//! General-purpose spoken intent validation and canonical SHA-256 digests (zero chain/Borsh deps).
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::embedding::from_hex;
use crate::verdict::Reason;
use crate::words::{normalize_sentence_tokens, MAX_SENTENCE_WORDS};

pub const INTENT_DIGEST_DOMAIN: &[u8] = b"sayso:intent:v1\0";
/// The domain of a transcript-only intent. Its own domain keeps a verdict whose words SaySo did
/// not check from ever matching the digest of an intent whose words SaySo checks.
pub const TRANSCRIPT_INTENT_DIGEST_DOMAIN: &[u8] = b"sayso:intent:transcript:v1\0";
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
    /// Positions in the normalized sentence where a misheard word is never forgiven, for
    /// example the words of an amount and a recipient. Strictly ascending.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub guarded_word_indexes: Vec<u32>,
    /// SaySo checks the speaker and the audio but not the words: an accepted verdict carries
    /// the transcript in `heard`, and the caller decides whether the words say the request.
    /// An intent cannot have both this and `guarded_word_indexes`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub transcript_only: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedIntent {
    pub user_id: String,
    pub action: String,
    pub payload_sha256: [u8; 32],
    pub expected_tokens: Vec<String>,
    pub canonical_sentence: String,
    pub display_text: String,
    /// Strictly ascending positions in `expected_tokens`.
    pub guarded_word_indexes: Vec<u8>,
    pub transcript_only: bool,
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
    let guarded_word_indexes =
        validate_guarded_word_indexes(&input.guarded_word_indexes, expected_tokens.len())?;
    if input.transcript_only && !guarded_word_indexes.is_empty() {
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
        guarded_word_indexes,
        transcript_only: input.transcript_only,
    })
}

/// One list has one form: strictly ascending, each index a position in the sentence.
fn validate_guarded_word_indexes(indexes: &[u32], word_count: usize) -> Result<Vec<u8>, Reason> {
    let ascending = indexes.windows(2).all(|pair| pair[0] < pair[1]);
    let in_sentence = indexes
        .last()
        .is_none_or(|&last| usize::try_from(last).is_ok_and(|last| last < word_count));
    if !ascending || !in_sentence {
        return Err(Reason::Unsupported);
    }
    // A position is below `MAX_SENTENCE_WORDS`, so it fits in one byte.
    indexes
        .iter()
        .map(|&index| u8::try_from(index).map_err(|_| Reason::Unsupported))
        .collect()
}

/// Canonical `intent_digest`:
/// `SHA-256("sayso:intent:v1\0" || lp(user_id) || lp(action) || payload_sha256 || lp(canonical_sentence) || guards)`
/// where `lp(b) = u32_le(b.len()) || b`. `guards` is `lp(guarded_word_indexes)` with one byte
/// for each index, and it is empty for an intent with no guarded words. So such an intent
/// keeps the digest that it had before guarded words, and each preimage still reads in one way.
/// A transcript-only intent uses [`TRANSCRIPT_INTENT_DIGEST_DOMAIN`] in place of the first domain.
pub fn intent_digest(intent: &ValidatedIntent) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(if intent.transcript_only {
        TRANSCRIPT_INTENT_DIGEST_DOMAIN
    } else {
        INTENT_DIGEST_DOMAIN
    });
    update_lp(&mut hasher, intent.user_id.as_bytes());
    update_lp(&mut hasher, intent.action.as_bytes());
    hasher.update(intent.payload_sha256);
    update_lp(&mut hasher, intent.canonical_sentence.as_bytes());
    if !intent.guarded_word_indexes.is_empty() {
        update_lp(&mut hasher, &intent.guarded_word_indexes);
    }
    hasher.finalize().into()
}

/// Canonical `spoken_text_digest`: `SHA-256("sayso:spoken:v1\0" || canonical_sentence)`.
pub fn spoken_text_digest(canonical_sentence: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(SPOKEN_TEXT_DIGEST_DOMAIN);
    hasher.update(canonical_sentence.as_bytes());
    hasher.finalize().into()
}

fn update_lp(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u32).to_le_bytes());
    hasher.update(bytes);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embedding::hex_string;

    fn transfer(guarded_word_indexes: &[u32]) -> IntentInput {
        IntentInput {
            user_id: "near:testnet:alice.testnet".to_string(),
            action: "seams.near.transfer".to_string(),
            payload_sha256_hex: "42".repeat(32),
            sentence: "send ten near to bob dot testnet".to_string(),
            guarded_word_indexes: guarded_word_indexes.to_vec(),
            transcript_only: false,
        }
    }

    fn digest_hex(guarded_word_indexes: &[u32]) -> String {
        let valid = validate_intent(&transfer(guarded_word_indexes)).expect("valid intent");
        hex_string(&intent_digest(&valid))
    }

    /// `packages/sayso-verdict/tests/verdict.test.ts` pins the same two values for `createIntent`.
    #[test]
    fn guarded_words_extend_the_digest_and_no_guards_keep_it() {
        assert_eq!(
            digest_hex(&[]),
            "51bc8d22b29c0220a5cfb1a90c3ebebea5757c7f8293c0062beef13cb5968e86"
        );
        assert_eq!(
            digest_hex(&[1, 2, 4, 5, 6]),
            "a63e63c8e79f1e78101657310a9b5eedf1672fd5f55cf677db2be5accf86a583"
        );
        assert_ne!(digest_hex(&[1, 2, 4, 5]), digest_hex(&[1, 2, 4, 5, 6]));
    }

    /// `packages/sayso-verdict/tests/verdict.test.ts` pins the same value for `createIntent`.
    #[test]
    fn a_transcript_only_intent_has_its_own_digest_domain() {
        let intent = IntentInput { transcript_only: true, ..transfer(&[]) };
        let valid = validate_intent(&intent).expect("valid intent");
        let digest = hex_string(&intent_digest(&valid));
        assert_eq!(
            digest,
            "7f0d21a683dbffa7dd0678670db1a8d339e510c36548eb823408e3cca3100d9f"
        );
        assert_ne!(digest, digest_hex(&[]));
        let both = IntentInput { transcript_only: true, ..transfer(&[1]) };
        assert_eq!(validate_intent(&both), Err(Reason::Unsupported));
    }

    #[test]
    fn guarded_word_indexes_must_ascend_inside_the_sentence() {
        for good in [&[][..], &[0], &[6], &[0, 1, 2, 3, 4, 5, 6]] {
            assert!(validate_intent(&transfer(good)).is_ok(), "{good:?}");
        }
        for bad in [&[7][..], &[2, 1], &[1, 1], &[0, 300], &[u32::MAX]] {
            assert_eq!(validate_intent(&transfer(bad)), Err(Reason::Unsupported), "{bad:?}");
        }
    }
}
