import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findGapRequirement,
  gapTaskHref,
  gapTaskPrompt,
  isConfigurationGap,
} from './gap-task';
import type { ProjectDetail, ProjectSpecification } from './types';

const specification: ProjectSpecification = {
  project_name: 'Klinik',
  framework: 'odoo',
  odoo_version: '19.0',
  description: 'A beauty clinic with two branches.',
  modules: ['point_of_sale', 'calendar'],
  requirements: [
    { id: 'REQ-001', title: 'Ordinary brief requirement', detail: 'Not a gap.' },
    {
      id: 'REQ-002',
      title: 'Therapist commission requires computed logic.',
      detail: 'Commission by service count per month.',
      kind: 'configuration_gap',
    },
  ],
  deployment: { environment: 'development' },
};

function project(overrides: Partial<ProjectDetail> = {}): Pick<
  ProjectDetail,
  'odooVersion' | 'specification' | 'dbSetup'
> {
  return {
    odooVersion: '19.0',
    specification,
    dbSetup: {
      status: 'applied',
      error: null,
      appliedAt: '2026-10-19T00:00:00.000Z',
      report: [
        { item: 1, kind: 'language', label: 'id_ID', status: 'applied', detail: 'id_ID' },
        {
          item: 2,
          kind: 'setting',
          label: 'group_product_pricelist',
          status: 'skipped',
          detail: 'already enabled',
        },
        { item: 3, kind: 'setting', label: 'group_broken', status: 'failed', detail: 'boom' },
      ],
    },
    ...overrides,
  };
}

test('isConfigurationGap is true only for a gap-kind requirement', () => {
  assert.equal(isConfigurationGap(specification.requirements[0]), false);
  assert.equal(isConfigurationGap(specification.requirements[1]), true);
});

test('gapTaskHref carries only the requirement id, never its text', () => {
  const href = gapTaskHref('proj-1', 'REQ-002');
  assert.equal(href, '/projects/proj-1/agent?requirement=REQ-002');
});

test('findGapRequirement resolves a real gap id', () => {
  const found = findGapRequirement(specification, 'REQ-002');
  assert.equal(found?.id, 'REQ-002');
});

test('findGapRequirement refuses an ordinary (non-gap) requirement', () => {
  assert.equal(findGapRequirement(specification, 'REQ-001'), null);
});

test('findGapRequirement refuses an id the specification does not have', () => {
  assert.equal(findGapRequirement(specification, 'REQ-999'), null);
});

test('findGapRequirement refuses a malformed id rather than scanning for it', () => {
  assert.equal(findGapRequirement(specification, '<script>'), null);
  assert.equal(findGapRequirement(specification, ''), null);
});

test('findGapRequirement returns null without a specification', () => {
  assert.equal(findGapRequirement(null, 'REQ-002'), null);
  assert.equal(findGapRequirement(undefined, 'REQ-002'), null);
});

test('gapTaskPrompt opens with the requirement id and title', () => {
  const prompt = gapTaskPrompt(specification.requirements[1], project());
  assert.match(prompt, /^Implement REQ-002: Therapist commission requires computed logic\./);
});

test('gapTaskPrompt includes the brief detail when present', () => {
  const prompt = gapTaskPrompt(specification.requirements[1], project());
  assert.match(prompt, /From the project brief: Commission by service count per month\./);
});

test('gapTaskPrompt omits the brief-detail line when there is none', () => {
  const { detail: _detail, ...withoutDetail } = specification.requirements[1];
  const prompt = gapTaskPrompt(withoutDetail, project());
  assert.doesNotMatch(prompt, /From the project brief/);
});

test('gapTaskPrompt lists applied and skipped setup entries as context', () => {
  const prompt = gapTaskPrompt(specification.requirements[1], project());
  // The language entry's detail equals its label ('id_ID'), so it is shown
  // once, not duplicated as 'id_ID (id_ID)'.
  assert.match(prompt, /- language: id_ID\n/);
  assert.match(prompt, /- setting: group_product_pricelist \(already enabled\)/);
});

test('gapTaskPrompt never lists a failed setup entry as configured state', () => {
  const prompt = gapTaskPrompt(specification.requirements[1], project());
  assert.doesNotMatch(prompt, /group_broken/);
});

test('gapTaskPrompt includes the Odoo version and installed modules', () => {
  const prompt = gapTaskPrompt(specification.requirements[1], project());
  assert.match(prompt, /Odoo version: 19\.0/);
  assert.match(prompt, /Installed modules: point_of_sale, calendar/);
});

test('gapTaskPrompt omits the context block entirely when there is none', () => {
  const bare = gapTaskPrompt(specification.requirements[1], {
    odooVersion: null,
    specification: { ...specification, modules: [] },
    dbSetup: undefined,
  });
  assert.doesNotMatch(bare, /Context:/);
});

test('gapTaskPrompt always closes with the build-on-existing instruction', () => {
  const prompt = gapTaskPrompt(specification.requirements[1], project());
  assert.match(
    prompt,
    /Build on the existing configuration rather than changing it\. If something in the requirement is ambiguous, state the assumption you made\.$/,
  );
});
