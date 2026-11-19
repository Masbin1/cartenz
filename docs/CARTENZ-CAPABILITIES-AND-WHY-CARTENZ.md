# Cartenz — Capabilities and Why Cartenz

| Field | Value |
| --- | --- |
| Document owner | Lead Software Architect |
| Audience | Client-facing |
| Status | Current as at date below |
| Last updated | 19 November 2026 |
| Related documents | Cartenz User Manual (EN/ID); `README.md` |

This document answers two questions a prospective or existing client asks: **what can
Cartenz actually do**, and **why would an Odoo consultancy use Cartenz rather than
pointing a generic AI coding assistant — such as Claude, ChatGPT, or Copilot — at the
same codebase?**

---

## 1. Executive Summary

Cartenz is an AI-assisted development platform built specifically for Odoo. A user
connects an existing Odoo installation, or asks Cartenz to create one, describes a
change in plain language, and an agent analyses the project, proposes a plan, and —
only once a person approves it — implements the change, tests it against a real Odoo
database, commits it, and pushes it.

A generic AI coding assistant can write code. It was not built to know what an Odoo
module is, to refuse to touch a live production branch, or to prove that the change it
just wrote actually passes that module's own tests. Cartenz exists to close exactly
those gaps for Odoo consultancy work — governed, provable, and safe to run against a
client's live business system.

---

## 2. Capability Overview

| Capability | What it means for you |
| --- | --- |
| Connect any Odoo installation | Git repository, Odoo.sh, on-premise, or Odoo Online — the same conversational workspace works on all four. |
| Create a new Odoo project from a description | No existing codebase required; Cartenz scaffolds it, provisions a running instance, and sets up version control for you. |
| Request changes in plain language | No ticket templates, no technical specification required to get started — write what you need. |
| Human approval at every consequential step | Nothing is written, tested, committed or pushed without a person deciding it should be. |
| Proof the change works | A real, disposable Odoo database tests the change before anyone is asked to approve the push. |
| See the change before it ships | A temporary, running preview instance, not only a text diff. |
| Production is structurally protected | A change can never be requested, built, or pushed against your live system directly. |
| Full accountability | Every action, approval and push is recorded — who did what, and when. |
| No AI-vendor lock-in | The model behind the agent is a setting, not a dependency baked into the platform. |
| One view of everything in flight | Every task, across every project, visible at once. |

---

## 3. Feature and Functionality

| Feature | Functionality |
| --- | --- |
| Connect an existing project | Point Cartenz at a Git repository, an Odoo.sh project, an on-premise installation, or an Odoo Online instance; the agent works on that codebase through the same workspace regardless of which one it is. |
| Create a new project with AI | Describe the project in plain language and choose the Odoo version and edition; Cartenz scaffolds a real Git repository, a runnable configuration, and Development and Staging branches, and provisions a live Odoo instance with the applications you choose already installed — no AI usage spent regenerating anything that already exists. |
| Chat mode | Ask a question about the project — "does this model already have a customer reference field?" — and receive an answer with no code touched. |
| Change mode | Describe a change; Cartenz analyses the project, proposes a plan, and — once approved — implements, tests, commits and pushes it. |
| Odoo-aware understanding | The Odoo version and edition are detected from the project itself; the file to change is found by what it actually declares (which model, which view, which class it extends), not by a keyword guess. |
| Plan review and approval | The exact files and the exact change are shown to a person before a single line is written. |
| Diff review | Every changed file, with lines added and removed, is shown before a push is considered. |
| Live preview | A real, temporary Odoo instance built from the proposed change, so you see it running on screen rather than reading it as a patch, before deciding. |
| Automated validation | Where a test runtime is configured, the change is run against the module's own automated tests in a disposable database created for that task alone, with a pass/fail result reported — then the database is destroyed. |
| Controlled Git workflow | Development, Staging and Production map to real branches; a push needs its own approval (or may be set to auto-approve for routine, non-production work), and a push that does not actually reach its target is reported as a failure rather than a false success. |
| Production protection | A task cannot be created against a Production environment, and a change can never be pushed to it directly — promoting reviewed work to Production is a separate, deliberate administrator action. |
| Access control | Accounts and projects belong to a region by default; a named person can be granted access to a specific project across that boundary; an administrator flag — not a rank — decides who manages deployment-wide settings. |
| Secrets protection | Credentials, tokens and passwords are sealed the moment they are entered and are never returned by any endpoint, logged, or sent to an AI model provider. |
| Full audit trail | Every tool call, approval and push is recorded with who approved what and when. |
| Multi-language requests | Write a request in whichever language you are comfortable with; the agent replies in that same language. |
| Image and document attachments | Paste a screenshot, mock-up or error message directly into a request, or attach a specification document, instead of describing it in words alone. |
| No AI-vendor lock-in | The model behind the agent is a deployment setting; changing providers does not require rebuilding how your Odoo work gets done. |
| AI Office | A live, spatial view of every task running across every project at once, rather than a log to tail. |
| Automatic backups before risky pushes | A backup of the database, files and code is taken automatically before any push to Staging or Production, and a failed backup blocks that push. |
| Conversation history | Requests are grouped as conversations you can reopen exactly where you left them, rather than a flat list of one-off tickets. |
| Shipping to production | A named, deliberate "Ship to production" action merges reviewed Staging work onto the live branch and brings the live instance up to date — never a side effect of a task simply completing. |

