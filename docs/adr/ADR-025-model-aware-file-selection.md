# ADR-025 — Model-aware file selection

**Status:** Accepted
**Date:** 2026-08-29

## Context

The first run against `github.com/LinkedERP/Odoo` planned a change to `sale.order` in
`linkederp_dashboard_studio/models/dashboard.py`. That file does not extend `sale.order`. It
mentions it, in a comment and in a domain string. Meanwhile
`linkederp_sales_modifier/models/sale_order.py` — which begins `_inherit = 'sale.order'` — went
unread.

The cause was not the scripted provider. Candidate files came from `search_code`, a text search,
and were passed on in the order the repository walker happened to return them. A text search cannot
tell a file that extends a model from one that names it in a comment, so the ordering was
arbitrary and the first `.py` won.

This was written down as "a real model would choose better". That is probably true and it is not
the point: a model given the wrong three files reads the wrong three files. The excerpts sent to the
provider are chosen by this same ordering, so the ranking decides what any model — scripted or
frontier — gets to reason about.

## Decision

### 1. Rank candidates by what they declare, not by what they contain

In Odoo the relationship is declared, so it can be read:

| Signal | Meaning | Rank |
| --- | --- | --- |
| `_inherit = 'sale.order'` | this file extends the model | 1 |
| `_name = 'sale.order'` | this file defines it | 2 |
| the string appears anywhere | it mentions it | 3 |
| neither | unrelated | 4 |

Extending outranks defining deliberately: a change to `sale.order` in a customer's repository
belongs in the module that already extends it. Odoo's own definition is not in the repository at all.

Parsed as text, never executed, and deliberately shallow — assignments to `_name` and `_inherit`
and nothing else. A Python parser would be a large dependency for a question this narrow, and a
shallow read that is wrong about an unusual file only costs a worse ranking.

### 2. XML view files declare their model too, and are read the same way

`<field name="model">sale.order</field>` is the XML equivalent of `_inherit`, and a view file is
where the other half of an Odoo change goes. Without reading it, a view could only ever rank as
"mentions" — and on this repository three view files mention `sale.order` while two declare it.

`ir.ui.view` and `ir.actions.act_window` are excluded: that is the record's own type, not the
business model it concerns.

### 3. The filename convention breaks a tie, and never more than that

`sale.order` conventionally lives in `sale_order.py`, and its views in `sale_order_views.xml`. On
this repository two files extend `sale.order`: `sale_order_sla.py`, which adds service-level fields,
and `sale_order.py`, which is where a general field belongs. Nothing in the code says which; the
filename is the only signal there is.

It ranks strictly below the declaration. A file called `sale_order.py` that does not extend
`sale.order` must not outrank one that does — the convention is a tiebreak, not evidence.

### 4. The reasoning is passed to the model, not just the order

The planner's facts now carry `candidateFiles` as `{path, relation}` rather than a bare list. A
model can see *why* the order is what it is and disagree with it after reading the code, which is
the whole point of giving it the files.

### 5. More files are read than are sent

Ranking requires reading — a file cannot be judged on its name. Twelve matched files are read, three
are sent. Bounded so a broad search cannot become a read of the whole repository.

## Consequences

The result on the repository this was written against, for
"Add a delivery reference field to the Sales Order model and show it on the order form view":

| | Before | After |
| --- | --- | --- |
| Model file | `linkederp_dashboard_studio/models/dashboard.py` — does not extend `sale.order` | `linkederp_sales_modifier/models/sale_order.py` — `_inherit = 'sale.order'` |
| View file | `linkederp_dashboard_studio/views/sale_order_sla_views.xml` — another module | `linkederp_sales_modifier/views/sale_order_views.xml` — same module |

Both halves in the module that owns the customisation, which is what a consultant would have done.

This does not make the plan *good*. The scripted provider still writes a comment block, and whether
the change is the right change is a question only a configured model can answer. What it removes is
the failure below that: reasoning about the wrong files.

The costs: twelve file reads per planning step, and a shallow parser that will be wrong about an
unconventional file. Both bounded, and the failure mode of being wrong is a worse ranking rather
than a wrong answer.

## Verification

16 unit tests over the index, and a live run against `LinkedERP/Odoo` on `StagingDM`.

| What | Result |
| --- | --- |
| Reads `_name`, `_inherit`, and a multi-line `_inherit` list | PASS |
| Ignores the model named in a comment or a domain string | PASS |
| Reads `<field name="model">` and ignores the record's own type | PASS |
| Ranks extending above defining above mentioning | PASS |
| Filename convention breaks a tie between two extending files | PASS |
| Filename convention never beats a declaration | PASS |
| **Live: the plan targets the module that extends the model, both halves** | PASS |
| **Live: the diff is `+8/−0` and `+3/−0`** | PASS |
| No regressions | 324 unit tests; smoke 54 / 43 / 31 / 27 / 50 | PASS |

**Not verified:** whether a configured model, given these files, produces a change worth approving.
That remains the open question, and it needs an API key.
