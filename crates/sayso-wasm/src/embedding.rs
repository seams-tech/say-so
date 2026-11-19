//! ReDimNet B1 192-float embeddings, enrollment agreement, and 808-byte `SVT1` templates.

pub const EMBEDDING_DIM: usize = 192;
pub const SPEAKER_CUTOFF_MILLI: i32 = 450;
pub const REDIMNET_SHA256_HEX: &str = "e04dd7a6a1e23fc7b89e47682ea9d0a3946cf7bc59d07922c3db3efc52ae4269";

const TEMPLATE_MAGIC: &[u8; 4] = b"SVT1";
pub const TEMPLATE_RECORD_LEN: usize = 4 + 4 + 32 + 4 * EMBEDDING_DIM;

pub fn from_hex<const N: usize>(text: &str) -> Option<[u8; N]> {
    if text.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (index, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(out)
}

pub fn hex_string(bytes: &[u8]) -> String {
    const LUT: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(LUT[(byte >> 4) as usize] as char);
        out.push(LUT[(byte & 0x0f) as usize] as char);
    }
    out
}

pub fn model_sha256() -> [u8; 32] {
    from_hex::<32>(REDIMNET_SHA256_HEX).expect("pinned hex")
}

#[derive(Clone, Debug, PartialEq)]
pub struct Embedding(Vec<f32>);

impl Embedding {
    pub fn from_raw(values: &[f32]) -> Option<Self> {
        if values.len() != EMBEDDING_DIM || !values.iter().all(|value| value.is_finite()) {
            return None;
        }
        let squared = squared_norm(values);
        if squared < 1e-12 {
            return None;
        }
        let norm = squared.sqrt();
        Some(Self(
            values
                .iter()
                .map(|value| (f64::from(*value) / norm) as f32)
                .collect(),
        ))
    }

    pub fn from_unit(values: Vec<f32>) -> Option<Self> {
        if values.len() != EMBEDDING_DIM
            || !values.iter().all(|value| value.is_finite())
            || (squared_norm(&values) - 1.0).abs() > 1e-3
        {
            return None;
        }
        Some(Self(values))
    }

    pub fn values(&self) -> &[f32] {
        &self.0
    }
}

fn squared_norm(values: &[f32]) -> f64 {
    values
        .iter()
        .map(|value| f64::from(*value) * f64::from(*value))
        .sum()
}

pub fn f32_values_le(bytes: &[u8]) -> Option<Vec<f32>> {
    if bytes.len() != EMBEDDING_DIM * 4 {
        return None;
    }
    Some(
        bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect(),
    )
}

pub fn similarity_milli(left: &Embedding, right: &Embedding) -> i32 {
    let score: f64 = left
        .0
        .iter()
        .zip(&right.0)
        .map(|(a, b)| f64::from(*a) * f64::from(*b))
        .sum();
    (score * 1_000.0).floor() as i32
}

pub fn speaker_passes(score_milli: i32) -> bool {
    score_milli >= SPEAKER_CUTOFF_MILLI
}

#[derive(Debug, PartialEq)]
pub enum Agreement {
    Agreed {
        template: Embedding,
        agreement_milli: i32,
    },
    Disagreed {
        agreement_milli: i32,
    },
}

pub fn agreement(samples: &[Embedding]) -> Agreement {
    let mut agreement_milli = i32::MAX;
    for (index, left) in samples.iter().enumerate() {
        for right in &samples[index + 1..] {
            agreement_milli = agreement_milli.min(similarity_milli(left, right));
        }
    }
    if samples.len() < 2 || !speaker_passes(agreement_milli) {
        return Agreement::Disagreed {
            agreement_milli: agreement_milli.min(1_000),
        };
    }
    let mut mean = vec![0f32; EMBEDDING_DIM];
    for sample in samples {
        for (slot, value) in mean.iter_mut().zip(&sample.0) {
            *slot += value / samples.len() as f32;
        }
    }
    match Embedding::from_raw(&mean) {
        Some(template) => Agreement::Agreed {
            template,
            agreement_milli,
        },
        None => Agreement::Disagreed { agreement_milli },
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct TemplateRecord {
    pub epoch: u32,
    pub model_sha256: [u8; 32],
    pub template: Embedding,
}

impl TemplateRecord {
    pub fn encode(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(TEMPLATE_RECORD_LEN);
        bytes.extend_from_slice(TEMPLATE_MAGIC);
        bytes.extend_from_slice(&self.epoch.to_le_bytes());
        bytes.extend_from_slice(&self.model_sha256);
        for value in self.template.values() {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes
    }

    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != TEMPLATE_RECORD_LEN || &bytes[..4] != TEMPLATE_MAGIC {
            return None;
        }
        let epoch = u32::from_le_bytes(bytes[4..8].try_into().ok()?);
        let model_sha256: [u8; 32] = bytes[8..40].try_into().ok()?;
        let values = f32_values_le(&bytes[40..])?;
        let template = Embedding::from_unit(values)?;
        Some(Self {
            epoch,
            model_sha256,
            template,
        })
    }
}