---

## 4. Why Cartenz Instead of a Generic AI Coding Agent (such as Claude)

A generic AI coding agent — Claude in a terminal, ChatGPT, Copilot Workspace — is a
capable tool for writing code in general. It was not built for operating on a
consultancy's clients' live Odoo systems, and the difference shows up in exactly the
places that matter for that kind of work.

| Dimension | A generic AI coding agent (e.g. Claude, ChatGPT, Copilot) | Cartenz |
| --- | --- | --- |
| Understanding of Odoo | Reads a repository as plain text; has no concept of an Odoo module, model or view | Detects the Odoo version and edition from the project itself and locates the right file by what it declares, not by a keyword search |
| Who approves a change | Typically no one — the agent edits, and may commit, on its own | Every plan, every diff and every push is shown to a person; nothing proceeds without approval |
| Proof the change works | The model's own assertion that the code "looks correct" | A real, disposable Odoo database is created, the module's own tests are run against it, and the result is reported — then the database is destroyed |
| Reaching production | No concept of a protected branch; it can touch whatever it is pointed at | Production can never be the target of a task — refused outright, before anything is written, not merely flagged |
| What it is able to run | Often has general command (shell) access — able to run anything a person could type | No general command execution exists at all; only a fixed set of mediated actions — read a file, write one quoted region, run Git, run this project's own tests |
| Building a project, not only editing one | Starts from a repository that already exists | Scaffolds a new Odoo project's module layout, provisions a running instance, and creates the Git repository its own commits land in |
| Accountability | No structured record of what was approved, by whom, or when | Every tool call, approval and push sits in an audit trail |
| Protecting secrets | Depends on how the surrounding tooling happens to be set up | A credential is sealed the moment it is entered and is returned by no endpoint, anywhere |
| Dependency on one AI vendor | You are the model you chose, by definition | The model behind the agent is a deployment setting; changing providers does not mean rebuilding how your Odoo work gets done |
| Visibility across many tasks at once | One conversation, one project, open at a time | A live, spatial view of every task running across every project at once |

In short: a generic agent can attempt to write Odoo code. Cartenz writes Odoo code
inside a system that understands Odoo specifically, controls what the agent is allowed
to do, proves the result rather than asserting it, and keeps a complete record of every
step — on the codebase a consultancy's clients actually run in production.

---

## 5. Safety and Governance, in Summary

- **Nothing executes without a human deciding it should.** The plan, the diff, and the
  push are each a separate decision a person makes.
- **Production is a closed door, not a reminder.** A task aimed at a live, production
  environment is refused before anything is written — it is not possible to miss this
  setting, because there is no setting to miss.
- **The agent is code-aware but data-blind by default.** It reads and writes source
  code; it does not read a customer's production business records unless that is
  explicitly and narrowly enabled, and exporting or backing up a database is never
  something any project can be granted.
- **Every credential is sealed on arrival** and is returned by no part of the platform,
  logged, or sent to an AI model provider.
- **Every action is accountable.** Every tool call, approval and push is recorded with
  who approved what and when.

---

## 6. Conclusion

Cartenz is not positioned as a better general-purpose coding assistant than Claude or
any other model-backed tool — it is built from a different premise: that an Odoo
consultancy's AI development agent must understand Odoo, must never act unsupervised on
a client's live system, and must be able to prove, not merely claim, that a change
works. Those three properties are the reason to run Odoo development work through
Cartenz rather than through a generic coding agent pointed at the same repository.

---

## Legal Notice

**Confidentiality.** This document is the property of Linked ERP and is provided on a
confidential basis. It may not be reproduced, distributed, or disclosed to any third
party without the prior written consent of Linked ERP.

**Intellectual Property.** All rights, title, and interest in any intellectual property
contained in this document vest in Linked ERP. No licence, express or implied, is
granted to the recipient by virtue of receiving this document.

**Disclaimer.** The information in this document is provided for general informational
purposes only and does not constitute professional, legal, or financial advice. Linked
ERP makes no representation or warranty as to the accuracy, completeness, or fitness
for purpose of the information provided.

**Document Status.** Specifications and other information in this document may be
subject to change without notice. The most recent version issued by Linked ERP is the
authoritative version.
