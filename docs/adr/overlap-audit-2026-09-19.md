# ADR Overlap Audit — 19 September 2026

Scope: all 47 implementation ADRs (ADR-011 to ADR-057) in this directory. Method: every
file's own `Status`/`Date`/`Amends`/`Amended by` header was extracted and cross-checked
against `README.md`'s index table and against every other ADR's citations of it; candidate
topic overlaps were then read in full, not judged by keyword count alone (shared boilerplate
section names — Context, Decision, Consequences, Verification — produce false positives on
their own and were discarded).

## Finding 1 — Stale status in the index (fix accordingly)

`docs/adr/README.md` lists **ADR-057 as Proposed**. The file itself
(`ADR-057-merge-to-main-and-project-restart.md`) states `- Status: Accepted`, and the
capability it describes (`merge-to-main`, `restart-project.sh`, the `PROJECT_MERGED_TO_MAIN`
audit event) is implemented and shipped (commits `5a40ce6`, `3a77614`, `6433d49`, `b10067e`,
`ea0ebf0`, `2ddb330`, `d4ba86c`). This is the one index/file mismatch found across all 47
ADRs — checked exhaustively, not sampled.

## Finding 2 — A record's own status lags its implementation

`ADR-056-module-selection-at-project-creation.md` reads `- Status: Proposed`, but the decision
it describes is already built: the module catalogue endpoint, the dependency-closure resolver,
the argument sanitiser, the base-only template, the selective-install path, and
`list-installed-modules.sh` (the eighth fixed shape in the provisioning sudoers allow-list) all
exist in this repository's history (commits `20735c4` through `0c748d1`). The README index
correctly shows ADR-056 as Proposed, consistent with the file — the inconsistency here is
between the ADR's status line and the code, not between two documents. Recorded in
`LinkedERP_AIDevAgent_TechArchitecture_v1.10` § 21 as well.

## Finding 3 — No genuine undocumented overlap found

No two ADRs were found deciding the same question without one citing the other. Every
candidate surfaced by shared vocabulary resolved to one of these three legitimate patterns on
inspection:

1. **Explicit amendment chains**, stated in the amending record's own header or opening note —
   these are a record evolving, not two records disagreeing:
   - ADR-013 → amended by ADR-019 → amended by ADR-027 (the isolation boundary, narrowed twice
     as real constraints were learned)
   - ADR-017 → amended by ADR-036; ADR-018 → amended by ADR-029
   - ADR-020 → amended by ADR-023 → amended by ADR-044 (model-provider scope narrowing from
     environment, to organisation, to one deployment-wide setting)
   - ADR-031 → amended by ADR-033 → amended by ADR-044
   - ADR-032 → amended by ADR-035/ADR-038 → amended by ADR-037
   - ADR-039 → amended by ADR-040
   - ADR-043 → amended by ADR-044
   - ADR-045 → amended by ADR-051 (the region column, added later)

2. **Explicit "Builds on" citations** in the opening lines of nearly every ADR from ADR-039
   onward, forming a dependency chain rather than a collision — e.g. ADR-057 builds on
   ADR-021, ADR-039, ADR-046, ADR-049, ADR-054, ADR-056; ADR-052 builds on ADR-021, ADR-027,
   ADR-039, ADR-045/051, ADR-049, ADR-050.

3. **Adjacent but distinct scope**, confirmed by reading the Decision sections in full, not
   just the titles — the two closest candidates by shared vocabulary were checked this way and
   found not to overlap:
   - ADR-039 (provisioning creates the instance) vs. ADR-049 (an existing instance later pulls
     its own repository) — different lifecycle stages of the same instance, not a repeated
     decision; ADR-049's own text calls itself "the odoo.sh half ADR-041 left out," correctly
     scoping itself against ADR-041, not ADR-039.
   - ADR-023 (the provider is configured in the portal) vs. ADR-027 (running Odoo for
     validation, once one is configured) — one is about setting the provider, the other about
     what happens once code needs to run; they share the words "configured" and "refused" only
     incidentally.

## What this means for the ADR set

No consolidation or retraction is warranted. The two fixes above are single status-line edits
(see this repository's ADR-057 and README.md changes made alongside this audit), not new
decisions. The chain-of-amendment pattern found throughout (13→19→27, 20→23→44, 31→33→44,
32→35→38→37, 45→51) is working as intended: each amendment is a short, dated note pointing to
its predecessor rather than a rewrite, which is exactly what lets a reader reconstruct why a
decision changed.
