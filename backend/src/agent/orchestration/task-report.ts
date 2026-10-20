/**
 * The reply a person reads when a task settles (ADR-081).
 *
 * A chat task's reply is the model's answer. A change task had no reply at all:
 * the model's account of its work went to the Activity log, and the thread showed
 * whichever status line the last transition carried - "Branch Staging was pushed
 * to the remote repository at commit 4e389b49." A failed task showed nothing but
 * a red badge. The person asked for work and was told where it went, not what it
 * was.
 *
 * This module composes that reply from what the task actually recorded: the
 * model's own report, the files git says changed, the validation result, the
 * commit, and how the task ended. It is pure - no database, no clock - so what a
 * person is told is testable without running a task. Facts come from the task
 * row, never from the model's prose: a file is listed because git changed it, a
 * push is reported because the push step completed.
 */

export type ReportLanguage = 'id' | 'en';

export interface ReportFile {
  readonly path: string;
  readonly change: string;
  readonly summary: string | null;
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

export interface TaskReportFacts {
  readonly kind: 'change' | 'chat';
  readonly prompt: string;
  /** The model's report of its work: a chat's answer, a change's implementation summary. */
  readonly body: string | null;
  /** The approved plan's summary, used when the model reported nothing. */
  readonly planSummary: string | null;
  readonly files: readonly ReportFile[];
  readonly linesAdded: number | null;
  readonly linesRemoved: number | null;
  readonly pull: { readonly outcome: string; readonly branch: string; readonly commits: number } | null;
  readonly tests: {
    readonly passed: number;
    readonly failed: number;
    readonly simulated: boolean;
  } | null;
  readonly commitHash: string | null;
  readonly branch: string | null;
}

export interface TaskSettlement {
  readonly outcome: 'completed' | 'failed';
  /** The status the task settled from - where it was when it finished or broke. */
  readonly from: string;
  readonly message: string | null;
  readonly failureReason: string | null;
}

/** The summary the workflow writes when the plan gave a file no reason of its own. */
const GENERIC_FILE_SUMMARIES = new Set([
  'Changed while carrying out the approved plan',
  'Changed in conversation, with your approval',
]);

const MAX_FILES_LISTED = 20;
const MAX_FAILURE_CHARS = 1_500;

const INDONESIAN_MARKERS =
  /\b(yang|dan|tolong|bisa|buat|buatkan|gak|nggak|enggak|tidak|dong|kita|saya|aku|ini|itu|untuk|dengan|sudah|udah|ubah|tambah|tambahkan|jadi|kalau|kalo|gimana|bagaimana|apa|coba|harus|supaya|biar|juga|lagi|aja|saja)\b/gi;
const ENGLISH_MARKERS =
  /\b(the|and|please|add|make|can|could|you|this|that|with|for|of|is|are|should|would|want|need|create|change|update)\b/gi;

/**
 * The language a request was written in, by marker words.
 *
 * The planning and implementation instructions already require the model to
 * answer in the person's language, defaulting to Indonesian when it is neither.
 * The platform's own lines follow the same rule so one reply does not switch
 * language halfway through. A tie goes to Indonesian, the platform default.
 */
export function reportLanguage(prompt: string): ReportLanguage {
  const indonesian = new Set((prompt.match(INDONESIAN_MARKERS) ?? []).map((word) => word.toLowerCase())).size;
  const english = new Set((prompt.match(ENGLISH_MARKERS) ?? []).map((word) => word.toLowerCase())).size;
  return english > indonesian ? 'en' : 'id';
}

const TEXT = {
  id: {
    plannedWork: 'Rencana yang dijalankan',
    files: (count: number) => `**Perubahan file** — ${count} file`,
    added: 'ditambah',
    modified: 'diubah',
    deleted: 'dihapus',
    more: (count: number) => `… dan ${count} file lainnya`,
    pullUpToDate: (branch: string) => `**Pull**: \`${branch}\` sudah sama dengan remote, tidak ada yang perlu ditarik.`,
    pulled: (commits: number, branch: string) => `**Pull**: ${commits} commit ditarik ke \`${branch}\`.`,
    testsSimulated: (count: number) =>
      `**Validasi**: ${count} langkah disimulasikan — kode belum dijalankan, jadi ini belum bukti perubahannya berjalan.`,
    testsPassed: (count: number) => `**Validasi**: ${count} test lulus.`,
    testsFailed: (failed: number, total: number) => `**Validasi**: ${failed} dari ${total} test gagal.`,
    pushed: (commit: string, branch: string) =>
      `**Selesai** — commit \`${commit}\` sudah di-push ke \`${branch}\`.`,
    committedNotPushed: (commit: string, branch: string) =>
      `**Selesai** — commit \`${commit}\` dibuat di \`${branch}\`, tetapi belum di-push.`,
    notCommitted: '**Selesai** — perubahannya belum di-commit; diff-nya tersimpan di task ini.',
    committedButPushFailed: (commit: string, branch: string) =>
      `Commit \`${commit}\` sudah dibuat di \`${branch}\`, tetapi belum sampai ke remote.`,
    noRemote: 'Project ini belum punya remote repository.',
    pushDisabled: 'Push dinonaktifkan di server ini (GIT_PUSH_ENABLED=false).',
    appliedToInstance: 'perubahannya sudah diterapkan ke instance Odoo Online.',
    nothingToCommit: 'tidak ada perubahan file yang perlu di-commit atau di-push.',
    noRepository: 'project ini belum terhubung ke repository, jadi tidak ada commit.',
    done: '**Selesai**',
    failed: (stage: string) => `**Gagal** di tahap ${stage}.`,
    failedUnknown: '**Gagal**.',
    stages: {
      analyzing: 'analisis',
      planning: 'perencanaan',
      waiting_approval: 'persetujuan',
      implementing: 'implementasi',
      testing: 'validasi',
      committing: 'commit',
      pushing: 'push',
      building: 'build',
    } as Record<string, string>,
  },
  en: {
    plannedWork: 'Plan carried out',
    files: (count: number) => `**Files changed** — ${count} file${count === 1 ? '' : 's'}`,
    added: 'added',
    modified: 'modified',
    deleted: 'deleted',
    more: (count: number) => `… and ${count} more file${count === 1 ? '' : 's'}`,
    pullUpToDate: (branch: string) => `**Pull**: \`${branch}\` was already up to date with the remote.`,
    pulled: (commits: number, branch: string) => `**Pull**: pulled ${commits} commit(s) into \`${branch}\`.`,
    testsSimulated: (count: number) =>
      `**Validation**: ${count} simulated step(s) — no repository code was run, so this is not evidence the change works.`,
    testsPassed: (count: number) => `**Validation**: ${count} test(s) passed.`,
    testsFailed: (failed: number, total: number) => `**Validation**: ${failed} of ${total} test(s) failed.`,
    pushed: (commit: string, branch: string) =>
      `**Done** — commit \`${commit}\` was pushed to \`${branch}\`.`,
    committedNotPushed: (commit: string, branch: string) =>
      `**Done** — commit \`${commit}\` was made on \`${branch}\`, but it was not pushed.`,
    notCommitted: '**Done** — the change was not committed; its diff is kept on this task.',
    committedButPushFailed: (commit: string, branch: string) =>
      `Commit \`${commit}\` was made on \`${branch}\`, but it did not reach the remote.`,
    noRemote: 'This project has no remote repository.',
    pushDisabled: 'Pushing is disabled on this server (GIT_PUSH_ENABLED=false).',
    appliedToInstance: 'the change was applied to the Odoo Online instance.',
    nothingToCommit: 'no file changed, so there was nothing to commit or push.',
    noRepository: 'no repository is connected to this project, so no commit was made.',
    done: '**Done**',
    failed: (stage: string) => `**Failed** at the ${stage} step.`,
    failedUnknown: '**Failed**.',
    stages: {
      analyzing: 'analysis',
      planning: 'planning',
      waiting_approval: 'approval',
      implementing: 'implementation',
      testing: 'validation',
      committing: 'commit',
      pushing: 'push',
      building: 'build',
    } as Record<string, string>,
  },
} as const;

/**
 * The reply for a task that has just settled, or null when there is nothing to
 * say at all (no report, no fact, no message).
 *
 * A chat that only answered keeps its answer exactly as the model wrote it: a
 * conversation's reply is the answer, and decorating a plain answer with
 * "Done" would make every reply read like a status report.
 */
export function composeTaskReport(facts: TaskReportFacts, settlement: TaskSettlement): string | null {
  const body = facts.body?.trim() || null;
  const answeredOnly =
    facts.kind === 'chat' &&
    settlement.outcome === 'completed' &&
    facts.files.length === 0 &&
    !facts.commitHash;

  if (answeredOnly) return body;

  const text = TEXT[reportLanguage(facts.prompt)];
  const sections: string[] = [];

  if (body) {
    sections.push(body);
  } else if (facts.planSummary?.trim()) {
    sections.push(`**${text.plannedWork}**: ${facts.planSummary.trim()}`);
  }

  if (facts.files.length > 0) {
    sections.push(renderFiles(facts, text));
  }

  if (facts.pull) {
    sections.push(
      facts.pull.outcome === 'up_to_date'
        ? text.pullUpToDate(facts.pull.branch)
        : text.pulled(facts.pull.commits, facts.pull.branch),
    );
  }

  const tests = renderTests(facts, text);
  if (tests) sections.push(tests);

  sections.push(renderOutcome(facts, settlement, text));

  const report = sections.filter((section) => section.trim().length > 0).join('\n\n').trim();
  return report.length > 0 ? report : null;
}

type Text = (typeof TEXT)[ReportLanguage];

function renderFiles(facts: TaskReportFacts, text: Text): string {
  const added = facts.linesAdded ?? facts.files.reduce((sum, file) => sum + file.linesAdded, 0);
  const removed = facts.linesRemoved ?? facts.files.reduce((sum, file) => sum + file.linesRemoved, 0);

  const lines = [`${text.files(facts.files.length)}, +${added}/−${removed}`];

  for (const file of facts.files.slice(0, MAX_FILES_LISTED)) {
    const change =
      file.change === 'added' ? text.added : file.change === 'deleted' ? text.deleted : text.modified;
    const reason =
      file.summary && !GENERIC_FILE_SUMMARIES.has(file.summary.trim()) ? ` — ${file.summary.trim()}` : '';
    lines.push(`- \`${file.path}\` (${change}, +${file.linesAdded}/−${file.linesRemoved})${reason}`);
  }

  const more = facts.files.length - MAX_FILES_LISTED;
  if (more > 0) lines.push(`- ${text.more(more)}`);

  return lines.join('\n');
}

function renderTests(facts: TaskReportFacts, text: Text): string | null {
  // A chat that wrote is not validated; only a change task's results are reported.
  if (facts.kind !== 'change' || !facts.tests) return null;

  const total = facts.tests.passed + facts.tests.failed;
  if (total === 0) return null;

  if (facts.tests.simulated) return text.testsSimulated(total);
  return facts.tests.failed > 0
    ? text.testsFailed(facts.tests.failed, total)
    : text.testsPassed(facts.tests.passed);
}

function renderOutcome(facts: TaskReportFacts, settlement: TaskSettlement, text: Text): string {
  const commit = facts.commitHash?.slice(0, 8) ?? null;
  const branch = facts.branch ?? '';

  if (settlement.outcome === 'failed') {
    const stage = text.stages[settlement.from];
    let headline = stage ? text.failed(stage) : text.failedUnknown;
    // A push that failed after the commit was made leaves the work somewhere -
    // in the commit - and saying so is the difference between "redo it" and
    // "push it again".
    if (settlement.from === 'pushing' && commit) {
      headline = `${headline} ${text.committedButPushFailed(commit, branch)}`;
    }
    const reason = cleanFailure(settlement.failureReason);
    if (!reason) return headline;
    return reason.includes('\n') ? `${headline}\n\n\`\`\`\n${reason}\n\`\`\`` : `${headline} ${reason}`;
  }

  // `pushing -> completed` is reached only when the push step verified the
  // commit on the remote, so the reply may say it was pushed. `building` follows
  // a push too.
  if ((settlement.from === 'pushing' || settlement.from === 'building') && commit) {
    return text.pushed(commit, branch);
  }

  if (commit) {
    const why = localise(settlement.message, text);
    return `${text.committedNotPushed(commit, branch)}${why ? ` ${why}` : ''}`;
  }

  if (facts.files.length > 0) return text.notCommitted;

  // A pull-only request already said what happened in its own line.
  if (facts.pull) return text.done;

  const message = localise(settlement.message, text);
  return message ? `${text.done} — ${message}` : text.done;
}

/**
 * A settlement line in the reply's language when it is one the platform itself
 * states, and verbatim otherwise - so an Indonesian reply does not end in an
 * English status sentence the platform wrote for the Activity log.
 */
function localise(message: string | null, text: Text): string | null {
  const trimmed = message?.trim();
  if (!trimmed) return null;
  if (/no remote/i.test(trimmed)) return text.noRemote;
  if (/pushing is disabled/i.test(trimmed)) return text.pushDisabled;
  if (/applied to the Odoo Online instance/i.test(trimmed)) return text.appliedToInstance;
  if (/working tree is unchanged/i.test(trimmed)) return text.nothingToCommit;
  if (/No repository is connected/i.test(trimmed)) return text.noRepository;
  return trimmed;
}

/**
 * The facts a report is composed from, read off a task row.
 *
 * The jsonb columns are read defensively: they are written by several steps
 * over the platform's history, and a report must never fail because an older
 * row stored a shape this code does not expect.
 */
export function reportFactsFromTask(row: {
  readonly kind: string;
  readonly prompt: string;
  readonly answer: string | null;
  readonly plan: unknown;
  readonly modifiedFiles: unknown;
  readonly diffStats: unknown;
  readonly testResults: unknown;
  readonly commitHash: string | null;
  readonly branch: string | null;
}): TaskReportFacts {
  const plan = asRecord(row.plan);
  const stats = asRecord(row.diffStats);
  const tests = asRecord(row.testResults);
  const pull = asRecord(stats?.pull);

  const files: ReportFile[] = Array.isArray(row.modifiedFiles)
    ? row.modifiedFiles.flatMap((entry) => {
        const file = asRecord(entry);
        if (!file || typeof file.path !== 'string' || file.path.length === 0) return [];
        return [
          {
            path: file.path,
            change: typeof file.change === 'string' ? file.change : 'modified',
            summary: typeof file.summary === 'string' ? file.summary : null,
            linesAdded: asNumber(file.linesAdded) ?? 0,
            linesRemoved: asNumber(file.linesRemoved) ?? 0,
          },
        ];
      })
    : [];

  return {
    kind: row.kind === 'chat' ? 'chat' : 'change',
    prompt: row.prompt,
    body: row.answer,
    planSummary: typeof plan?.summary === 'string' ? plan.summary : null,
    files,
    linesAdded: asNumber(stats?.linesAdded),
    linesRemoved: asNumber(stats?.linesRemoved),
    pull:
      pull && typeof pull.outcome === 'string' && typeof pull.branch === 'string'
        ? { outcome: pull.outcome, branch: pull.branch, commits: asNumber(pull.commits) ?? 0 }
        : null,
    tests: tests
      ? {
          passed: asNumber(tests.passed) ?? 0,
          failed: asNumber(tests.failed) ?? 0,
          simulated: tests.simulated === true,
        }
      : null,
    commitHash: row.commitHash,
    branch: row.branch,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A failure reason as a person should read it. Git's own output is kept - it is
 * what says why a push was refused - but SSH's host-key chatter and carriage
 * returns are not part of the reason.
 */
function cleanFailure(reason: string | null): string | null {
  if (!reason?.trim()) return null;

  const cleaned = reason
    .replace(/\r/g, '')
    // SSH's first-contact notice rides at the front of git's stderr; it is not
    // part of why anything failed.
    .replace(/Warning: Permanently added [^\n]*? to the list of known hosts\.?\s*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned.length > MAX_FAILURE_CHARS
    ? `${cleaned.slice(0, MAX_FAILURE_CHARS)} … [shortened]`
    : cleaned;
}
