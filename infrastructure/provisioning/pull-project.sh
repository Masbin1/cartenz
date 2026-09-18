#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# LinkedERP - pull a project's repository into its instance
# ============================================================
#
# Runs as root via the narrow sudoers rule in
# infrastructure/provisioning/99-linkederp-provisioning, called by the platform
# (backend/src/modules/projects/project-deployment.service.ts) when an operator
# asks for an on-premise project to be brought up to date with its repository.
#
# This is the odoo.sh half the platform was missing: ADR-041 gives a created
# project a GitHub repository and reaches it, and the provisioned instance
# serves whatever checkout happened to exist when create_project ran - but
# nothing ever pulled. A commit pushed to the project's branch never reached the
# running Odoo.
#
# Usage:
#   pull-project <project_name> <repository_url> <branch>
#
# The optional credential is read from stdin (one line, no trailing newline
# required) and never appears in argv, in `ps`, or in this process's command
# line: an HTTPS token for a GitHub/GitLab remote, or the path to an SSH private
# key for an scp-style remote. Absent means the remote is public.
#
#   echo "$TOKEN"     | pull-project ggroma https://github.com/owner/repo.git main
#   echo "$KEY_PATH"  | pull-project ggroma git@github.com:owner/repo.git main
#
# What it does NOT do: it will not run against a project directory it did not
# expect to find, it will not follow a symlinked project or addons directory,
# and it discards local modifications in addons/ (see below).
#
# ============================================================

BASE_DIR="/opt/odoo"
PROJECTS_DIR="${BASE_DIR}/projects"
ODOO_USER="odoo"
PLATFORM_GROUP="cartenz"

usage() {
    echo
    echo "Usage:"
    echo "  pull-project <project_name> <repository_url> <branch>"
    echo
    echo "  Reads an optional HTTPS token or SSH key path from stdin."
    echo
    exit 1
}

if [[ "$EUID" -ne 0 ]]; then
    echo "ERROR: This script must be run as root." >&2
    exit 1
fi

