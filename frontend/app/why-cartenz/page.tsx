import Link from 'next/link';
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

/**
 * A public page answering one question a prospect or a client stakeholder
 * actually asks: why Cartenz rather than a generic AI coding agent pointed
 * at the same repository. No sign-in required — the same reason `/login`
 * and `/register` render outside the authenticated shell.
 *
 * Content mirrors the "Why Cartenz" section of the repository README, kept
 * in sync by hand: this page is the version a client reads, the README is
 * the version an engineer reads. Say the same thing twice rather than let
 * one of them link to the other and go stale silently.
 */
export default function WhyCartenzPage() {
  return (
    <div className="page max-w-[760px]">
      <header className="mb-12 flex flex-col items-center text-center animate-rise-in">
        <CartenzMark size={40} />
        <p className="eyebrow mt-6">Cartenz by LinkedERP</p>
        <h1 className="mt-2 text-display-sm text-content sm:text-display">
          Why Cartenz, instead of a generic AI coding agent
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

      <div className="mt-12 rounded-card border border-surface-border bg-surface-raised p-6 text-center sm:p-8">
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
