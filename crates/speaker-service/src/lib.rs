//! ReDimNet B1 speaker-embedding microservice for Cloudflare Containers.
//!
//! Endpoints:
//! - `POST /v1/embed`: `{"audio_wav_b64", "nonce"}` -> signed 192-float embedding.
//! - `GET /v1/public-key`: Ed25519 public key and pinned ONNX SHA-256.
//! - `GET /healthz`: readiness probe.
pub mod model;

use sha2::{Digest, Sha256};

/// SHA-256 of `redimnet-b1.onnx`.
pub const MODEL_SHA256: &str = "e04dd7a6a1e23fc7b89e47682ea9d0a3946cf7bc59d07922c3db3efc52ae4269";

pub const EMBEDDING_DIM: usize = 192;
pub const SAMPLE_RATE: u32 = 16_000;
pub const MAX_SAMPLES: usize = 8 * SAMPLE_RATE as usize;
pub const MIN_SAMPLES: usize = SAMPLE_RATE as usize / 2;
pub const NONCE_LEN: usize = 32;

/// Domain prefix of the Ed25519 preimage signed by `/v1/embed`.
pub const EMBED_DOMAIN: &[u8] = b"sayso:speaker-embedding:v1";

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

pub fn model_sha256() -> [u8; 32] {
    let mut out = [0; 32];
    hex::decode_to_slice(MODEL_SHA256, &mut out).expect("MODEL_SHA256 is 64 hex characters");
    out
}

/// Reads a RIFF WAV: 16 kHz, mono, PCM16, [`MIN_SAMPLES`]..=[`MAX_SAMPLES`] samples.
pub fn decode_wav(bytes: &[u8]) -> Result<Vec<f32>, &'static str> {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not_wav");
    }
    let mut at = 12;
    let mut format_ok = false;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
        let body_start = at + 8;
        let body_end = body_start.checked_add(size).ok_or("bad_wav_chunk")?;
        if id == b"data" {
            if !format_ok {
                return Err("wav_data_before_fmt");
            }
            let data = &bytes[body_start..body_end.min(bytes.len())];
            let samples = data.len() / 2;
            if !(MIN_SAMPLES..=MAX_SAMPLES).contains(&samples) {
                return Err("wav_length");
            }
            return Ok(data
                .chunks_exact(2)
                .map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32_768.0)
                .collect());
        }
        if body_end > bytes.len() {
            return Err("bad_wav_chunk");
        }
        if id == b"fmt " {
            let fmt = &bytes[body_start..body_end];
            if fmt.len() < 16 {
                return Err("bad_wav_fmt");
            }
            let tag = u16::from_le_bytes([fmt[0], fmt[1]]);
            let channels = u16::from_le_bytes([fmt[2], fmt[3]]);
            let rate = u32::from_le_bytes(fmt[4..8].try_into().unwrap());
            let bits = u16::from_le_bytes([fmt[14], fmt[15]]);
            let pcm = tag == 1 || (tag == 0xFFFE && fmt.len() >= 26 && fmt[24..26] == [1, 0]);
            if !pcm || channels != 1 || rate != SAMPLE_RATE || bits != 16 {
                return Err("wav_not_16k_mono_pcm16");
            }
            format_ok = true;
        }
        at = body_end + (size & 1);
    }
    Err("wav_no_data")
}

pub fn parse_nonce(text: &str) -> Result<[u8; NONCE_LEN], &'static str> {
    let mut out = [0; NONCE_LEN];
    hex::decode_to_slice(text, &mut out).map_err(|_| "bad_nonce")?;
    Ok(out)
}

pub fn embedding_bytes(embedding: &[f32]) -> Vec<u8> {
    embedding.iter().flat_map(|value| value.to_le_bytes()).collect()
}

pub fn embed_message(
    audio_digest: &[u8; 32],
    nonce: &[u8; NONCE_LEN],
    model_sha256: &[u8; 32],
    embedding_le: &[u8],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(EMBED_DOMAIN);
    hasher.update(audio_digest);
    hasher.update(nonce);
    hasher.update(model_sha256);
    hasher.update(embedding_le);
    hasher.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(samples: usize) -> Vec<u8> {
        let data_len = (samples * 2) as u32;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
        wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        for i in 0..samples {
            wav.extend_from_slice(&((i % 200) as i16 * 100 - 10_000).to_le_bytes());
        }
        wav
    }

    #[test]
    fn wav_limits_and_values() {
        let samples = decode_wav(&wav(MIN_SAMPLES)).unwrap();
        assert_eq!(samples.len(), MIN_SAMPLES);
        assert_eq!(samples[0], -10_000.0 / 32_768.0);
        assert_eq!(decode_wav(&wav(MAX_SAMPLES)).unwrap().len(), MAX_SAMPLES);
        assert_eq!(decode_wav(&wav(MIN_SAMPLES - 1)), Err("wav_length"));
        assert_eq!(decode_wav(&wav(MAX_SAMPLES + 1)), Err("wav_length"));
        assert_eq!(decode_wav(b"nope"), Err("not_wav"));
    }

    #[test]
    fn nonce_is_32_bytes_of_hex() {
        assert_eq!(parse_nonce(&"Ab".repeat(32)).unwrap(), [0xab; 32]);
        assert_eq!(parse_nonce(&"ab".repeat(16)), Err("bad_nonce"));
        assert_eq!(parse_nonce(&"zz".repeat(32)), Err("bad_nonce"));
    }

    #[test]
    fn messages_bind_every_part() {
        let embedding = embedding_bytes(&[0.5; EMBEDDING_DIM]);
        assert_eq!(embedding.len(), 768);
        let base = embed_message(&[1; 32], &[2; 32], &[3; 32], &embedding);
        assert_ne!(base, embed_message(&[9; 32], &[2; 32], &[3; 32], &embedding));
        assert_ne!(base, embed_message(&[1; 32], &[9; 32], &[3; 32], &embedding));
        assert_ne!(base, embed_message(&[1; 32], &[2; 32], &[9; 32], &embedding));
    }
}
