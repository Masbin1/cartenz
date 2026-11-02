# LinkedERP - fixed on-premise record driver (ADR-075)
#
# Fed to `odoo-bin shell` on stdin by project-records.sh, running as the
# "odoo" user against exactly one project database. `odoo-bin shell` executes
# this file with `env` (an api.Environment as SUPERUSER) already in scope and
# rolls back on exit unless this file commits explicitly (odoo/cli/shell.py).
#
# This file is reviewed once, like apply-db-setup-driver.py. It is never
# generated per project and never model-authored. A request is data - a
# model name, a method name from a fixed set, field names re-checked against
# the live registry's own `_fields`, and plain values - never exec/eval'd and
# never used as an attribute name on anything other than a validated model.
#
# Input: the JSON request at the path in PROJECT_RECORDS_REQUEST_FILE:
#   {"operation": "search"|"count"|"aggregate"|"create"|"write",
#    "model": "...", "domain": [...], "fields": [...], "groupBy": [...],
#    "limit": N, "offset": N, "ids": [...], "values": {...}, "records": [...]}
# Output: one line on stdout, prefixed "RECORDS_REPORT: ", JSON:
#   {"status": "ok"|"failed", "result": ..., "detail": "..."}

import json
import os
import re
import sys

ENV = env  # noqa: F821 - provided by odoo-bin shell

# odoo-record-policy.py sits beside this driver on disk, but the driver's
# source arrives through odoo-bin shell's stdin, so it has no __file__ to
# resolve a sibling import against - the policy directory is passed through
# the environment instead, exactly as apply-db-setup.sh passes the plan path.
sys.path.insert(0, os.environ['PROJECT_RECORDS_POLICY_DIR'])
from odoo_record_policy import (  # noqa: E402
    MAX_GROUPS_PER_AGGREGATE,
    MAX_RECORDS_PER_READ,
    MAX_RECORDS_PER_WRITE,
    protected_model_reason,
)

MODEL_NAME = re.compile(r'^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$')
FIELD_NAME = re.compile(r'^[a-z][a-z0-9_]*$')
AGGREGATE_FIELD = re.compile(
    r'^[a-z][a-z0-9_]*(:(sum|avg|count|count_distinct|min|max|array_agg|bool_and|bool_or))?$'
)
AGGREGATE_GROUP_BY = re.compile(
    r'^[a-z][a-z0-9_]*(:(year|quarter|month|week|day|hour|minute|second))?$'
)

# No unlink, no execute, no dynamic method name - the same four-plus-one
# methods ADR-064 permits for Odoo Online, read_group added by ADR-086.
OPERATIONS = ('search', 'count', 'aggregate', 'create', 'write')


class Refused(Exception):
    """A request this driver will not run. Reported, never raised to odoo-bin."""


def require_model(model_name):
    if not isinstance(model_name, str) or not MODEL_NAME.match(model_name):
        raise Refused('"%s" is not a valid Odoo model name' % (model_name,))
    reason = protected_model_reason(model_name)
    if reason:
        raise Refused(reason)
    if model_name not in ENV:
        raise Refused('model %s is not installed in this database' % model_name)
    return ENV[model_name].with_context(active_test=False)


def require_fields(model_name, names):
    Model = ENV[model_name]
    for field in names:
        if not isinstance(field, str) or not FIELD_NAME.match(field):
            raise Refused('invalid field name %r' % (field,))
        if field not in Model._fields:
            raise Refused('field %s does not exist on %s in this version' % (field, model_name))


def op_search(request):
    model_name = request.get('model')
    Model = require_model(model_name)
    domain = request.get('domain') or []
    if not isinstance(domain, list):
        raise Refused('domain must be a list')
    fields = request.get('fields') or ['id', 'display_name']
    if not isinstance(fields, list) or not all(isinstance(f, str) for f in fields):
        raise Refused('fields must be a list of field names')
    require_fields(model_name, [f for f in fields if f not in ('id', 'display_name')])
    limit = request.get('limit') or 20
    if not isinstance(limit, int) or limit < 1:
        raise Refused('limit must be a positive integer')
    limit = min(limit, MAX_RECORDS_PER_READ)
    offset = request.get('offset') or 0
    if not isinstance(offset, int) or offset < 0:
        raise Refused('offset must be a non-negative integer')
    total = Model.search_count(domain)
    records = Model.search_read(domain, fields, limit=limit, offset=offset)
    return {
        'total': total,
        'offset': offset,
        'returned': len(records),
        'hasMore': offset + len(records) < total,
        'records': records,
    }


def op_count(request):
    model_name = request.get('model')
    Model = require_model(model_name)
    domain = request.get('domain') or []
    if not isinstance(domain, list):
        raise Refused('domain must be a list')
    return {'total': Model.search_count(domain)}


