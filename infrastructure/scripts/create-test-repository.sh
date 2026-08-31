#!/usr/bin/env bash
# Creates a small Odoo-shaped git repository for local verification.
#
# Cloning from it requires GIT_ALLOW_LOCAL_REMOTES=true, which is refused in
# production (ADR-019). It exists so the agent can be verified without depending on
# network access or on a real customer repository.
#
# Two variants, because they verify different things and one repository cannot be
# both:
#
#   (default)     Clean. Used by the API and repository-agent smoke tests, which
#                 need every planned file to be writable.
#   --with-secret Plants a credential and a personal email address in the model
#                 file. Used by the AI-agent smoke test to verify that the AI data
#                 boundary engages, and that a redacted value is never written back
#                 into the repository (ADR-020).
set -euo pipefail

WITH_SECRET=false
if [ "${1:-}" = "--with-secret" ]; then
  WITH_SECRET=true
  shift
fi

DEFAULT_NAME="omnisurge-odoo"
[ "$WITH_SECRET" = true ] && DEFAULT_NAME="omnisurge-odoo-secrets"

TARGET="${1:-$HOME/.cache/linkederp-fixtures/$DEFAULT_NAME.git}"
WORK="$(mktemp -d)"

if [ -d "$TARGET" ]; then
  echo "Fixture already exists at $TARGET"
  echo "file://$TARGET"
  exit 0
fi

mkdir -p "$(dirname "$TARGET")"
cd "$WORK"

git init -q -b main
git config user.name "Fixture Author"
git config user.email "fixture@linkederp.test"
git config commit.gpgsign false

mkdir -p omnisurge_sale/models omnisurge_sale/views omnisurge_sale/security
mkdir -p omnisurge_base/models omnisurge_base/views

cat > omnisurge_sale/__manifest__.py <<'PY'
{
    'name': 'Omnisurge Sales',
    'summary': 'Sales extensions for Omnisurge',
    'version': '18.0.1.2.0',
    'category': 'Sales/Sales',
    'license': 'LGPL-3',
    'author': 'LinkedERP',
    'depends': ['base', 'sale', 'account'],
    'data': [
        'security/ir.model.access.csv',
        'views/sale_order_views.xml',
    ],
    'installable': True,
    'application': False,
}
PY

cat > omnisurge_sale/__init__.py <<'PY'
from . import models
PY

cat > omnisurge_sale/models/__init__.py <<'PY'
from . import sale_order
PY

cat > omnisurge_sale/models/sale_order.py <<'PY'
from odoo import api, fields, models


class SaleOrder(models.Model):
    _inherit = 'sale.order'

    delivery_window = fields.Selection(
        selection=[('morning', 'Morning'), ('afternoon', 'Afternoon')],
        string='Delivery Window',
        help='Preferred delivery window agreed with the customer.',
    )

    @api.depends('order_line.price_subtotal')
    def _compute_margin_estimate(self):
        for order in self:
            order.margin_estimate = sum(order.order_line.mapped('price_subtotal'))
PY

cat > omnisurge_sale/views/sale_order_views.xml <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<odoo>
    <record id="view_order_form_omnisurge" model="ir.ui.view">
        <field name="name">sale.order.form.omnisurge</field>
        <field name="model">sale.order</field>
        <field name="inherit_id" ref="sale.view_order_form"/>
        <field name="arch" type="xml">
            <field name="commitment_date" position="after">
                <field name="delivery_window"/>
            </field>
        </field>
    </record>
</odoo>
XML

cat > omnisurge_sale/security/ir.model.access.csv <<'CSV'
id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink
access_sale_order_omnisurge,sale.order.omnisurge,sale.model_sale_order,base.group_user,1,1,0,0
CSV

cat > omnisurge_base/__manifest__.py <<'PY'
{
    'name': 'Omnisurge Base',
    'version': '18.0.1.0.1',
    'license': 'LGPL-3',
    'depends': ['base'],
    'installable': True,
    'application': True,
}
PY

cat > omnisurge_base/__init__.py <<'PY'
from . import models
PY

cat > omnisurge_base/models/__init__.py <<'PY'
PY

cat > .python-version <<'TXT'
3.11
TXT

cat > README.md <<'MD'
# Omnisurge Odoo

Test fixture used to verify the LinkedERP repository agent. Two Odoo 18 addons.
MD

if [ "$WITH_SECRET" = true ]; then
  # Planted deliberately. The AI data boundary must remove both before this file
  # reaches a model provider, and the write guard must then refuse to write the
  # redacted version back into the repository (ADR-020).
  cat > omnisurge_sale/models/sale_order.py <<'PY'
from odoo import api, fields, models

# Planted by the fixture. The AI data boundary must remove both of these before
# this file reaches a model provider.
COURIER_API_KEY = "ghp_fixtureplantedtokenabcdefghijklmnop"
SUPPORT_CONTACT = "operations.manager@omnisurge-customer.co.za"


class SaleOrder(models.Model):
    _inherit = 'sale.order'

    delivery_window = fields.Selection(
        selection=[('morning', 'Morning'), ('afternoon', 'Afternoon')],
        string='Delivery Window',
        help='Preferred delivery window agreed with the customer.',
    )

    @api.depends('order_line.price_subtotal')
    def _compute_margin_estimate(self):
        for order in self:
            order.margin_estimate = sum(order.order_line.mapped('price_subtotal'))
PY
fi

# A module large enough to catch a truncated read (ADR-022).
#
# The defect that produced this file: the audit redaction filter truncates strings
# to 2 KB, that filter was applied to the value returned to the agent, and so
# read_file silently returned the first ~55 lines of any larger file. A write-back
# then destroyed the rest. Every fixture file was under 2 KB, so nothing failed.
#
# The last line carries OMNISURGE_TAIL_MARKER. Any round trip that drops it has
# lost the end of the file.
mkdir -p omnisurge_large/models

cat > omnisurge_large/__manifest__.py <<'PY'
{
    'name': 'Omnisurge Large',
    'version': '18.0.1.0.0',
    'depends': ['base', 'sale'],
    'data': [],
    'license': 'LGPL-3',
}
PY

printf 'from . import models
' > omnisurge_large/__init__.py
printf 'from . import big_model
' > omnisurge_large/models/__init__.py

{
  printf 'from odoo import api, fields, models


'
  printf 'class OmnisurgeBigModel(models.Model):
'
  printf "    _name = 'omnisurge.big'
"
  printf "    _description = 'Deliberately long model, to catch a truncated read'

"
  for i in $(seq 1 200); do
    printf "    field_%03d = fields.Char(string='Field %03d', help='Generated field %03d.')
" "$i" "$i" "$i"
  done
  printf '
    @api.depends()
'
  printf '    def _compute_nothing(self):
'
  printf '        for record in self:
'
  printf '            record.field_001 = record.field_001

'
  printf '# OMNISURGE_TAIL_MARKER: if this line is missing, a read-write round trip lost the tail.
'
} > omnisurge_large/models/big_model.py

git add -A
git commit -q -m "Initial Omnisurge Odoo addons"

# The branches an Odoo.sh project has (ADR-021): production is main, and there is
# a staging branch and a development branch. The fixture carries all three so that
# targeting an environment can be tested against a branch that exists - a task
# pointed at a branch the remote does not have is a separate case.
git branch -q staging
git branch -q dev-1

git clone -q --bare "$WORK" "$TARGET"
rm -rf "$WORK"

echo "Created fixture at $TARGET"
echo "file://$TARGET"
