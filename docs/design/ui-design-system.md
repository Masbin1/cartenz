# Cartenz UI Design System

Complex infrastructure, simple experience.

This document is the working reference for the portal's interface
(`frontend/`). It turns the design direction (Apple-style clarity, Raycast-style
productivity, developer tooling) into concrete tokens, classes, components and
composition rules. Follow it for every new screen and every change to an
existing one.

## 1. Principles

1. Clarity. Every screen answers, in order: where am I, what matters, what can
   I do, what happened, what next.
2. Calm. Not everything is important. Primary information dominates; secondary
   information recedes. Only states that need the person (waiting, failed) use
   colour in their text.
3. Progressive disclosure. Technical detail (IDs, hashes, raw payloads, logs,
   full configuration) is available on request, not shown by default. Use
   `Disclosure`, a detail link, or a secondary page.
4. Content first. Open layouts on the page background. A box (`.panel`) only
   when a group genuinely needs containment: a form, a scrolling list, a set of
   controls that act together.
5. One primary action per screen. Secondary actions go in an `ActionMenu` once
   there would be more than two buttons side by side.

## 2. Tokens

Defined as CSS variables in `frontend/app/globals.css` and mapped in
`frontend/tailwind.config.ts`. Each person chooses Light, Dark or System in
the sidebar (`ThemeSwitcher`); System, the default, follows the operating
system. The choice is stored per browser (`lib/theme.ts`) and applied before
the first paint by a script in `app/layout.tsx` (`lib/theme-script.ts`), so a
page never flashes the wrong theme. Never hard-code a colour (`#...`,
`text-green-400`, `bg-slate-900`): use a token so both themes work.

