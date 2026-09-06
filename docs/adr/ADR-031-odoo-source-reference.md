# ADR-031: Odoo source as a read-only reference on every Odoo project

- Status: Accepted
- Date: 05 September 2026
- Milestone: Phase 5 (Odoo-aware development)

## Context

Every project this platform works on is an Odoo project, and almost every change
extends something Odoo already ships. Adding a field to a sales order means
knowing how `sale.order` is declared; adding a report means knowing what
`account.move` already exposes; deciding whether to build something at all means
knowing whether an enterprise module already does it.

The deployment already has that source on disk. `ODOO_RUNTIMES` names the Odoo
version and its path for validation (ADR-027), and `ON_PREMISE_READ_ONLY_PATHS`
names base and enterprise so an on-premise task can read them (ADR-028).

The reference was reaching one execution mode only. `WorkspaceManager` set
`readOnlyRoots` from configuration for on-premise and to `[]` for every other
mode — so a `repository` or `odoo_sh` project, which is how most Odoo work is
connected, planned against the customer's module alone. The agent could not read
`sale.py` to see that `client_order_ref` already exists, and the failure mode was
the one already observed in testing: a plan proposing a field Odoo ships as
standard.

The machinery for this already exists and is proven. `readOnlyRootsFromPaths`
derives a synthetic prefix from each directory's basename, `resolveReadPath`
resolves a read under that prefix against the shared directory, and the write
tools refuse any path that lands in a read-only root. Nothing about the boundary
needs inventing; it needs extending to the modes that were excluded.

## Decision

1. **The Odoo source is available to every Odoo project, not only on-premise.**
   `WorkspaceManager` derives `readOnlyRoots` from configuration for the
   `repository` and `odoo_sh` modes as well. `odoo_online` keeps `[]`: it has no
   filesystem, and its tools speak to the instance over XML-RPC.

2. **One configuration surface, two consumers.** The paths come from
   `ODOO_SOURCE_PATHS` when set, falling back to the union of
   `ON_PREMISE_READ_ONLY_PATHS` and `ODOO_SHARED_ADDON_PATHS` and the runtime
   paths in `ODOO_RUNTIMES`. A deployment that already configured validation
   gets the reference with no new setting; a deployment that wants the reference
   without validation sets the one variable.

3. **Read-only is enforced where it already was.** No write tool gains a path
   into these directories: `resolveWritePath` refuses a read-only root, and that
   refusal is what makes this safe rather than the prompt. The agent may read
   `odoo/addons/sale/models/sale_order.py`; it may not write to it, and a task
   that tries is denied and audited like any other refused write.

4. **The system prompt names the reference and the conventions.** The prompt
   states which prefixes exist and what they hold, and carries the Odoo
   conventions that were previously left implicit — extend with `_inherit`
   rather than redefining, put models under `models/` and views under `views/`,
   declare every new model in `ir.model.access.csv`, prefix custom fields with
   `x_` only when the customer's own convention does. A model that knows the
   reference exists will read it; one that does not, will not.

## Consequences

- A plan can cite the standard implementation it extends, and the "propose a
  field Odoo already ships" failure becomes checkable rather than likely.
- Reads are bounded by the same containment as the workspace: a path that
  escapes a read-only root is refused, so `odoo/../../etc/passwd` does not
  resolve.
- The reference is large (base 631 modules, enterprise 741 on the reference
  deployment). Model attention is the limit, not disk: the agent searches and
  reads specific files rather than being handed the tree, which is what
  `search_code` and `read_file` already do.
- A deployment with no Odoo source configured is unchanged: `readOnlyRoots` is
  empty, every read resolves inside the workspace, and nothing in the prompt
  claims a reference that is not there.
