# ADR-032: Scaffolding a custom addon when an Odoo project is created

- Status: Accepted
- Date: 06 September 2026
- Milestone: Phase 5 (Odoo-aware development)

## Context

Creating a project for new Odoo work is three manual steps that have nothing to
do with the work: make a directory under the on-premise root, `git init` it, and
write a module skeleton so the first task has something to extend. Every one of
them is the same every time, and getting one wrong produces a failure at task
time rather than at creation time — the workspace layer refuses a directory that
is not a Git repository, and the agent has nowhere to put a model if there is no
module.

The reference (ADR-031) gives the agent Odoo base and enterprise to read. What it
does not give is a place to *write*. For an existing project that place is the
customer's repository; for a new one it does not exist yet.

## Decision

An on-premise project may be created with a scaffolded custom addon.
`POST /projects` accepts `scaffold: true`, and the service creates, under the
configured on-premise root:

```
<ON_PREMISE_ROOT>/<technical_name>/          git repository, branch main
  <technical_name>/                          the addon
    __init__.py                              imports models
    __manifest__.py                          name, version, depends: ['base']
    models/__init__.py
    security/ir.model.access.csv             header row only
    README.md
  .gitignore                                 __pycache__, *.pyc
```

1. **The technical name is derived from the project name.** "Vania Sales" becomes
   `vania_sales`: lowercased, non-alphanumerics collapsed to `_`, leading digits
   prefixed, truncated to 63 characters. An Odoo module name is a Python package
   name, so the derivation is a constraint rather than a formatting preference. A
   caller may override it with `technicalName`.

2. **Refuse rather than overwrite.** If the directory already exists, creation
   fails with a message naming it. Silently reusing a directory would put a new
   project's work into another project's module; silently overwriting would
   destroy it.

3. **The scaffold is a git repository with one commit.** `git init` on branch
   `main`, then a commit of the skeleton. The workspace layer already requires a
   Git repository and a clean tree, so a scaffold that is not committed would be
   refused by the first task. The initial commit is authored by the platform
   identity, as every platform commit is.

4. **Containment is the on-premise root.** The target path is resolved and must
   be a direct child of `ON_PREMISE_ROOT`. A name that escapes it — `../`, an
   absolute path, a separator — is refused. This is the same boundary
   `assertWithinOnPremiseRoot` already enforces at task time, applied at creation
   so the failure arrives when the person can act on it.

5. **Scaffolding is refused when on-premise is disabled.** No `ON_PREMISE_ROOT`
   means there is nowhere to put it, and the request is refused with that
   message rather than defaulting to a platform directory.

## Consequences

- A new Odoo project is one form submission: the directory, the repository and
  the module exist, and the first task can be about the change rather than about
  setup.
- The manifest declares `depends: ['base']` only. Naming `sale` in a scaffold
  would be a guess about work not yet described; the agent adds dependencies as
  the change requires them, which is where the decision belongs.
- The skeleton is deliberately minimal — no demo model, no sample view. A
  scaffold that ships example code produces modules carrying dead example code
  for the rest of their life.
- The scaffold is created outside a database transaction, so a failed project
  insert can leave a directory behind. It is created first and the failure names
  it, which is recoverable; the alternative, writing to disk inside a
  transaction, is not.