def op_aggregate(request):
    model_name = request.get('model')
    Model = require_model(model_name)
    domain = request.get('domain') or []
    if not isinstance(domain, list):
        raise Refused('domain must be a list')

    fields = request.get('fields')
    if not isinstance(fields, list) or not fields:
        raise Refused('fields is required: a non-empty list naming what to aggregate')
    if len(fields) > 20:
        raise Refused('at most 20 fields may be aggregated in one call')
    for field in fields:
        if not isinstance(field, str) or not AGGREGATE_FIELD.match(field):
            raise Refused('"%s" is not a valid aggregated field' % (field,))
    require_fields(model_name, [f.split(':', 1)[0] for f in fields])

    group_by = request.get('groupBy')
    if not isinstance(group_by, list) or not group_by:
        raise Refused('groupBy is required: a non-empty list of fields to group by')
    if len(group_by) > 5:
        raise Refused('at most 5 fields may be grouped by in one call')
    for field in group_by:
        if not isinstance(field, str) or not AGGREGATE_GROUP_BY.match(field):
            raise Refused('"%s" is not a valid groupBy field' % (field,))
    require_fields(model_name, [f.split(':', 1)[0] for f in group_by])

    limit = request.get('limit') or MAX_GROUPS_PER_AGGREGATE
    if not isinstance(limit, int) or limit < 1:
        raise Refused('limit must be a positive integer')
    limit = min(limit, MAX_GROUPS_PER_AGGREGATE)

    groups = Model.read_group(domain, fields, group_by, limit=limit)
    return {'groupCount': len(groups), 'groups': groups}


# Values a plan may set directly, by field type. A many2one is refused unless
# it is a bare positive integer id the caller already resolved elsewhere (no
# $ref/natural-key resolution here - ADR-075 keeps that in the brief path's
# applier, not in the chat-facing driver, so this stays the narrowest shape).
def coerce_values(model_name, values):
    Model = ENV[model_name]
    out = {}
    for field, value in values.items():
        if not isinstance(field, str) or not FIELD_NAME.match(field):
            raise Refused('invalid field name %r' % (field,))
        if field not in Model._fields:
            raise Refused('field %s does not exist on %s in this version' % (field, model_name))
        definition = Model._fields[field]
        if definition.type == 'binary':
            raise Refused('field %s is binary; attachment/binary writes are not supported' % field)
        if definition.type == 'many2one':
            if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                raise Refused(
                    'field %s is a relation: give the target record\'s existing id as a '
                    'positive integer' % field
                )
            out[field] = value
        elif definition.type in ('one2many', 'many2many'):
            raise Refused('field %s is a relation list; not supported by this operation' % field)
        elif definition.type == 'selection':
            legal = definition.get_values(ENV)
            if value not in legal:
                raise Refused('%s must be one of %s, got %r' % (field, ', '.join(legal), value))
            out[field] = value
        elif definition.type in ('float', 'monetary'):
            out[field] = float(value)
        elif definition.type == 'integer':
            out[field] = int(value)
        elif definition.type == 'boolean':
            out[field] = bool(value)
        else:
            out[field] = value
    return out


def op_create(request):
    model_name = request.get('model')
    Model = require_model(model_name)
    records = request.get('records')
    if not isinstance(records, list) or not records:
        raise Refused('records must be a non-empty list of field/value objects')
    if len(records) > MAX_RECORDS_PER_WRITE:
        raise Refused('at most %d records may be created in one call' % MAX_RECORDS_PER_WRITE)
    values_list = []
    for entry in records:
        if not isinstance(entry, dict) or not entry:
            raise Refused('every record must be a non-empty object of field values')
        values_list.append(coerce_values(model_name, entry))
    created = Model.create(values_list)
    return {'created': len(created), 'ids': created.ids}


def op_write(request):
    model_name = request.get('model')
    Model = require_model(model_name)
    ids = request.get('ids')
    if not isinstance(ids, list) or not ids:
        raise Refused('ids must be a non-empty list')
    if len(ids) > MAX_RECORDS_PER_WRITE:
        raise Refused('at most %d records may be updated in one call' % MAX_RECORDS_PER_WRITE)
    if not all(isinstance(i, int) and not isinstance(i, bool) and i > 0 for i in ids):
        raise Refused('ids must be positive integers')
    values = request.get('values')
    if not isinstance(values, dict) or not values:
        raise Refused('values must be a non-empty object of field values')
    values = coerce_values(model_name, values)
    records = Model.browse(ids)
    missing = [i for i in ids if i not in records.exists().ids]
    if missing:
        raise Refused('record id(s) %s do not exist on %s' % (missing, model_name))
    records.write(values)
    return {'updated': len(ids), 'ids': ids}


HANDLERS = {
    'search': op_search,
    'count': op_count,
    'aggregate': op_aggregate,
    'create': op_create,
    'write': op_write,
}


def report(status, result=None, detail=''):
    print('RECORDS_REPORT: ' + json.dumps({
        'status': status,
        'result': result,
        'detail': str(detail)[:1000],
    }))


def main():
    path = os.environ.get('PROJECT_RECORDS_REQUEST_FILE')
    if not path:
        raise SystemExit('PROJECT_RECORDS_REQUEST_FILE is not set')
    with open(path, encoding='utf-8') as handle:
        request = json.load(handle)

    if not isinstance(request, dict):
        report('failed', None, 'the request must be a JSON object')
        return

    operation = request.get('operation')
    handler = HANDLERS.get(operation)
    if handler is None:
        report('failed', None, 'operation must be one of %s, got %r' % (OPERATIONS, operation))
        return

    try:
        with ENV.cr.savepoint():
            result = handler(request)
            ENV.flush_all()
            if operation in ('create', 'write'):
                ENV.cr.commit()
    except Refused as refusal:
        ENV.invalidate_all()
        report('failed', None, str(refusal))
        return
    except Exception as error:  # noqa: BLE001 - every failure is reported, none is fatal
        ENV.invalidate_all()
        report('failed', None, '%s: %s' % (type(error).__name__, error))
        return

    report('ok', result)


main()
