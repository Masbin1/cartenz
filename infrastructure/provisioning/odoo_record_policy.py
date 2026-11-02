"""LinkedERP - shared record policy for on-premise database access (ADR-075).

Mirrors the model prefixes `backend/src/agent/odoo-online/odoo-record-surface.ts`
refuses for Odoo Online, so the same "any business model except the instance's
own machinery" rule holds on both doors. A unit test
(`odoo-record-policy.spec.ts`) parses this file and asserts the tuple below is
identical to the TypeScript array, so the two cannot drift silently - the same
defence-in-depth posture ADR-064 already applies to `recordCall`.

Imported by project-records-driver.py from this script's own directory (passed
through PROJECT_RECORDS_POLICY_DIR in the environment, since a driver fed to
`odoo-bin shell` on stdin has no `__file__` of its own to resolve a sibling
import against).
"""

# Keep in sync with PROTECTED_PREFIXES in
# backend/src/agent/odoo-online/odoo-record-surface.ts. Order does not matter;
# the set of strings must match exactly.
PROTECTED_PREFIXES = (
    'ir.',
    'base.',
    'base_import.',
    'bus.',
    'auth_',
    'auth.',
    'iap.',
    'res.users',
    'res.groups',
    'res.config',
    'res.device',
    'fetchmail.',
    'mail.alias',
    'payment.provider',
    'account.online',
)

# Keep in sync with MAX_RECORDS_PER_WRITE / MAX_RECORDS_PER_READ in
# odoo-record-surface.ts.
MAX_RECORDS_PER_WRITE = 50
MAX_RECORDS_PER_READ = 2000
MAX_GROUPS_PER_AGGREGATE = 1000


def protected_model_reason(model_name):
    """Returns a refusal reason, or None when the model is a legal record target."""
    if not isinstance(model_name, str) or not model_name:
        return 'model name must be a non-empty string'
    for prefix in PROTECTED_PREFIXES:
        bare = prefix.rstrip('.')
        if model_name == bare or model_name.startswith(prefix):
            return (
                'records of "%s" are part of the instance\'s configuration, access or '
                'infrastructure and are never written or read as data' % model_name
            )
    return None
