# ── Stage 1: Build (native cross-compile, no QEMU) ────────────
FROM rust:slim-bookworm AS builder

# Install native + cross-compile toolchains
RUN apt-get update && apt-get install -y \
      pkg-config libssl-dev \
      gcc-aarch64-linux-gnu libc6-dev-arm64-cross \
      libssl-dev:arm64 || true \
    && rm -rf /var/lib/apt/lists/*

# Enable Debian multiarch for arm64 OpenSSL headers
RUN dpkg --add-architecture arm64 \
    && apt-get update \
    && apt-get install -y libssl-dev:arm64 \
    || true \
    && rm -rf /var/lib/apt/lists/*

# Add Rust cross-compile targets
RUN rustup target add x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu

WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src ./src

# Build arg: TARGETARCH is injected by Docker buildx (amd64 or arm64)
ARG TARGETARCH

RUN if [ "$TARGETARCH" = "arm64" ]; then \
      export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
      && export PKG_CONFIG_SYSROOT_DIR=/usr/aarch64-linux-gnu \
      && export PKG_CONFIG_PATH=/usr/lib/aarch64-linux-gnu/pkgconfig \
      && export OPENSSL_DIR=/usr/aarch64-linux-gnu \
      && export OPENSSL_INCLUDE_DIR=/usr/include/aarch64-linux-gnu \
      && export OPENSSL_LIB_DIR=/usr/lib/aarch64-linux-gnu \
      && cargo build --release --target aarch64-unknown-linux-gnu \
      && cp target/aarch64-unknown-linux-gnu/release/paperphone-server target/release/paperphone-server; \
    else \
      cargo build --release; \
    fi

# ── Stage 2: Runtime ───────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates wget && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/target/release/paperphone-server .

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=5 --start-period=15s \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["./paperphone-server"]
