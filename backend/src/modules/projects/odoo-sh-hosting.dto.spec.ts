import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateAiProjectDto } from './dto/project.dto';

/** The Odoo.sh hosting additions to the Create-with-AI payload (ADR-071). */
const base = {
  region: 'indonesia',
  name: 'Equipment Management',
  odooVersion: '19.0',
  description: 'Manage company assets.',
  requirements: [{ title: 'Register equipment against an employee' }],
};

const build = (odooSh: Record<string, unknown> | undefined) =>
  plainToInstance(CreateAiProjectDto, { ...base, hosting: 'odoo_sh', odooSh });

const odooShInvalid = async (odooSh: Record<string, unknown>) =>
  (await validate(build(odooSh))).some((error) => error.property === 'odooSh');

describe('CreateAiProjectDto odoo_sh hosting', () => {
  const valid = { owner: 'BintangLinked', repositoryName: 'equipment-management', region: 'as' };

  it('accepts an odoo_sh project with a complete plan', async () => {
    expect(await validate(build(valid))).toHaveLength(0);
  });

  it.each([
    ['owner with a slash', { ...valid, owner: 'Bintang/Linked' }],
    ['owner with a leading hyphen', { ...valid, owner: '-bintang' }],
    ['repository name with a space', { ...valid, repositoryName: 'equipment management' }],
    ['repository name with a leading dot', { ...valid, repositoryName: '.equipment' }],
    ['unknown region', { ...valid, region: 'id' }],
  ])('refuses an %s', async (_label, odooSh) => {
    expect(await odooShInvalid(odooSh)).toBe(true);
  });
});
