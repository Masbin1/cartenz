# ADR-061: A calm, content-first portal design

- Status: Accepted
- Date: 23 September 2026
- Milestone: Phase 5 (connected-server estate)

## Context

The portal was built as a dark, dense developer console: an 11px base for
metadata, uppercase panel labels, every section boxed in a bordered panel, a
thin top navigation bar, and the whole application in one dark palette. The
reasoning, recorded in `frontend/tailwind.config.ts`, was that vertical space
belongs to the agent workspace rather than to chrome.

That reasoning holds for the agent workspace. It does not hold for the rest of
the portal. Projects, approvals, settings and users are read far more than they
are operated, and they are read by consultants and client stakeholders as well
as developers. At the old density every element competed for attention:
titles, metadata and status were close in size, weight and colour, and a page
read as a wall of equal boxes. The product direction for Cartenz is "complex
infrastructure, simple experience"; the interface was communicating the
opposite.

## Decision

1. Light, neutral foundation (page `#F5F5F7`, surfaces white) and a dark
   theme. Each person chooses Light, Dark or System in the sidebar; System,
   the default, follows the operating system. The choice is a per-browser
   display preference in localStorage, not account data. Colours are CSS
   variables so both themes share one set of class names.
2. The LinkedERP red is reserved for primary actions, active navigation,
   selection and important links. Status colours carry meaning only, and only
   states that need a person (waiting, failed) colour their text.
3. Inter as the typeface, self-hosted through `@fontsource-variable/inter` so
   on-premise installs without internet access still render it. A named type
   scale (display, title, headline, body, callout, meta, caption) with nothing
   below 12px.
4. Open layouts on the page background, separated by whitespace. A bordered
   panel only where content needs containment. No shadows on the page.
5. Sidebar navigation (a drawer on mobile) with two groups: Overview and
   Projects, then Users and Settings.
6. Progressive disclosure for technical detail, one primary action per screen,
   secondary actions in a menu.
7. One icon library, Lucide (`lucide-react`).
8. The agent workspace keeps a denser, tool-like layout within the same system.

The working reference is `docs/design/ui-design-system.md`.

## Consequences

- The change is presentational. No API, state, permission or routing behaviour
  changes.
- Every page was recomposed, not recoloured; new UI must use the shared
  primitives in `frontend/components/ui/` and the tokens, never hard-coded
  colours, or it will break one of the two themes.
- Two runtime dependencies were added: `lucide-react` and
  `@fontsource-variable/inter`.

## Retirement

Revisit if a formal LinkedERP product design system is issued that supersedes
these tokens and components.
