//! SaySo ReDimNet B1 HTTP speaker-embedding container service.
//!
//! Environment:
//! - `SPEAKER_LISTEN`: listen address, default `0.0.0.0:8080`.
//! - `SPEAKER_MODEL_PATH`: path to `redimnet-b1.onnx`, default `/app/redimnet-b1.onnx`.
//! - `SPEAKER_SIGNING_KEY_HEX`: optional 64-char hex Ed25519 seed (if unset, generates
//!   a fresh ephemeral Ed25519 key from `/dev/urandom` on container boot).
use std::io::Read as _;
use std::sync::Arc;
use std::time::Instant;

use axum::extract::{DefaultBodyLimit, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::Semaphore;

use sayso_speaker_service::model::Model;
use sayso_speaker_service::{
    decode_wav, embed_message, embedding_bytes, model_sha256, parse_nonce, sha256, MODEL_SHA256,
};

const MAX_BODY_BYTES: usize = 512 * 1024;

struct Service {
    model: Model,
    key: SigningKey,
    public_key: [u8; 32],
    runs: Semaphore,
}

fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

#[derive(Deserialize)]
struct EmbedRequest {
    audio_wav_b64: String,
    nonce: String,
}

async fn embed(State(service): State<Arc<Service>>, body: axum::body::Bytes) -> Response {
    let started = Instant::now();
    let Ok(request) = serde_json::from_slice::<EmbedRequest>(&body) else {
        return error(StatusCode::BAD_REQUEST, "bad_json");
    };
    let Ok(nonce) = parse_nonce(&request.nonce) else {
        return error(StatusCode::BAD_REQUEST, "bad_nonce");
    };
    let Ok(wav) = base64::engine::general_purpose::STANDARD.decode(request.audio_wav_b64.trim())
    else {
        return error(StatusCode::BAD_REQUEST, "bad_base64");
    };
    let audio_digest = sha256(&wav);
    let samples = match decode_wav(&wav) {
        Ok(samples) => samples,
        Err(code) => return error(StatusCode::BAD_REQUEST, code),
    };

    let Ok(_permit) = service.runs.acquire().await else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "shutting_down");
    };
    let model_started = Instant::now();
    let worker = service.clone();
    let embedding = match tokio::task::spawn_blocking(move || worker.model.embed(&samples)).await {
        Ok(Ok(embedding)) => embedding,
        Ok(Err(cause)) => {
            eprintln!("embed: {cause:#}");
            return error(StatusCode::UNPROCESSABLE_ENTITY, "model_failed");
        }
        Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR, "model_panicked"),
    };
    let model_ms = model_started.elapsed().as_millis() as u64;

    let embedding_le = embedding_bytes(&embedding);
    let message = embed_message(&audio_digest, &nonce, &model_sha256(), &embedding_le);
    let signature = service.key.sign(&message);
    let b64 = base64::engine::general_purpose::STANDARD;
    Json(json!({
        "embedding_b64": b64.encode(&embedding_le),
        "audio_digest": hex::encode(audio_digest),
        "model_sha256": MODEL_SHA256,
        "nonce": hex::encode(nonce),
        "public_key": hex::encode(service.public_key),
        "signature": hex::encode(signature.to_bytes()),
        "model_ms": model_ms,
        "total_ms": started.elapsed().as_millis() as u64,
    }))
    .into_response()
}

async fn public_key(State(service): State<Arc<Service>>) -> Response {
    Json(json!({
        "public_key": hex::encode(service.public_key),
        "model_sha256": MODEL_SHA256,
    }))
    .into_response()
}

fn load_signing_key() -> anyhow::Result<SigningKey> {
    if let Ok(text) = std::env::var("SPEAKER_SIGNING_KEY_HEX") {
        let mut seed = [0; 32];
        hex::decode_to_slice(text.trim(), &mut seed)
            .map_err(|_| anyhow::anyhow!("SPEAKER_SIGNING_KEY_HEX must be 64 hex characters"))?;
        return Ok(SigningKey::from_bytes(&seed));
    }
    let mut seed = [0u8; 32];
    let mut urandom = std::fs::File::open("/dev/urandom")?;
    urandom.read_exact(&mut seed)?;
    Ok(SigningKey::from_bytes(&seed))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let listen = std::env::var("SPEAKER_LISTEN").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let model_path =
        std::env::var("SPEAKER_MODEL_PATH").unwrap_or_else(|_| "/app/redimnet-b1.onnx".into());

    let started = Instant::now();
    let model = tokio::task::spawn_blocking(move || Model::load(&model_path)).await??;
    let load_ms = started.elapsed().as_millis();
    let key = load_signing_key()?;
    let public_key_bytes = key.verifying_key().to_bytes();
    let cpus = std::thread::available_parallelism().map_or(1, |n| n.get());
    eprintln!(
        "sayso-speaker-service: model {MODEL_SHA256} plan_ms={load_ms} public_key={} runs={cpus} listen={listen}",
        hex::encode(public_key_bytes)
    );

    let service = Arc::new(Service {
        model,
        key,
        public_key: public_key_bytes,
        runs: Semaphore::new(cpus),
    });
    let app = Router::new()
        .route("/v1/embed", post(embed))
        .route("/v1/public-key", get(public_key))
        .route("/healthz", get(|| async { "ok" }))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(service);
    let listener = tokio::net::TcpListener::bind(&listen).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
