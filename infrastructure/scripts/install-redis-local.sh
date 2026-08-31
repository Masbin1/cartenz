#!/usr/bin/env bash
# Builds an unprivileged local Redis into $PREFIX (default: ~/.local).
#
# The supported developer path is infrastructure/compose/docker-compose.yml.
# This script exists only for hosts where Docker and apt are unavailable
# (see docs/adr/ADR-012-local-runtime-without-docker.md).
set -euo pipefail

REDIS_VERSION="${REDIS_VERSION:-7.2.5}"
PREFIX="${PREFIX:-$HOME/.local}"
BUILD_DIR="${BUILD_DIR:-$HOME/.cache/linkederp-build}"

if command -v redis-server >/dev/null 2>&1; then
  echo "redis-server already present at $(command -v redis-server)"
  exit 0
fi

mkdir -p "$BUILD_DIR" "$PREFIX/bin"
cd "$BUILD_DIR"

if [ ! -f "redis-${REDIS_VERSION}.tar.gz" ]; then
  echo "Downloading Redis ${REDIS_VERSION}..."
  curl -fsSL -o "redis-${REDIS_VERSION}.tar.gz" \
    "https://download.redis.io/releases/redis-${REDIS_VERSION}.tar.gz"
fi

rm -rf "redis-${REDIS_VERSION}"
tar xzf "redis-${REDIS_VERSION}.tar.gz"
cd "redis-${REDIS_VERSION}"

echo "Building Redis (MALLOC=libc, $(nproc) jobs)..."
if ! make MALLOC=libc -j"$(nproc)" >/tmp/redis-build.log 2>&1; then
  echo "Build failed. Tail of /tmp/redis-build.log:" >&2
  tail -40 /tmp/redis-build.log >&2
  exit 1
fi

install -m 0755 src/redis-server src/redis-cli "$PREFIX/bin/"
echo "Installed: $PREFIX/bin/redis-server, $PREFIX/bin/redis-cli"
"$PREFIX/bin/redis-server" --version
