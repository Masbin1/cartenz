import Link from 'next/link';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Blocks,
  Boxes,
  Building2,
  Eye,
  GitBranch,
  Hand,
  Lock,
  ShieldCheck,
  TerminalSquare,
  TestTube2,
  Unplug,
} from 'lucide-react';
import { CartenzMark } from '@/components/ui/cartenz-mark';
import { Section } from '@/components/ui/section';

/**
 * A public page answering what Cartenz does and why Cartenz, rather than a
 * generic AI coding agent, should run Odoo development work. No sign-in
 * required — the same reason `/login` and `/register` render outside the
 * authenticated shell.
 *
 * Content mirrors `docs/CARTENZ-CAPABILITIES-AND-WHY-CARTENZ.md` (the
 * client-facing capabilities document) and the "Why Cartenz" section of the
 * repository README, kept in sync by hand across all three: the document is
 * the version handed to a client, the README is the version an engineer
 * reads, this page is the version a visitor reads without an account. Say
 * the same thing in each rather than let one link to another and go stale
 * silently. The source document's Legal Notice (confidentiality, IP,
 * disclaimer) is a client-document convention and is not reproduced here —
 * this page carries a plain copyright line instead.
 */
export default function WhyCartenzPage() {
  return (
    <div className="page max-w-[760px]">
      <header className="mb-12 flex flex-col items-center text-center animate-rise-in">
        <CartenzMark size={40} />
        <p className="eyebrow mt-6">Cartenz by LinkedERP</p>
        <h1 className="mt-2 text-display-sm text-content sm:text-display">
          What Cartenz does, and why Cartenz
        </h1>
        <p className="mt-4 max-w-xl text-body text-content-muted sm:text-[1.0625rem] sm:leading-7">
          A generic coding agent can write code. None of them know what an Odoo
          module is, none of them refuse to touch <code className="mono-meta">main</code>,
          and none of them can prove the change they just wrote actually passes
          the module&apos;s own tests. Cartenz exists to close exactly those gaps
          for Odoo consultancy work — not to be a better general-purpose coding
          assistant.
        </p>
      </header>

      <Section title="Executive summary" size="small" className="mb-12">
        <div className="space-y-4 text-callout leading-relaxed text-content-muted">
          <p>
            Cartenz is an AI-assisted development platform built specifically for
            Odoo. A user connects an existing Odoo installation, or asks Cartenz
            to create one, describes a change in plain language, and an agent
            analyses the project, proposes a plan, and — only once a person
            approves it — implements the change, tests it against a real Odoo
            database, commits it, and pushes it.
          </p>
          <p>
            A generic AI coding assistant can write code. It was not built to
            know what an Odoo module is, to refuse to touch a live production
            branch, or to prove that the change it just wrote actually passes
            that module&apos;s own tests. Cartenz exists to close exactly those
            gaps for Odoo consultancy work — governed, provable, and safe to run
            against a client&apos;s live business system.
          </p>
        </div>
      </Section>

      <Section title="Capability overview" size="small" className="mb-12" divided>
        <InfoTable
          columns={['Capability', 'What it means for you']}
          rows={[
            ['Connect any Odoo installation', 'Git repository, Odoo.sh, on-premise, or Odoo Online — the same conversational workspace works on all four.'],
            ['Create a new Odoo project from a description', 'No existing codebase required; Cartenz scaffolds it, provisions a running instance, and sets up version control for you.'],
            ['Request changes in plain language', 'No ticket templates, no technical specification required to get started — write what you need.'],
            ['Human approval at every consequential step', 'Nothing is written, tested, committed or pushed without a person deciding it should be.'],
            ['Proof the change works', 'A real, disposable Odoo database tests the change before anyone is asked to approve the push.'],
            ['See the change before it ships', 'A temporary, running preview instance, not only a text diff.'],
            ['Production is structurally protected', 'A change can never be requested, built, or pushed against your live system directly.'],
            ['Full accountability', 'Every action, approval and push is recorded — who did what, and when.'],
            ['No AI-vendor lock-in', 'The model behind the agent is a setting, not a dependency baked into the platform.'],
            ['One view of everything in flight', 'Every task, across every project, visible at once.'],
          ]}
        />
      </Section>

      <Section title="Feature and functionality" size="small" className="mb-12" divided>
        <InfoTable
          columns={['Feature', 'Functionality']}
          rows={[
            ['Connect an existing project', 'Point Cartenz at a Git repository, an Odoo.sh project, an on-premise installation, or an Odoo Online instance; the agent works on that codebase through the same workspace regardless of which one it is.'],
            ['Create a new project with AI', 'Describe the project in plain language and choose the Odoo version and edition; Cartenz scaffolds a real Git repository, a runnable configuration, and Development and Staging branches, and provisions a live Odoo instance with the applications you choose already installed — no AI usage spent regenerating anything that already exists.'],
            ['Chat mode', 'Ask a question about the project — "does this model already have a customer reference field?" — and receive an answer with no code touched.'],
            ['Change mode', 'Describe a change; Cartenz analyses the project, proposes a plan, and — once approved — implements, tests, commits and pushes it.'],
            ['Odoo-aware understanding', 'The Odoo version and edition are detected from the project itself; the file to change is found by what it actually declares (which model, which view, which class it extends), not by a keyword guess.'],
            ['Plan review and approval', 'The exact files and the exact change are shown to a person before a single line is written.'],
            ['Diff review', 'Every changed file, with lines added and removed, is shown before a push is considered.'],
            ['Live preview', 'A real, temporary Odoo instance built from the proposed change, so you see it running on screen rather than reading it as a patch, before deciding.'],
            ['Automated validation', 'Where a test runtime is configured, the change is run against the module\u2019s own automated tests in a disposable database created for that task alone, with a pass/fail result reported — then the database is destroyed.'],
            ['Controlled Git workflow', 'Development, Staging and Production map to real branches; a push needs its own approval (or may be set to auto-approve for routine, non-production work), and a push that does not actually reach its target is reported as a failure rather than a false success.'],
            ['Production protection', 'A task cannot be created against a Production environment, and a change can never be pushed to it directly — promoting reviewed work to Production is a separate, deliberate administrator action.'],
            ['Access control', 'Accounts and projects belong to a region by default; a named person can be granted access to a specific project across that boundary; an administrator flag — not a rank — decides who manages deployment-wide settings.'],
            ['Secrets protection', 'Credentials, tokens and passwords are sealed the moment they are entered and are never returned by any endpoint, logged, or sent to an AI model provider.'],
            ['Full audit trail', 'Every tool call, approval and push is recorded with who approved what and when.'],
            ['Multi-language requests', 'Write a request in whichever language you are comfortable with; the agent replies in that same language.'],
            ['Image and document attachments', 'Paste a screenshot, mock-up or error message directly into a request, or attach a specification document, instead of describing it in words alone.'],
            ['No AI-vendor lock-in', 'The model behind the agent is a deployment setting; changing providers does not require rebuilding how your Odoo work gets done.'],
            ['AI Office', 'A live, spatial view of every task running across every project at once, rather than a log to tail.'],
            ['Automatic backups before risky pushes', 'A backup of the database, files and code is taken automatically before any push to Staging or Production, and a failed backup blocks that push.'],
            ['Conversation history', 'Requests are grouped as conversations you can reopen exactly where you left them, rather than a flat list of one-off tickets.'],
            ['Shipping to production', 'A named, deliberate "Ship to production" action merges reviewed Staging work onto the live branch and brings the live instance up to date — never a side effect of a task simply completing.'],
          ]}
        />
      </Section>

      <Section
        title="Why Cartenz instead of a generic AI coding agent"
        description="A generic AI coding agent — Claude in a terminal, ChatGPT, Copilot Workspace — is a capable tool for writing code in general. It was not built for operating on a consultancy's clients' live Odoo systems, and the difference shows up in exactly the places that matter for that kind of work."
        size="small"
        className="mb-12"
        divided
      >
        <div className="space-y-5">
          <Reason
            icon={Blocks}
            title="It understands Odoo, not just text"
            body={
              <>
                Every plan is built from the project&apos;s actual manifests and
                models. The Odoo version is detected from{' '}
                <code className="mono-meta">__manifest__.py</code>, not asked for;
                candidate files are ranked by what they declare — which model,
                which view, which inherited class — not by a keyword match. A
                generic agent greps a repository; Cartenz reads it as an Odoo
                project.
              </>
            }
          />
          <Reason
            icon={Hand}
            title="Nothing executes without a human approving it first"
            body={
              <>
                The plan — the exact files, the exact change — is shown to a
                person before a single line is written. The diff, again, before
                anything is committed. The push, again, before anything reaches
                the remote. A coding agent that decides and acts in one step is a
                liability in a client&apos;s production codebase; every step past
                read access here is something a person signs off on.
              </>
            }
          />
          <Reason
            icon={TestTube2}
            title="It proves the change works, instead of asserting it"
            body={
              <>
                Where an Odoo runtime is configured, Cartenz installs the touched
                module into a scratch database created for that one task, runs
                the module&apos;s own tests, and reports pass or fail — then
                destroys the database. That is a real test run against real
                Odoo, not a model&apos;s opinion that the code &ldquo;looks
                correct&rdquo;.
              </>
            }
          />
          <Reason
            icon={Lock}
            title="Production is a closed door, not a reminder"
            body={
              <>
                A task aimed at a production branch or environment is refused
                before any row is written — not flagged, not warned about,
                refused. On-premise work happens directly on the customer&apos;s
                live custom-module directory, while the shared Odoo core and
                Enterprise trees stay strictly read-only.
              </>
            }
          />
          <Reason
            icon={TerminalSquare}
            title="There is no shell"
            body={
              <>
                Cartenz has no general-purpose command execution at all — the
                tool registry is tested to assert none exists. Every effect is
                one of a fixed set of mediated tools: read a file, write a file,
                run git, run this project&apos;s own Odoo tests. A generic agent
                with shell access can run anything a human can type; Cartenz
                cannot run anything that is not on that list.
              </>
            }
          />
          <Reason
            icon={Building2}
            title="It can build the project, not only edit it"
            body={
              <>
                Beyond connecting to an existing Odoo codebase, Cartenz scaffolds
                a new project&apos;s module layout, provisions a running Odoo
                instance behind HTTPS, and creates the GitHub repository its
                commits land in — the same governance applies from the first
                commit onward.
              </>
            }
          />
          <Reason
            icon={ShieldCheck}
            title="Every action is accountable"
            body={
              <>
                Every tool call, every approval and every push sits in the audit
                log with who approved what and when. Secrets are sealed on
                arrival and returned by no endpoint. Everything sent to or
                received from a model passes one data boundary, in both
                directions, with no exception.
              </>
            }
          />
          <Reason
            icon={Eye}
            title="One place to see everything in flight"
            body={
              <>
                The AI Office view gives a live, spatial read of every task
                actually running across every project — not a log file to tail,
                a floor you can look at.
              </>
            }
          />
          <Reason
            icon={Unplug}
            title="No lock-in to one AI vendor"
            body={
              <>
                The model behind the agent is configured per deployment, not
                hard-coded to one provider; swapping models does not mean
                rewriting the platform.
              </>
            }
          />
        </div>

        <div className="mt-8">
          <h3 className="mb-3 text-headline text-content">Side-by-side comparison</h3>
          <InfoTable
            columns={['Dimension', 'A generic AI coding agent (e.g. Claude, ChatGPT, Copilot)', 'Cartenz']}
            rows={[
              ['Understanding of Odoo', 'Reads a repository as plain text; has no concept of an Odoo module, model or view', 'Detects the Odoo version and edition from the project itself and locates the right file by what it declares, not by a keyword search'],
              ['Who approves a change', 'Typically no one — the agent edits, and may commit, on its own', 'Every plan, every diff and every push is shown to a person; nothing proceeds without approval'],
              ['Proof the change works', 'The model\u2019s own assertion that the code "looks correct"', 'A real, disposable Odoo database is created, the module\u2019s own tests are run against it, and the result is reported — then the database is destroyed'],
              ['Reaching production', 'No concept of a protected branch; it can touch whatever it is pointed at', 'Production can never be the target of a task — refused outright, before anything is written, not merely flagged'],
              ['What it is able to run', 'Often has general command (shell) access — able to run anything a person could type', 'No general command execution exists at all; only a fixed set of mediated actions — read a file, write one quoted region, run Git, run this project\u2019s own tests'],
              ['Building a project, not only editing one', 'Starts from a repository that already exists', 'Scaffolds a new Odoo project\u2019s module layout, provisions a running instance, and creates the Git repository its own commits land in'],
              ['Accountability', 'No structured record of what was approved, by whom, or when', 'Every tool call, approval and push sits in an audit trail'],
              ['Protecting secrets', 'Depends on how the surrounding tooling happens to be set up', 'A credential is sealed the moment it is entered and is returned by no endpoint, anywhere'],
              ['Dependency on one AI vendor', 'You are the model you chose, by definition', 'The model behind the agent is a deployment setting; changing providers does not mean rebuilding how your Odoo work gets done'],
              ['Visibility across many tasks at once', 'One conversation, one project, open at a time', 'A live, spatial view of every task running across every project at once'],
            ]}
          />
        </div>

        <p className="mt-6 text-callout leading-relaxed text-content-muted">
          In short: a generic agent can attempt to write Odoo code. Cartenz writes
          Odoo code inside a system that understands Odoo specifically, controls
          what the agent is allowed to do, proves the result rather than
          asserting it, and keeps a complete record of every step — on the
          codebase a consultancy&apos;s clients actually run in production.
        </p>
      </Section>

      <Section title="Safety and governance, in summary" size="small" className="mb-12" divided>
        <ul className="list-disc space-y-3 pl-5 text-callout leading-relaxed text-content-muted marker:text-content-subtle">
          <li>
            <strong className="font-medium text-content">Nothing executes without a human deciding it should.</strong>{' '}
            The plan, the diff, and the push are each a separate decision a person makes.
          </li>
          <li>
            <strong className="font-medium text-content">Production is a closed door, not a reminder.</strong>{' '}
            A task aimed at a live, production environment is refused before anything is written —
            it is not possible to miss this setting, because there is no setting to miss.
          </li>
          <li>
            <strong className="font-medium text-content">The agent is code-aware but data-blind by default.</strong>{' '}
            It reads and writes source code; it does not read a customer&apos;s production business
            records unless that is explicitly and narrowly enabled, and exporting or backing up a
            database is never something any project can be granted.
          </li>
          <li>
            <strong className="font-medium text-content">Every credential is sealed on arrival</strong>{' '}
            and is returned by no part of the platform, logged, or sent to an AI model provider.
          </li>
          <li>
            <strong className="font-medium text-content">Every action is accountable.</strong>{' '}
            Every tool call, approval and push is recorded with who approved what and when.
          </li>
        </ul>
      </Section>

      <Section title="Conclusion" size="small" className="mb-12" divided>
        <p className="text-callout leading-relaxed text-content-muted">
          Cartenz is not positioned as a better general-purpose coding assistant than Claude or any
          other model-backed tool — it is built from a different premise: that an Odoo
          consultancy&apos;s AI development agent must understand Odoo, must never act unsupervised
          on a client&apos;s live system, and must be able to prove, not merely claim, that a change
          works. Those three properties are the reason to run Odoo development work through Cartenz
          rather than through a generic coding agent pointed at the same repository.
        </p>
      </Section>

      <div className="rounded-card border border-surface-border bg-surface-raised p-6 text-center sm:p-8">
        <Boxes className="mx-auto h-6 w-6 text-content-subtle" strokeWidth={1.75} aria-hidden="true" />
        <p className="mt-3 text-body text-content-muted">
          The result is not &ldquo;an AI that writes Odoo code&rdquo; — plenty
          of generic agents can attempt that. It is an AI that writes Odoo code
          inside a system that controls, proves and records what it did, on
          the codebase a consultancy&apos;s clients actually run in production.
        </p>
      </div>

      <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
        <Link href="/login" className="btn-primary">
          Sign in to Cartenz
        </Link>
        <Link href="/dashboard" className="btn-secondary">
          <GitBranch className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          Go to Overview
        </Link>
      </div>

      <p className="mt-10 text-center text-meta text-content-subtle">
        &copy; {new Date().getFullYear()} LinkedERP. All rights reserved.
      </p>
    </div>
  );
}

/** A plain two- or three-column reference table, scrollable on narrow screens. */
function InfoTable({ columns, rows }: { columns: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-surface-border">
      <table className="w-full border-collapse text-left text-callout [&_tbody_tr:last-child>td]:border-b-0">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                className="border-b border-surface-border bg-surface-overlay/60 px-3 py-2 text-left text-meta font-medium text-content-muted"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            // eslint-disable-next-line react/no-array-index-key -- rows are a static, ordered reference table
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td
                  // eslint-disable-next-line react/no-array-index-key -- cells are a static, ordered reference table
                  key={cellIndex}
                  className={`border-b border-surface-border/70 px-3 py-2.5 align-top ${
                    cellIndex === 0 ? 'font-medium text-content' : 'text-content-muted'
                  }`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Reason({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="flex animate-fade-in gap-4 rounded-card border border-surface-border bg-surface-raised p-5 sm:p-6">
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent"
        aria-hidden="true"
      >
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
      </span>
      <div className="min-w-0">
        <h2 className="text-headline text-content">{title}</h2>
        <p className="mt-1.5 text-callout leading-relaxed text-content-muted">{body}</p>
      </div>
    </div>
  );
}
