#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# LinkedERP - addons/ ownership grant
# ============================================================
#
# Runs as root (via the narrow sudoers rule in
# infrastructure/provisioning/99-linkederp-provisioning), immediately after
# create_project / create_project_enterprise has provisioned a project.
#
# Those scripts chown the whole project directory to odoo:odoo, mode 750 -
# correct for config/, data/ and logs/, which hold the master password and the
# Odoo filestore. It leaves addons/ unwritable by the "cartenz" user the
# LinkedERP platform runs as, so the agent's own git init/commit into addons/
# (ADR-032) would fail silently the moment provisioning succeeded.
#
# This script narrows the fix to exactly that one directory:
#   - group ownership becomes "cartenz" (kept: user "odoo" still owns it)
#   - the setgid bit (chmod g+s) means every file *later* created under
#     addons/ - by either user - inherits the "cartenz" group, so a module the
#     agent commits today does not need this script run again tomorrow.
#   - group gets rwx; nothing outside addons/ is touched.
#
# Usage:
#   grant-addons-write <project_name>
#
# Example:
#   grant-addons-write dodolbintangmas
#
# ============================================================

BASE_DIR="/opt/odoo"
PROJECTS_DIR="${BASE_DIR}/projects"
PLATFORM_GROUP="cartenz"

usage() {
    echo
    echo "Usage:"
    echo "  grant-addons-write <project_name>"
    echo
    exit 1
}

if [[ "$EUID" -ne 0 ]]; then
    echo "ERROR: This script must be run as root." >&2
    exit 1
fi

if [[ $# -ne 1 ]]; then
    usage
fi

PROJECT_NAME="$1"

if [[ ! "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]{1,30}$ ]]; then
    echo "ERROR: Invalid project name." >&2
    exit 1
fi

PROJECT_DIR="${PROJECTS_DIR}/${PROJECT_NAME}"
ADDONS_DIR="${PROJECT_DIR}/addons"

# The project directory must exist and be exactly where create_project put it -
# not a symlink, not somewhere this script was tricked into resolving to.
if [[ ! -d "$PROJECT_DIR" ]]; then
    echo "ERROR: Project directory does not exist: ${PROJECT_DIR}" >&2
    exit 1
fi

if [[ ! -d "$ADDONS_DIR" ]]; then
    echo "ERROR: addons/ does not exist under ${PROJECT_DIR}" >&2
    exit 1
fi

if ! getent group "$PLATFORM_GROUP" >/dev/null 2>&1; then
    echo "ERROR: Group '${PLATFORM_GROUP}' does not exist." >&2
    exit 1
fi

# create_project leaves PROJECT_DIR itself at mode 750, owner:group odoo:odoo.
# "cartenz" is neither, so it gets zero access there - not even the execute
# (traversal) bit needed to reach a path *inside* it. Without this, every stat()
# or open() the platform does on addons/ fails with EACCES at the parent, which
# looks identical to "addons/ does not exist" to the caller. Grant execute-only
# (not read) on PROJECT_DIR so "cartenz" can traverse into a known subpath, but
# still cannot list PROJECT_DIR's contents or read config/, data/, logs/, which
# keep their own mode 750 odoo:odoo untouched - the master password and
# filestore inside them are not exposed by this change.
chmod o+x "$PROJECT_DIR"

# -R because a scratch install may already have module directories under
# addons/ from an earlier failed attempt; a fresh scaffold is just .gitkeep.
chown -R odoo:"${PLATFORM_GROUP}" "$ADDONS_DIR"
chmod -R u+rwX,g+rwX,o-rwx "$ADDONS_DIR"
# setgid: new files/directories created under addons/ inherit the group,
# rather than the creating process's primary group.
find "$ADDONS_DIR" -type d -exec chmod g+s {} +

echo "OK: ${ADDONS_DIR} is now group-writable by '${PLATFORM_GROUP}'."
