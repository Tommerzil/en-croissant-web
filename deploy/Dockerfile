# syntax=docker/dockerfile:1.7

# ---- stage 1: web bundle -------------------------------------------------
FROM node:22-bookworm-slim AS web
WORKDIR /app
# Pinned exactly: a floating major would pick up a future pnpm whose config-key renames
# break this image with no change in this repo.
RUN corepack enable && corepack prepare pnpm@12.3.4 --activate
# pnpm-workspace.yaml carries the build-script approvals; without it here the
# install aborts with ERR_PNPM_IGNORED_BUILDS before `COPY . .` ever runs.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build-web

# ---- stage 2: server binary ---------------------------------------------
FROM rust:1-trixie AS build
# Escape hatch for a memory-starved target: `--build-arg CARGO_BUILD_JOBS=2` caps the codegen/link
# parallelism that OOMs a small aarch64 box. The default is the literal `default` -- cargo's own
# "use all cores" -- and not an empty string, which cargo rejects outright with
# "could not parse ``. Number of parallel jobs should be `default` or a number."
# Declared inside this stage on purpose: a pre-FROM ARG is not visible here and the ENV below
# would then expand to exactly that empty string.
ARG CARGO_BUILD_JOBS=default
ENV CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev git && rm -rf /var/lib/apt/lists/*
COPY src-tauri ./src-tauri
COPY server ./server
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/server/target \
    cd server && cargo build --release && cp target/release/chess-server /chess-server

# ---- stage 3: runtime ----------------------------------------------------
FROM debian:trixie-slim
ARG APP_UID=1000
ARG APP_GID=1000
RUN apt-get update && apt-get install -y --no-install-recommends stockfish ca-certificates curl libssl3t64 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/stockfish && cp /usr/games/stockfish /opt/stockfish/stockfish
COPY --from=build /chess-server /usr/local/bin/chess-server
COPY --from=web /app/dist-web /srv/web
COPY sound /srv/sound
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh && groupadd -g $APP_GID chess && useradd -u $APP_UID -g $APP_GID -m chess
ENV CHESS_DATA_DIR=/data \
    CHESS_BIND=0.0.0.0:8090 \
    CHESS_WEB_DIR=/srv/web \
    CHESS_SOUND_DIR=/srv/sound \
    RUST_LOG=info
USER $APP_UID:$APP_GID
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://127.0.0.1:8090/api/health || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
