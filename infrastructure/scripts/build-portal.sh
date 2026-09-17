#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# LinkedERP - build the portal, correctly, or not at all
# ============================================================
#
# The one way this build goes wrong is silent, and it has now happened three
# times on this host: `next build` run without NEXT_PUBLIC_API_URL and
# NEXT_PUBLIC_WS_URL exported does not fail - it bakes
# `http://localhost:4000` into the browser bundle, because
# frontend/next.config.mjs defaults both to it. Every visitor's browser then
# calls its own laptop, and the login page reports "Could not reach the API.
# Check that the backend is running." while all five services are green.
#
# So this script does the two things a person forgets:
#
#   1. It exports exactly those two variables, derived from PROJECT_BASE_DOMAIN,
#      and NOTHING else from .env. Sourcing that file wholesale is the other trap:
#      it carries NODE_ENV=development, and `next build` under a non-production
#      NODE_ENV fails with an unrelated-looking error about <Html> being imported
#      outside pages/_document.
#   2. It reads the finished bundle back and fails if the wrong URL is in it.
#      A build that exits 0 proves nothing about what it emitted.
#
# Usage:
#   ./build-portal.sh                 # build, then verify
#   ./build-portal.sh --verify-only   # just check what is on disk now
#
# Both values come from NEXT_PUBLIC_API_URL / NEXT_PUBLIC_WS_URL in /opt/cartenz/.env,
# or from an already-exported shell value if one is set.
#
# It refuses to run as root. A root-run build leaves ~200 root-owned files under
# .next/static, which the next build cannot overwrite (EACCES: permission denied,
# unlink ...), so the trap does not just break this build - it breaks the next one.
#
# ============================================================

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FRONTEND_DIR="${REPO_ROOT}/frontend"
ENV_FILE="${REPO_ROOT}/.env"

VERIFY_ONLY=0
[[ "${1:-}" == "--verify-only" ]] && VERIFY_ONLY=1

fail() { printf '\n!! %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s ==\n' "$*"; }

if [[ "$EUID" -eq 0 ]]; then
    fail "Do not build the portal as root. It leaves root-owned files under frontend/.next, and the NEXT build then fails with EACCES. Run it as the cartenz user."
fi

# The two values, read from .env as values - never sourced. .env is the single
# source of runtime config on this host and already names both explicitly; the
# only reason they are read here rather than by npm is that a build does not read
# .env at all, which is the entire problem this script exists for.
#
# PROJECT_BASE_DOMAIN is deliberately NOT used as the fallback: that is the base
# for *project* instances (ggroma.masbintang.space), while the portal lives at its
# own host (cartenz.masbintang.space), and deriving one from the other produces a
# plausible wrong answer - the worst kind here.
read_env_value() {
    grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- \
        | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

API_URL="${NEXT_PUBLIC_API_URL:-$(read_env_value NEXT_PUBLIC_API_URL)}"
WS_URL="${NEXT_PUBLIC_WS_URL:-$(read_env_value NEXT_PUBLIC_WS_URL)}"

if [[ -z "$API_URL" || -z "$WS_URL" ]]; then
    fail "NEXT_PUBLIC_API_URL / NEXT_PUBLIC_WS_URL are not set, in this shell or in ${ENV_FILE}. Add them there (they are public values, not secrets) rather than building without them."
fi

verify_bundle() {
    step "Verifying what the build actually emitted"

    local chunks_dir="${FRONTEND_DIR}/.next/static/chunks"
    [[ -d "$chunks_dir" ]] || fail "No ${chunks_dir} - there is no build to verify."

    local bad=0

    # 1. The fallback must not be in the bundle at all.
    # NOTE: a `grep` that finds nothing exits 1, and under `set -e` + `pipefail` an
    # assignment from such a pipeline aborts the whole script - silently, before
    # the line below it prints anything. The first version of this function did
    # exactly that: it reported "unusable" by dying with no output whenever the
    # bundle was in fact correct. `|| true` inside the subshell is what keeps a
    # "no match" answer from being read as a failure.
    local localhost_hits
    localhost_hits="$( (grep -rho 'localhost:4000' "$chunks_dir" 2>/dev/null || true) | wc -l )"
    if [[ "$localhost_hits" -gt 0 ]]; then
        printf '   !! %s occurrence(s) of localhost:4000 in the bundle\n' "$localhost_hits"
        bad=1
    else
        printf '   ok  no localhost:4000 in the bundle\n'
    fi

    # 2. The configured URL must be, for both the API and the websocket.
    for url in "$API_URL" "$WS_URL"; do
        if grep -rq "$url" "$chunks_dir" 2>/dev/null; then
            printf '   ok  %s present\n' "$url"
        else
            printf '   !! %sNOT present in the bundle\n' "$url "
            bad=1
        fi
    done

    # 3. Ownership: a root-owned .next cannot be rebuilt over.
    local root_owned
    root_owned="$( (find "${FRONTEND_DIR}/.next" ! -user "$(id -un)" 2>/dev/null || true) | wc -l )"
    if [[ "$root_owned" -gt 0 ]]; then
        printf '   !! %s file(s) under .next are not owned by %s\n' "$root_owned" "$(id -un)"
        bad=1
    else
        printf '   ok  .next is owned by %s\n' "$(id -un)"
    fi

    [[ "$bad" -eq 0 ]] || fail "This build is not usable. Do NOT serve it: the browser would call the wrong API. See the lines above."
}

if [[ "$VERIFY_ONLY" -eq 1 ]]; then
    verify_bundle
    printf '\nThe build on disk is the one you configured.\n'
    exit 0
fi

step "Building the portal against ${API_URL}"
printf '   NEXT_PUBLIC_API_URL=%s\n   NEXT_PUBLIC_WS_URL=%s\n' "$API_URL" "$WS_URL"

# A root-owned .next from an earlier root build cannot be overwritten in place,
# and `rm -rf` fails on the root-owned files inside it. Renaming it aside needs
# only write on frontend/, which this user has. Same recovery as dist/.
if [[ -d "${FRONTEND_DIR}/.next" ]] \
    && [[ "$(find "${FRONTEND_DIR}/.next" ! -user "$(id -un)" 2>/dev/null | wc -l)" -gt 0 ]]; then
    STALE="${FRONTEND_DIR}/.next.broken-root-$(date +%Y%m%d-%H%M%S)"
    mv "${FRONTEND_DIR}/.next" "$STALE"
    printf '   moved the unwritable build aside: %s\n' "$(basename "$STALE")"
fi

cd "$FRONTEND_DIR"

# env -u NODE_ENV because this shell may already carry one from an earlier
# `source .env` in the same session, and a non-production NODE_ENV breaks the build.
env -u NODE_ENV \
    NEXT_PUBLIC_API_URL="$API_URL" \
    NEXT_PUBLIC_WS_URL="$WS_URL" \
    NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1024}" \
    npm run build

verify_bundle

cat <<EOF

Build verified. The portal serves it after a restart, which is root-gated:

    sudo systemctl restart cartenz-portal

Expect the portal to be unavailable for a few seconds. Verify with:

    curl -s http://127.0.0.1:3000/login | grep -o 'chunks/193-[a-f0-9]*\\.js' | sort -u

EOF
