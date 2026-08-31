import { buildProjectSpecification } from './project-specification';

describe('buildProjectSpecification', () => {
  const input = {
    projectName: 'Equipment Management',
    odooVersion: '18.0' as const,
    description: 'Manage employee equipment',
    requirements: [
      { title: 'Register equipment against an employee' },
      { title: 'Record returns', detail: 'With a condition note' },
    ],
  };

  it('produces the documented specification shape', () => {
    const specification = buildProjectSpecification(input);

    expect(specification).toEqual({
      project_name: 'Equipment Management',
      framework: 'Odoo',
      odoo_version: '18',
      description: 'Manage employee equipment',
      modules: [],
      requirements: [
        { id: 'REQ-001', title: 'Register equipment against an employee' },
        { id: 'REQ-002', title: 'Record returns', detail: 'With a condition note' },
      ],
      deployment: { environment: 'development' },
    });
  });

  it('always targets development', () => {
    // A newly specified project must never be one approval away from production.
    expect(buildProjectSpecification(input).deployment.environment).toBe('development');
  });

  it('numbers requirements from one, zero-padded', () => {
    const many = buildProjectSpecification({
      ...input,
      requirements: Array.from({ length: 11 }, (_, index) => ({ title: `Requirement ${index}` })),
    });

    expect(many.requirements[0].id).toBe('REQ-001');
    expect(many.requirements[9].id).toBe('REQ-010');
    expect(many.requirements[10].id).toBe('REQ-011');
  });

  it('omits detail when none was supplied', () => {
    const specification = buildProjectSpecification({
      ...input,
      requirements: [{ title: 'No detail here' }],
    });
    expect(specification.requirements[0]).not.toHaveProperty('detail');
  });

  it('accepts an empty requirement list', () => {
    const specification = buildProjectSpecification({ ...input, requirements: [] });
    expect(specification.requirements).toEqual([]);
  });

  it('rejects an unsupported Odoo version', () => {
    expect(() =>
      buildProjectSpecification({
        ...input,
        odooVersion: '13.0' as unknown as typeof input.odooVersion,
      }),
    ).toThrow('Unsupported Odoo version');
  });
});
