# LinkedERP - fixed database-setup driver (ADR-073)
#
# Fed to `odoo-bin shell` on stdin by apply-db-setup.sh, running as the
# "odoo" user against exactly one project database. `odoo-bin shell` executes
# this file with `env` (an api.Environment as SUPERUSER) already in scope,
# and rolls back on exit unless this file commits explicitly
# (odoo/cli/shell.py), which it does once, at the end, only if at least one
# entry applied.
#
# This file is reviewed once, like every other provisioning script. It is
# never generated per project and never model-authored. Nothing in a plan is
# ever passed to exec/eval, used as an attribute name on anything other than
# a validated model, or used as a method name: a plan is data — a model name
# from a fixed whitelist, field names re-checked against the live registry's
# own `_fields`, and plain values.
#
# Input: the JSON plan at the path in DB_SETUP_PLAN_FILE.
# Output: one line per plan entry on stdout, prefixed "DB_SETUP_REPORT: ",
# whose payload is JSON:
#   {"item": N, "kind": "...", "label": "...",
#    "status": "applied"|"skipped"|"failed", "detail": "..."}
# apply-db-setup.sh greps these out of odoo-bin's own log noise.

import json
import os
import re

# `env` is provided by odoo-bin shell. Referenced through a local name so a
# reader can see exactly where it comes from.
ENV = env  # noqa: F821

IDENT = re.compile(r'^[a-z][a-z0-9_]*$')
LANG_CODE = re.compile(r'^[a-z]{2}_[A-Z]{2}$')

# The record models a plan may touch, and for each the natural key used to
# make "create" idempotent (search before create) and the fields a plan may
# set. Mirrors odoo-setup-catalog.ts's recordMenu(); a model here that the
# backend does not offer is unreachable, and a model the backend offers that
# is absent here is refused — the stricter of the two always wins.
RECORD_MODELS = {
    'product.attribute': {
        'key': 'name',
        'fields': {'name', 'create_variant'},
        'mode': 'create',
    },
    'uom.uom': {
        'key': 'name',
        'fields': {'name', 'relative_uom_id', 'relative_factor'},
        'mode': 'create',
    },
    'mrp.workcenter': {
        # code is optional in Odoo (fields.Char, not required): match on it
        # when the plan gives one, otherwise on name.
        'key': ('code', 'name'),
        'fields': {'name', 'code', 'costs_hour'},
        'mode': 'create',
    },
    'stock.warehouse': {
        # The main warehouse is updated in place, never a new one created:
        # the brief describes how goods flow, not a second site.
        'key': None,
        'fields': {'reception_steps', 'delivery_steps', 'manufacture_steps'},
        'mode': 'write_main',
    },
}

COMPANY_FIELDS = {'name', 'currency_id'}

# Values that refer to another record are resolved by a fixed rule per field,
# never by a plan-supplied model name: a plan names a currency by its ISO
# code and a reference unit by its name or XML id.
def resolve_currency(value):
    if not isinstance(value, str) or not re.match(r'^[A-Z]{3}$', value):
        raise ValueError('currency must be a three-letter ISO code, got %r' % (value,))
    currency = ENV['res.currency'].with_context(active_test=False).search(
        [('name', '=', value)], limit=1
    )
    if not currency:
        raise ValueError('no currency %s in this database' % value)
    if not currency.active:
        currency.active = True
    return currency.id


def resolve_uom(value):
    if not isinstance(value, str) or not value:
        raise ValueError('reference unit must be a name or an XML id')
    Uom = ENV['uom.uom'].with_context(active_test=False)
    if re.match(r'^[a-z_]+\.[a-z0-9_]+$', value):
        record = ENV.ref(value, raise_if_not_found=False)
        if record and record._name == 'uom.uom':
            return record.id
    record = Uom.search([('name', '=ilike', value)], limit=1)
    if not record:
        raise ValueError('no unit of measure named %r' % value)
    return record.id


RESOLVERS = {
    ('res.company', 'currency_id'): resolve_currency,
    ('uom.uom', 'relative_uom_id'): resolve_uom,
}


def report(item, kind, label, status, detail=''):
    print('DB_SETUP_REPORT: ' + json.dumps({
        'item': item,
        'kind': str(kind),
        'label': str(label),
        'status': status,
        'detail': str(detail)[:500],
    }))


