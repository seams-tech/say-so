# Cloudflare Containers image for SaySo ReDimNet B1 speaker embeddings (linux/amd64).
#
# Override MODEL_URL via `--build-arg MODEL_URL=https://<your-r2-or-release>/redimnet-b1.onnx`.
# The exact SHA-256 digest is always cryptographically verified at build time and boot time.

FROM rust:1.97.1-slim-bookworm AS build
ARG MODEL_URL="https://test.fastfs.io/seams-v1.testnet/outlayer.testnet/e04dd7a6a1e23fc7b89e47682ea9d0a3946cf7bc59d07922c3db3efc52ae4269.onnx"
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src src
RUN cargo build --locked --release --target x86_64-unknown-linux-gnu \
 && cp target/x86_64-unknown-linux-gnu/release/speaker-service /speaker-service \
 && curl -fsSL "${MODEL_URL}" -o /redimnet-b1.onnx \
 && echo "e04dd7a6a1e23fc7b89e47682ea9d0a3946cf7bc59d07922c3db3efc52ae4269  /redimnet-b1.onnx" | sha256sum -c -

FROM debian:bookworm-slim
COPY --from=build /speaker-service /usr/local/bin/speaker-service
COPY --from=build /redimnet-b1.onnx /app/redimnet-b1.onnx
RUN echo "e04dd7a6a1e23fc7b89e47682ea9d0a3946cf7bc59d07922c3db3efc52ae4269  /app/redimnet-b1.onnx" | sha256sum -c -
ENV SPEAKER_LISTEN=0.0.0.0:8080 \
    SPEAKER_MODEL_PATH=/app/redimnet-b1.onnx
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/speaker-service"]
