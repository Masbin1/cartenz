'use client';

import type { EnvironmentKind } from '@/lib/types';

export interface EnvironmentDraft {
  name: string;
  branch: string;
  kind: EnvironmentKind;
}

const KINDS: { value: EnvironmentKind; label: string }[] = [
  { value: 'production', label: 'Production' },
  { value: 'staging', label: 'Staging' },
  { value: 'development', label: 'Development' },
];

/**
 * Seeds the three environments an Odoo.sh project normally has. Production is
 * included because a project that hides its production branch does not stop it
 * existing - naming it is what lets the platform refuse to touch it.
 *
 * The staging and development branches were once guessed as `staging` and
 * `development`. Git refs are case-sensitive, so against a repository whose
 * branch is `Staging` the guess produced a project that failed at clone time,
 * minutes later, with an error about a missing branch rather than about the
 * name. When `branches` is supplied the seed matches against what the
 * repository actually has, and leaves a row blank rather than inventing a name.
 */
export function defaultEnvironments(
  defaultBranch: string,
  branches: readonly string[],
): EnvironmentDraft[] {
  // Matched without case so `Staging` is found for `staging`, but the
  // repository's own spelling is what gets stored. No match leaves the row
  // blank: an empty row is dropped on submit, a wrong one fails at clone time.
  const asDeclared = (wanted: string) =>
    branches.find((branch) => branch.toLowerCase() === wanted.toLowerCase()) ?? '';

  // Production follows the default branch, which was named rather than guessed.
  return [
    { name: 'production', branch: defaultBranch.trim() || 'main', kind: 'production' },
    { name: 'staging', branch: asDeclared('staging'), kind: 'staging' },
    { name: 'development', branch: asDeclared('development'), kind: 'development' },
  ];
}

interface Props {
  value: EnvironmentDraft[];
  onChange: (next: EnvironmentDraft[]) => void;
  disabled?: boolean;
  /**
   * The branches the repository advertises. Undefined means they have not been
   * read, and the branch stays a text field - a repository the platform cannot
   * reach must not become a project nobody can create.
   */
  branches?: readonly string[];
}

/**
 * Declares the branches a project has and what each one is (ADR-021).
 *
 * The kind is not decoration. A task can be pointed at a staging or development
 * environment; one marked production is refused, because on Odoo.sh that branch
 * is the live business.
 */
export function EnvironmentEditor({ value, onChange, disabled = false, branches }: Props) {
  const set = (index: number, patch: Partial<EnvironmentDraft>) =>
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const add = () => onChange([...value, { name: '', branch: '', kind: 'development' }]);
  const remove = (index: number) => onChange(value.filter((_, i) => i !== index));

  const targetable = value.filter((row) => row.kind !== 'production');

  return (
    // Full width of the form grid: three fields and a remove button squeezed
    // into a half-width column left every input too narrow to read its value.
    <div className="space-y-3 sm:col-span-2">
      <div>
        <span className="field-label">Environments</span>
        <p className="mt-1.5 text-2xs text-content-subtle">
          On Odoo.sh an environment is a branch. Tasks run against staging and development
          environments; one marked production is refused.
        </p>
        {branches ? (
          <p className="mt-1 text-2xs text-content-subtle">
            {branches.length} branch{branches.length === 1 ? '' : 'es'} read from the repository.
          </p>
        ) : (
          <p className="mt-1 text-2xs text-state-waiting">
            Read the branches above to pick from what the repository has. Branch names are
            case-sensitive, so a typed one may not exist.
          </p>
        )}
      </div>

      <div className="space-y-2">
        {value.map((row, index) => (
          // Each environment is a card, and every field carries its own label:
          // a bare row of three boxes gave no clue which one was the branch.
          <div
            key={index}
            className="rounded-md border border-surface-border bg-surface-overlay/60 p-3
              grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_11rem_auto] sm:items-end"
          >
            <label className="block min-w-0">
              <span className="mb-1 block text-2xs text-content-subtle">Name</span>
              <input
                aria-label={`Environment ${index + 1} name`}
                placeholder="staging"
                value={row.name}
                onChange={(event) => set(index, { name: event.target.value })}
                disabled={disabled}
                className="field-input"
              />
            </label>

            <label className="block min-w-0">
              <span className="mb-1 block text-2xs text-content-subtle">Branch</span>
              {branches ? (
                <select
                  aria-label={`Environment ${index + 1} branch`}
                  value={row.branch}
                  onChange={(event) => set(index, { branch: event.target.value })}
                  disabled={disabled}
                  className="field-input font-mono text-xs"
                >
                  <option value="">Pick a branch</option>
                  {branches.map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
                  {/* A branch already declared but no longer on the remote would
                      otherwise vanish from the row without anyone noticing. */}
                  {row.branch && !branches.includes(row.branch) ? (
                    <option value={row.branch}>{row.branch} (not on the remote)</option>
                  ) : null}
                </select>
              ) : (
                <input
                  aria-label={`Environment ${index + 1} branch`}
                  placeholder="staging"
                  value={row.branch}
                  onChange={(event) => set(index, { branch: event.target.value })}
                  disabled={disabled}
                  className="field-input font-mono text-xs"
                />
              )}
            </label>

            <label className="block min-w-0">
              <span className="mb-1 block text-2xs text-content-subtle">Type</span>
              <select
                aria-label={`Environment ${index + 1} kind`}
                value={row.kind}
                onChange={(event) => set(index, { kind: event.target.value as EnvironmentKind })}
                disabled={disabled}
                className="field-input"
              >
                {KINDS.map((kind) => (
                  <option key={kind.value} value={kind.value}>
                    {kind.label}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              onClick={() => remove(index)}
              disabled={disabled || value.length <= 1}
              className="h-[38px] rounded-md border border-surface-border px-3 text-2xs
                text-content-subtle hover:border-state-failure/40 hover:text-state-failure
                disabled:opacity-40 disabled:hover:border-surface-border
                disabled:hover:text-content-subtle"
              aria-label={`Remove environment ${index + 1}`}
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={add}
        disabled={disabled}
        className="rounded-md border border-dashed border-surface-border px-3 py-2 text-xs
          font-medium text-content-muted hover:border-accent hover:text-accent
          disabled:opacity-40"
      >
        + Add environment
      </button>

      {targetable.length === 0 ? (
        <p className="text-2xs text-state-waiting">
          Every environment here is production, so no task could run. Add a staging or
          development environment.
        </p>
      ) : null}
    </div>
  );
}

export function EnvironmentKindBadge({ kind }: { kind: EnvironmentKind }) {
  const tone =
    kind === 'production'
      ? 'border-state-failure/40 text-state-failure'
      : kind === 'staging'
        ? 'border-warning/40 text-state-waiting'
        : 'border-surface-border text-content-subtle';

  return (
    <span className={`rounded border px-1.5 py-0.5 text-2xs uppercase tracking-wide ${tone}`}>
      {kind}
    </span>
  );
}