def check_fields(model_name, values, allowed):
    """Refuse any field outside the whitelist or absent from the live model."""
    Model = ENV[model_name]
    for field in values:
        if not isinstance(field, str) or not IDENT.match(field):
            raise ValueError('invalid field name %r' % (field,))
        if field not in allowed:
            raise ValueError('field %s is not allowed on %s' % (field, model_name))
        if field not in Model._fields:
            raise ValueError('field %s does not exist on %s in this version' % (field, model_name))


def coerce(model_name, values):
    """Resolve references and validate selection values against the live field."""
    Model = ENV[model_name]
    out = {}
    for field, value in values.items():
        resolver = RESOLVERS.get((model_name, field))
        if resolver:
            out[field] = resolver(value)
            continue
        definition = Model._fields[field]
        if definition.type == 'selection':
            legal = definition.get_values(ENV)
            if value not in legal:
                raise ValueError('%s.%s must be one of %s, got %r' % (
                    model_name, field, ', '.join(legal), value))
        elif definition.type == 'many2one':
            # Only the resolvers above may set a relation; anything else is
            # refused rather than trusting a plan-supplied id.
            raise ValueError('%s.%s is a relation with no resolver' % (model_name, field))
        elif definition.type in ('float', 'monetary'):
            value = float(value)
        elif definition.type == 'integer':
            value = int(value)
        elif definition.type == 'boolean':
            value = bool(value)
        elif definition.type in ('char', 'text'):
            value = str(value)[:256]
        out[field] = value
    return out


def apply_setting(entry):
    field = entry.get('settingField')
    if not isinstance(field, str) or not re.match(r'^group_[a-z0-9_]+$', field):
        raise ValueError('a setting must name a group_* field')
    Settings = ENV['res.config.settings']
    if field not in Settings._fields:
        raise ValueError('setting %s does not exist in this version' % field)
    definition = Settings._fields[field]
    if definition.type != 'boolean':
        raise ValueError('setting %s is not a toggle' % field)
    # Built exactly as the Settings screen builds it: default_get reads every
    # current value through get_values(), so this record reflects the
    # database as it is now, and execute() re-applies the unchanged ones
    # unchanged — the same idempotence the UI's own Save button relies on.
    settings = Settings.create({})
    if settings[field]:
        return 'skipped', 'already enabled'
    settings[field] = True
    settings.execute()
    return 'applied', field


def apply_record(entry):
    model_name = entry.get('model')
    if model_name not in RECORD_MODELS:
        raise ValueError('model %r is not on the setup whitelist' % (model_name,))
    if model_name not in ENV:
        raise ValueError('model %s is not installed in this database' % model_name)
    spec = RECORD_MODELS[model_name]
    values = entry.get('values') or {}
    if not isinstance(values, dict):
        raise ValueError('values must be an object')
    check_fields(model_name, values, spec['fields'])
    values = coerce(model_name, values)
    Model = ENV[model_name].with_context(active_test=False)

    if spec['mode'] == 'write_main':
        warehouse = Model.search([('company_id', '=', ENV.company.id)], order='id', limit=1)
        if not warehouse:
            raise ValueError('no warehouse for the main company')
        changes = {f: v for f, v in values.items() if warehouse[f] != v}
        if not changes:
            return 'skipped', 'already set'
        warehouse.write(changes)
        return 'applied', ', '.join('%s=%s' % kv for kv in sorted(changes.items()))

    keys = spec['key'] if isinstance(spec['key'], tuple) else (spec['key'],)
    key = next((k for k in keys if values.get(k)), None)
    if key is None:
        raise ValueError('%s requires %s' % (model_name, ' or '.join(keys)))
    existing = Model.search([(key, '=', values[key])], limit=1)
    if existing:
        if 'active' in Model._fields and not existing.active:
            existing.active = True
            return 'applied', 'reactivated %s' % values[key]
        return 'skipped', '%s %r already exists' % (model_name, values[key])

    record = Model.create(values)

    # product.attribute: its values travel alongside the record, as a plain
    # list of names, created one by one under the attribute just made.
    if model_name == 'product.attribute':
        names = entry.get('attributeValues') or []
        if not isinstance(names, list):
            raise ValueError('attributeValues must be a list of names')
        for name in names[:100]:
            if isinstance(name, (str, int, float)) and str(name).strip():
                ENV['product.attribute.value'].create({
                    'attribute_id': record.id,
                    'name': str(name).strip()[:128],
                })
    return 'applied', 'created %s %r' % (model_name, values[key])