| Token | Use |
|---|---|
| `bg-surface` | Page background (#F5F5F7 in light) |
| `bg-surface-raised` | Panels, inputs, menus (white in light) |
| `bg-surface-overlay` | Hover and pressed fills, code wells, skeletons |
| `border-surface-border` | Hairline borders and dividers |
| `border-surface-strong` | Hover border on controls |
| `text-content` | Primary text |
| `text-content-muted` | Secondary text (descriptions, body in supporting areas) |
| `text-content-subtle` | Tertiary text (timestamps, IDs, helper text, labels) |
| `accent` | Primary buttons, active nav, selection, important links only |
| `state-running / waiting / success / failure / idle` | Status meaning only |

### 2.1 Type scale

| Class | Size | Use |
|---|---|---|
| `text-display` | 40/48 semibold | Page title (desktop) |
| `text-display-sm` | 30/38 semibold | Page title (mobile) |
| `text-title` | 24/32 semibold | Section title |
| `text-headline` | 17/24 semibold | Item title, panel title |
| `text-body` | 15/24 | Body copy (the default) |
| `text-callout` | 14/20 | Controls, dense body, list secondary lines |
| `text-meta` | 13/18 | Metadata, labels, timestamps |
| `text-caption` | 12/16 | Monospace identifiers, the smallest text allowed |

Nothing renders below 12px. No uppercase-with-wide-tracking labels: use
sentence-case `.eyebrow` instead. Identifiers, hashes, paths and URLs use
`font-mono text-caption` or `.code-chip`.

### 2.2 Spacing, radius, motion

- Spacing scale: 4, 8, 12, 16, 24, 32, 48, 64, 80 px (Tailwind 1, 2, 3, 4, 6,
  8, 12, 16, 20). Between page sections: `space-y-12` or `space-y-16`.
- Radius: controls `rounded-control` (10px); panels `rounded-card` (16px);
  list rows `rounded-xl`; pills `rounded-full`.
- Shadows: none on the page. `shadow-float` only for floating layers (menus,
  drawers, dialogs).
- Motion: 150 to 200 ms. `animate-fade-in`, `animate-rise-in` for content that
  appears; `transition-colors` for hover. Never decorative.

## 3. Class reference (`globals.css`)

| Class | Purpose |
|---|---|
| `.page`, `.page-wide`, `.page-narrow` | Page content column: 1120px, 1600px (workspaces), 720px (forms, account) |
| `.panel`, `.panel-header`, `.panel-body` | A contained group |
| `.divider` | Hairline top border |
| `.section-title`, `.panel-title`, `.eyebrow`, `.meta`, `.mono-meta` | Typography roles |
| `.link`, `.link-quiet` | Important link (accent) and ordinary link |
| `.code-chip` | Inline identifier |
| `.field-label`, `.field-input`, `.field-hint`, `.field-error` | Forms |
| `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger`, `.btn-sm`, `.icon-btn` | Buttons |
| `.list-row` | A row in an open list, with hover fill |
| `.data-table` | A readable table: generous rows, muted headers |
| `.skeleton` | Loading placeholder |

## 4. Components (`frontend/components/ui/`)

| Component | Purpose |
|---|---|
| `AppShell` | Sidebar navigation (drawer on mobile). Wrap every signed-in page |
| `PageHeader` | Title, one-line description, `meta` row, actions, optional `back` link |
| `BackLink` | One step up the hierarchy |
| `Section` | Titled open region; `divided` for a hairline; `size="small"` inside columns |
| `StatusDot` | Quiet status: dot plus label. Tone: running, waiting, success, failure, idle, neutral |
| `StatusBadge` | `StatusDot` for an `AgentTaskStatus` |
| `ActionMenu` | "More actions" menu for secondary and destructive actions |
| `Disclosure` | Expandable technical detail |
| `DetailList`, `DetailItem` | Label and value pairs; `mono` for identifiers |
| `EmptyState` | What is missing, why it matters, what to do next; optional Lucide icon; `compact` inside columns |
| `Alert` | Info, warning, error, success messages with an icon and optional action |
| `Skeleton`, `SkeletonRows`, `SkeletonText` | In-place loading |
| `PageLoading` | Only while the session resolves, before a page frame exists |
| `ThemeSwitcher` | Light, Dark or System; lives in the sidebar |

Icons: Lucide (`lucide-react`) only, `strokeWidth={1.75}`, 16px inline
(`h-4 w-4`) or 18px in navigation and buttons. Icons support meaning; do not
put one on every line.

## 5. Composition patterns

### 5.1 A standard page

```text
PageHeader  (title, one line of context, one primary action)

Primary content        (the thing the page is for)

Secondary content      (supporting sections, separated by whitespace)
```

### 5.2 An object page (project)

The object's name dominates. Directly under it: its state as a `StatusDot` and
two or three supporting facts in `text-meta`. Then the latest meaningful
event in plain language ("Instance running", "Awaiting your approval"), then
recent activity. Configuration, identifiers and credentials sit lower, in
`DetailList`s and `Disclosure`s.

### 5.3 Lists

Prefer an open list of `.list-row`s over a grid of cards. Each row: a
`text-body font-medium` title, a `text-meta text-content-subtle` line of
supporting facts, status on the right. Use a `.panel` around a list only when
it sits beside other content and needs a boundary.

### 5.4 Forms

`.page-narrow` or a two-column layout (explanation left, fields right) for
long settings pages. Labels above fields. Helper text in `.field-hint`. One
primary submit button at the end; cancel as `.btn-ghost`.

### 5.5 Loading, empty and error states

- Loading: keep the page frame, render `Skeleton*` where the content will be.
- Empty: `EmptyState` with a verb-first action ("Create project").
- Error: `Alert tone="error"` with what happened and what to do.

## 6. Copy

Short, plain, verb-first. "Create project", "View logs", "No projects yet".
Not "Click here to initiate", not "There are currently no records". South
African / British spelling (organisation, analyse, authorise).

## 7. Quality check before a screen is done

1. Can the page's purpose be identified within two seconds?
2. Is the primary action obvious, and is there only one?
3. Is colour used only for meaning?
4. Do title, body and metadata have obviously different size, weight and colour?
5. Is anything there only because there was space?
6. Does it work at 375px wide as well as 1440px?
7. Are loading, empty and error states designed?
