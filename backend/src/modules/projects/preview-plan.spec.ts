import {
  changedPathsFromPatch,
  decidePreview,
  isPreviewRef,
  previewModules,
  remainingTtlMs,
} from './preview-plan';

/**
 * The pure parts of the preview feature (ADR-052).
 *
 * The decision is asserted by refusal as much as by success: a preview that
 * quietly builds from a truncated patch, or against a client database, is the
 * failure this feature exists to make impossible.
 */

const base = {
  enabled: true,
  executionMode: 'odoo_sh' as const,
  patchPresent: true,
  patchTruncated: false,
  hasVersion: true,
};

describe('decidePreview', () => {
  it('allows a preview when every condition holds', () => {
    expect(decidePreview(base)).toEqual({ allowed: true, reason: null });
  });

  it('refuses when the deployment has preview disabled', () => {
    const decision = decidePreview({ ...base, enabled: false });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/not enabled/i);
  });

  it('refuses an odoo_online project, which has no draft on disk', () => {
    expect(decidePreview({ ...base, executionMode: 'odoo_online' }).allowed).toBe(false);
    expect(decidePreview({ ...base, executionMode: null }).allowed).toBe(false);
  });

  it('allows a repo-backed connected project (ADR-050)', () => {
    // executionModeFor maps it to the clone-backed mode, so it is previewable.
    expect(decidePreview({ ...base, executionMode: 'odoo_sh' }).allowed).toBe(true);
  });

  it('refuses a task with no retained diff', () => {
    const decision = decidePreview({ ...base, patchPresent: false });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/no retained diff/i);
  });

  it('refuses a truncated draft rather than showing it incomplete', () => {
    const decision = decidePreview({ ...base, patchTruncated: true });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/too large/i);
  });

  it('refuses when the project has no Odoo version for a template', () => {
    const decision = decidePreview({ ...base, hasVersion: false });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/version/i);
  });
});

describe('isPreviewRef', () => {
  it('accepts only a 16-character lowercase alphanumeric token', () => {
    expect(isPreviewRef('abcdef0123456789')).toBe(true);
    for (const bad of ['', 'short', 'ABCDEF0123456789', 'abcdef01234567-9', 'abcdef012345678']) {
      expect(isPreviewRef(bad)).toBe(false);
    }
  });
});

describe('changedPathsFromPatch', () => {
  it('reads the paths a unified diff touches', () => {
    const patch = [
      'diff --git a/addons/sale_fix/models/order.py b/addons/sale_fix/models/order.py',
      'index 1111111..2222222 100644',
      '--- a/addons/sale_fix/models/order.py',
      '+++ b/addons/sale_fix/models/order.py',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/README.md b/README.md',
      'index 3333333..4444444 100644',
    ].join('\n');

    expect(changedPathsFromPatch(patch)).toEqual([
      'addons/sale_fix/models/order.py',
      'README.md',
    ]);
  });

  it('returns nothing for an empty or non-diff string', () => {
    expect(changedPathsFromPatch('')).toEqual([]);
    expect(changedPathsFromPatch('not a diff')).toEqual([]);
  });
});

describe('previewModules', () => {
  it('maps changed files to their Odoo module, skipping a leading addons/ (ADR-034)', () => {
    const patch = [
      'diff --git a/addons/sale_fix/models/order.py b/addons/sale_fix/models/order.py',
      'diff --git a/other_mod/views/x.xml b/other_mod/views/x.xml',
      'diff --git a/README.md b/README.md',
    ].join('\n');

    expect(previewModules(patch)).toEqual(['other_mod', 'sale_fix']);
  });
});

describe('remainingTtlMs', () => {
  it('counts down and never goes negative', () => {
    const expires = new Date(1_000);
    expect(remainingTtlMs(expires, 400)).toBe(600);
    expect(remainingTtlMs(expires, 1_000)).toBe(0);
    expect(remainingTtlMs(expires, 5_000)).toBe(0);
  });
});
