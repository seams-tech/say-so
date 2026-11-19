//! WAV decoding, canonical 44-byte 16 kHz mono PCM16 WAV encoding, and the energy gate.
use sha2::{Digest, Sha256};

pub const SAMPLE_RATE: u32 = 16_000;
pub const MAX_SAMPLES: usize = 8 * SAMPLE_RATE as usize;
pub const GATE_FRAME: usize = 512;
pub const GATE_LEVEL_RMS: f32 = 0.006;
pub const GATE_MIN_VOICED_MS: u32 = 600;
pub const GATE_MAX_CLIPPED_PERMILLE: u32 = 10;

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// Converts raw little-endian 16-bit mono PCM bytes to `i16` samples.
pub fn decode_pcm16_le(bytes: &[u8]) -> Result<Vec<i16>, &'static str> {
    if bytes.len() % 2 != 0 {
        return Err("pcm_odd_byte_length");
    }
    let samples = bytes.len() / 2;
    if samples == 0 || samples > MAX_SAMPLES {
        return Err("wav_length");
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect())
}

/// Reads a RIFF WAV: PCM (or WAVE_FORMAT_EXTENSIBLE with PCM), 16 kHz, mono, 16-bit,
/// 1 to [`MAX_SAMPLES`] samples.
pub fn decode_wav(bytes: &[u8]) -> Result<Vec<i16>, &'static str> {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not_wav");
    }
    let mut at = 12;
    let mut format_ok = false;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]]) as usize;
        let body_start = at + 8;
        let body_end = body_start.checked_add(size).ok_or("bad_wav_chunk")?;
        if id == b"data" {
            if !format_ok {
                return Err("wav_data_before_fmt");
            }
            let data = &bytes[body_start..body_end.min(bytes.len())];
            let samples = data.len() / 2;
            if samples == 0 || samples > MAX_SAMPLES {
                return Err("wav_length");
            }
            return Ok(data
                .chunks_exact(2)
                .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
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
            let rate = u32::from_le_bytes([fmt[4], fmt[5], fmt[6], fmt[7]]);
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

/// Encodes `i16` samples into the canonical 44-byte header WAV at 16 kHz mono PCM16.
pub fn wav_bytes(pcm: &[i16]) -> Vec<u8> {
    let data_len = (pcm.len() * 2) as u32;
    let mut wav = Vec::with_capacity(44 + pcm.len() * 2);
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
    for sample in pcm {
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    wav
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GateReport {
    pub voiced_ms: u32,
    pub clipped_permille: u32,
}

impl GateReport {
    pub fn passes(&self) -> bool {
        self.voiced_ms >= GATE_MIN_VOICED_MS && self.clipped_permille <= GATE_MAX_CLIPPED_PERMILLE
    }
}

pub fn energy_gate(pcm: &[i16]) -> GateReport {
    let mut voiced_samples: u64 = 0;
    for frame in pcm.chunks(GATE_FRAME) {
        let energy: f32 = frame
            .iter()
            .map(|sample| {
                let value = f32::from(*sample) / 32_768.0;
                value * value
            })
            .sum();
        let rms = (energy / frame.len() as f32).sqrt();
        if rms >= GATE_LEVEL_RMS {
            voiced_samples += frame.len() as u64;
        }
    }
    let clipped = pcm
        .iter()
        .filter(|sample| **sample == i16::MAX || **sample == i16::MIN)
        .count() as u64;
    let clipped_permille = if pcm.is_empty() {
        0
    } else {
        (clipped * 1_000 / pcm.len() as u64) as u32
    };
    GateReport {
        voiced_ms: (voiced_samples * 1_000 / u64::from(SAMPLE_RATE)) as u32,
        clipped_permille,
    }
}
