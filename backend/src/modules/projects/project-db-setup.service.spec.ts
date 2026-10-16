import { parseSetupReport, summarise } from './project-db-setup.service';
import { buildProjectSpecification } from './project-specification';

describe('parseSetupReport (ADR-073)', () => {
  it('reads report lines and skips anything else', () => {
    const stdout = [
      '{"item":1,"kind":"setting","label":"group_x","status":"applied","detail":"group_x"}',
      'noise from odoo-bin',
      '{"item":2,"kind":"record","label":"uom.uom m3","status":"failed","detail":"boom"}',
      '{"item":3,"status":"weird"}',
      '{not json',
    ].join('\n');
    const report = parseSetupReport(stdout);
    expect(report.map((r) => [r.item, r.status])).toEqual([
      [1, 'applied'],
      [2, 'failed'],
    ]);
  });

  it('summarises to applied, partial or failed', () => {
    const a = { item: 1, kind: 's', label: '', detail: '' };
    expect(summarise([{ ...a, status: 'applied' }, { ...a, status: 'skipped' }])).toBe('applied');
    expect(summarise([{ ...a, status: 'applied' }, { ...a, status: 'failed' }])).toBe('partial');
    expect(summarise([{ ...a, status: 'failed' }])).toBe('failed');
    expect(summarise([])).toBe('failed');
  });
});

describe('buildProjectSpecification with setup gaps (ADR-073 §6)', () => {
  it('continues the REQ sequence after brief requirements and marks gaps', () => {
    const spec = buildProjectSpecification({
      projectName: 'Kayu',
      odooVersion: '19.0',
      description: 'Produksi kayu',
      requirements: [{ title: 'Jual kayu' }],
      setupGaps: [{ title: 'Volume T×L×P otomatis', detail: 'm³ dari dimensi' }],
    });
    expect(spec.requirements).toEqual([
      { id: 'REQ-001', title: 'Jual kayu' },
      { id: 'REQ-002', title: 'Volume T×L×P otomatis', detail: 'm³ dari dimensi', kind: 'configuration_gap' },
    ]);
  });
});