if [[ $# -ne 3 ]]; then
    usage
fi

PROJECT_NAME="$1"
REPOSITORY_URL="$2"
BRANCH="$3"

# --- Argument validation -----------------------------------------------------
#
# Same shape assertProvisioningInvocation enforces on the platform side. Both
# gates exist on purpose: this one must hold even when the script is run by hand.

if [[ ! "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]{1,30}$ ]]; then
    echo "ERROR: Invalid project name: '${PROJECT_NAME}'." >&2
    exit 1
fi

# A branch name that begins with a dash would be read as an option by git.
if [[ ! "$BRANCH" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$ ]]; then
    echo "ERROR: Invalid branch name: '${BRANCH}'." >&2
    exit 1
fi

# https:// (with an optional user@), or scp-style user@host:path. Nothing else:
# a file:// remote would let a caller read any repository on this host, which is
# the reason ADR-026 keeps that behind its own setting off by default.
if [[ ! "$REPOSITORY_URL" =~ ^https://[A-Za-z0-9._~%:@/+-]+$ ]] \
    && [[ ! "$REPOSITORY_URL" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._/-]+$ ]]; then
    echo "ERROR: Unsupported repository URL: '${REPOSITORY_URL}'." >&2
    echo "       Only https:// and scp-style (git@host:owner/repo.git) remotes are accepted." >&2
    exit 1
fi

PROJECT_DIR="${PROJECTS_DIR}/${PROJECT_NAME}"
ADDONS_DIR="${PROJECT_DIR}/addons"

# --- Ground truth: the directories, and who may touch them -------------------
#
# Not a symlink: a project directory that resolves elsewhere is either a mistake
# or an attempt to make this script write outside the projects root.

if [[ ! -d "$PROJECT_DIR" ]]; then
    echo "ERROR: Project directory does not exist: ${PROJECT_DIR}" >&2
    exit 1
fi

if [[ -L "$PROJECT_DIR" || -L "$ADDONS_DIR" ]]; then
    echo "ERROR: ${PROJECT_DIR} or its addons/ is a symlink; refusing to pull through it." >&2
    exit 1
fi

if [[ ! -d "$ADDONS_DIR" ]]; then
    echo "ERROR: addons/ does not exist under ${PROJECT_DIR}" >&2
    exit 1
fi

if ! id -u "$ODOO_USER" >/dev/null 2>&1; then
    echo "ERROR: User '${ODOO_USER}' does not exist." >&2
    exit 1
fi

PLATFORM_USER="$(id -un)"
if [[ -n "${SUDO_USER:-}" ]]; then
    PLATFORM_USER="${SUDO_USER}"
fi

# --- Credential, read from stdin ---------------------------------------------
#
# Read once, into a variable, and held in a file that only the odoo user can
# read for as long as git needs it. Never in argv: /proc/<pid>/cmdline is
# world-readable on this host.

CREDENTIAL=""
if [[ ! -t 0 ]]; then
    CREDENTIAL="$(cat || true)"
    CREDENTIAL="${CREDENTIAL%%$'\n'*}"
fi

SECRET_DIR=""
cleanup() {
    if [[ -n "$SECRET_DIR" && -d "$SECRET_DIR" ]]; then
        rm -rf "$SECRET_DIR"
    fi
}
trap cleanup EXIT

GIT_ENV=(
    -u GIT_CONFIG_GLOBAL
    -u GIT_CONFIG_SYSTEM
    -u GIT_DIR
    -u GIT_WORK_TREE
    -u GIT_INDEX_FILE
)

if [[ "$REPOSITORY_URL" == http* ]]; then
    if [[ -n "$CREDENTIAL" ]]; then
        # /run rather than /tmp would put this beside the platform's own
        # secrets, but /run on this host is mounted noexec: the askpass
        # helper below has to be *executable*, and git calling a script under
        # a noexec mount fails with "Permission denied" on the helper itself —
        # a failure that looks identical to a credential problem, and is not
        # one. /tmp is exec-capable here; 0700 + chown to the odoo user is
        # what actually keeps the token private, not the mount's exec bit.
        SECRET_DIR="$(mktemp -d /tmp/pull-project-XXXXXX)"
        chmod 0700 "$SECRET_DIR"
        chown "$ODOO_USER" "$SECRET_DIR"

        # git calls the askpass helper once per prompt; the helper answers both
        # "Username" and "Password" from the same file, which is what GitHub
        # wants for a token (the username is ignored for a PAT).
        TOKEN_FILE="${SECRET_DIR}/token"
        printf '%s' "$CREDENTIAL" > "$TOKEN_FILE"
        chmod 0600 "$TOKEN_FILE"
        chown "$ODOO_USER" "$TOKEN_FILE"

        ASKPASS_FILE="${SECRET_DIR}/askpass"
        cat > "$ASKPASS_FILE" <<'ASKPASS'
#!/usr/bin/env bash
cat "$GIT_CREDENTIAL_FILE"
ASKPASS
        chmod 0700 "$ASKPASS_FILE"
        chown "$ODOO_USER" "$ASKPASS_FILE"

        GIT_ENV+=(
            -u GIT_TERMINAL_PROMPT
            GIT_TERMINAL_PROMPT=0
            GIT_ASKPASS="$ASKPASS_FILE"
            GIT_CREDENTIAL_FILE="$TOKEN_FILE"
        )
    else
        GIT_ENV+=(GIT_TERMINAL_PROMPT=0)
    fi
else
    # scp-style: the credential is the path to a private key.
    GIT_ENV+=(GIT_TERMINAL_PROMPT=0)
    if [[ -n "$CREDENTIAL" ]]; then
        if [[ ! -f "$CREDENTIAL" ]]; then
            echo "ERROR: SSH key not found: ${CREDENTIAL}" >&2
            exit 1
        fi
        GIT_ENV+=(
            GIT_SSH_COMMAND="ssh -i ${CREDENTIAL} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
        )
    else
        GIT_ENV+=(GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new")
    fi
fi

# --- The pull itself ---------------------------------------------------------
#
# Run as the odoo user, not as root. addons/ is odoo:odoo because Odoo reads it,
# and a root-run git would leave root-owned .git objects that break both the
# running service and the platform's own commits into the same directory
# (ADR-032). --no-verify is not used: core.hooksPath is forced to /dev/null by
# the platform's own git wrapper for the same class of reason, but here the
# repository is the deliverable and its hooks are not trusted either.
#
# reset --hard, deliberately. This directory is a deployment target, not a
# working copy: task workspaces live in /tmp and push from there. A local edit
# here is either a leftover or an accident, and the branch is the truth.

run_git() {
    sudo -u "$ODOO_USER" -H env "${GIT_ENV[@]}" \
        git -C "$ADDONS_DIR" \
        -c core.hooksPath=/dev/null \
        -c safe.directory="$ADDONS_DIR" \
        "$@"
}

# --- The checkout has to be writable by the user about to run git ------------
#
# Before the first git call, not after the last one. The fix-up at the end of
# this script re-establishes odoo:cartenz ownership over addons/ *after* a
# successful pull — which is correct for the files a pull writes, and useless
# for the first pull that needs to write them. .git/ is created by whoever
# initialises the repository, and on this host that can be a user other than
# odoo: the platform's own agent commits as "cartenz" (ADR-032), and an operator
# working as root leaves root-owned HEAD/index behind. `git fetch` writes
# FETCH_HEAD inside .git/, so a checkout whose .git/ is owned by either of those
# fails at the very first network-free step with
#
#     cannot open .git/FETCH_HEAD: Permission denied
#
# which reads like a remote or credential problem and is neither: the remote is
# never contacted. Worse, the ownership fix-up that would have allowed it only
# runs once the pull it is blocking has already succeeded. Normalising here
# makes the script self-healing for a checkout handed to it in any state, which
# matters because the operator cannot be expected to know that a manual `git
# checkout` as root renders a project un-restartable.
#
# Deliberately the same mode grant-addons-write.sh applies, so a repository
# this script repairs and one that script prepared are indistinguishable: group
# ownership cartenz (the platform user, so the agent can still commit into
# addons/), group rwx, nothing for other, setgid on directories so files written
# from here on inherit the group rather than re-introducing this bug on every
# pull.
normalise_git_ownership() {
    if [[ ! -d "${ADDONS_DIR}/.git" ]]; then
        return 0
    fi

    chown -R "${ODOO_USER}:${PLATFORM_GROUP}" "${ADDONS_DIR}/.git"
    chmod -R u+rwX,g+rwX,o-rwx "${ADDONS_DIR}/.git"
    find "${ADDONS_DIR}/.git" -type d -exec chmod g+s {} +
}

normalise_git_ownership

if [[ -d "${ADDONS_DIR}/.git" ]]; then
    EXISTING_REMOTE="$(run_git remote get-url origin 2>/dev/null || true)"

    if [[ -z "$EXISTING_REMOTE" ]]; then
        run_git remote add origin "$REPOSITORY_URL"
    elif [[ "$EXISTING_REMOTE" != "$REPOSITORY_URL" ]]; then
        echo "ERROR: addons/ already has a different origin." >&2
        echo "       present: ${EXISTING_REMOTE}" >&2
        echo "       asked:   ${REPOSITORY_URL}" >&2
        echo "       Refusing to repoint an existing checkout; fix the project's repository first." >&2
        exit 1
    fi
else
    # No repository yet (a scaffold, or a project created before ADR-041).
    run_git init --quiet
    run_git remote add origin "$REPOSITORY_URL"
fi

run_git fetch --prune --quiet origin "$BRANCH"

if ! run_git rev-parse --verify --quiet "FETCH_HEAD" >/dev/null; then
    echo "ERROR: '${BRANCH}' was not found on ${REPOSITORY_URL}." >&2
    exit 1
fi

run_git checkout --quiet -B "$BRANCH" FETCH_HEAD
run_git reset --hard --quiet FETCH_HEAD
run_git clean -fdq -e '*.pyc' -e '__pycache__'

# Ownership matters twice over: Odoo must be able to read what it serves, and
# the cartenz user must be able to commit into addons/ afterwards (the setgid
# bit grant-addons-write.sh sets is not re-established by a plain chown -R).
chown -R "${ODOO_USER}:${PLATFORM_GROUP}" "$ADDONS_DIR"
chmod -R u+rwX,g+rwX,o-rwx "$ADDONS_DIR"
find "$ADDONS_DIR" -type d -exec chmod g+s {} +
chmod o+x "$PROJECT_DIR"

COMMIT="$(run_git rev-parse HEAD)"
SUBJECT="$(run_git log -1 --pretty=%s)"

echo "OK: ${PROJECT_NAME} addons/ is now at ${BRANCH} @ ${COMMIT}"
echo "    ${SUBJECT}"