def apply_company(entry):
    values = entry.get('values') or {}
    if not isinstance(values, dict) or not values:
        raise ValueError('a company entry needs values')
    check_fields('res.company', values, COMPANY_FIELDS)
    values = coerce('res.company', values)
    company = ENV.company
    changes = {f: v for f, v in values.items()
               if (company[f].id if hasattr(company[f], 'id') else company[f]) != v}
    if not changes:
        return 'skipped', 'already set'
    if 'currency_id' in changes:
        # Changing the company currency once journal entries exist is refused
        # by Odoo itself; on a fresh database there are none, but the check
        # is Odoo's to make, not ours to bypass.
        pass
    company.write(changes)
    return 'applied', ', '.join(sorted(changes))


def apply_language(entry):
    code = entry.get('languageCode')
    if not isinstance(code, str) or not LANG_CODE.match(code):
        raise ValueError('a language code looks like id_ID')
    Lang = ENV['res.lang'].with_context(active_test=False)
    lang = Lang.search([('code', '=', code)], limit=1)
    if not lang:
        raise ValueError('language %s is not known to this Odoo' % code)
    if lang.active:
        return 'skipped', 'already active'
    wizard = ENV['base.language.install'].create({'lang_ids': [(6, 0, lang.ids)]})
    wizard.lang_install()
    return 'applied', code


HANDLERS = {
    'setting': apply_setting,
    'record': apply_record,
    'company': apply_company,
    'language': apply_language,
}


def label_of(entry):
    kind = entry.get('kind')
    if kind == 'setting':
        return str(entry.get('settingField'))
    if kind == 'language':
        return str(entry.get('languageCode'))
    values = entry.get('values') or {}
    name = values.get('name') or values.get('code') or ''
    return ('%s %s' % (entry.get('model') or 'res.company', name)).strip()


def main():
    path = os.environ.get('DB_SETUP_PLAN_FILE')
    if not path:
        raise SystemExit('DB_SETUP_PLAN_FILE is not set')
    with open(path, encoding='utf-8') as handle:
        plan = json.load(handle)

    entries = plan.get('configuration') if isinstance(plan, dict) else None
    if not isinstance(entries, list):
        raise SystemExit('the plan has no configuration list')
    if len(entries) > 200:
        raise SystemExit('the plan has more than 200 entries')

    applied = 0
    for index, entry in enumerate(entries, start=1):
        kind = entry.get('kind') if isinstance(entry, dict) else None
        handler = HANDLERS.get(kind)
        label = label_of(entry) if isinstance(entry, dict) else '?'
        if handler is None:
            report(index, str(kind), label, 'failed', 'unknown kind')
            continue
        try:
            with ENV.cr.savepoint():
                status, detail = handler(entry)
                ENV.flush_all()
        except Exception as error:  # noqa: BLE001 - every failure is reported, none is fatal
            ENV.invalidate_all()
            report(index, kind, label, 'failed', error)
            continue
        if status == 'applied':
            applied += 1
        report(index, kind, label, status, detail)

    if applied:
        ENV.cr.commit()

    # The running Odoo server keeps its own cache (user groups, menus, views).
    # A settings toggle changes group membership, but this shell process is
    # not the server: without signalling, the server keeps serving pre-setup
    # menus and hides every group-gated screen until it restarts.
    #
    # Odoo 19 exposes Registry.clear_all_caches() and signal_changes(); Odoo
    # 20 moved cache invalidation onto the transaction (Transaction signals
    # on commit) and kept only the private _signal_changes(cr, names), so the
    # two are handled apart rather than crashing on the version that lacks
    # the first. Signalling 'registry' makes the running server reload its
    # whole registry on the next request, which is what a settings toggle
    # needs and is safe for a shell that just committed.
    registry = ENV.registry
    clear_all_caches = getattr(registry, 'clear_all_caches', None)
    if callable(clear_all_caches):
        clear_all_caches()
        registry.signal_changes()
    else:
        registry._signal_changes(ENV.cr, {'registry'})
        ENV.cr.commit()


main()
