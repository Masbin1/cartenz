import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RealRepositoryTools } from './repository.tools';
import { REDACTIONS } from '../../../core/ai-boundary/boundary-types';
import type { AppConfig } from '../../../core/config/configuration';
import type { ToolExecutionContext } from '../tool.interface';

/**
 * The write guard (ADR-020).
 *
 * This defends against a hazard that only appears once a model is in the loop, and
 * one that inverts the boundary's purpose if it is missed.
 *
 * The AI data boundary removes a credential from a file before the model sees it.
 * The write tools replace a file entirely. So a model that reads such a file and
 * writes it back writes back the *redaction* - silently deleting the customer's
 * real credential. The control meant to protect the customer would be destroying
 * their code.
 *
 * It was found in end-to-end verification, not by reasoning, which is why the test
 * uses a real filesystem: the property is that the file on disk is left alone.
 */
describe('repository write guard', () => {
  let repository: string;
  let tools: RealRepositoryTools;
  let context: ToolExecutionContext;

  const config = {
    limits: { searchMaxResults: 60, searchMaxFileBytes: 1024 * 1024, readFileMaxBytes: 262144 },
  } as AppConfig;

  const original = [
    'from odoo import fields, models',
    '',
    'COURIER_API_KEY = "ghp_realcredentialabcdefghijklmnop"',
    '',
    'class SaleOrder(models.Model):',
    "    _inherit = 'sale.order'",
    '',
  ].join('\n');

  beforeEach(async () => {
    repository = await mkdtemp(join(tmpdir(), 'linkederp-write-'));
    await mkdir(join(repository, 'models'), { recursive: true });
    await writeFile(join(repository, 'models', 'sale_order.py'), original, 'utf8');

    tools = new RealRepositoryTools(config);
    context = {
      taskId: 'task-1',
      taskReference: 'task_1',
      projectId: 'project-1',
      organizationId: 'org-1',
      workspace: {
        workspaceId: 'ws-1',
        repositoryPath: repository,
        branch: 'ai/task_1-test',
        baseBranch: 'main',
        baseCommit: 'abc',
        repositoryUrl: 'https://example.test/repo.git',
        odooVersion: '18.0',
        simulated: false,
      },
    };
  });

  afterEach(async () => {
    await rm(repository, { recursive: true, force: true });
  });

  const toolNamed = (name: string) => {
    const tool = tools.definitions.find((definition) => definition.name === name);
    if (!tool) throw new Error(`${name} is not registered`);
    return tool;
  };

  it('refuses an update whose content carries a redaction marker', async () => {
    const redacted = original.replace(
      '"ghp_realcredentialabcdefghijklmnop"',
      REDACTIONS.secret,
    );

    await expect(
      toolNamed('update_file').execute(
        { path: 'models/sale_order.py', content: redacted, summary: 'Add a field' },
        context,
      ),
    ).rejects.toThrow(/Refused to write/);

    // The property that matters: the real credential is still on disk.
    const onDisk = await readFile(join(repository, 'models', 'sale_order.py'), 'utf8');
    expect(onDisk).toBe(original);
    expect(onDisk).toContain('ghp_realcredentialabcdefghijklmnop');
  });

  it('refuses a create whose content carries a redaction marker', async () => {
    await expect(
      toolNamed('create_file').execute(
        {
          path: 'models/new_model.py',
          content: `EMAIL = "${REDACTIONS.pii}"\n`,
          summary: 'Add a model',
        },
        context,
      ),
    ).rejects.toThrow(/Refused to write/);
  });

  it('refuses each kind of redaction marker', async () => {
    for (const marker of Object.values(REDACTIONS)) {
      await expect(
        toolNamed('update_file').execute(
          { path: 'models/sale_order.py', content: `X = "${marker}"\n`, summary: 'Change' },
          context,
        ),
      ).rejects.toThrow(/Refused to write/);
    }
  });

  it('explains what the operator should do about it', async () => {
    // A refusal the reader cannot act on is only marginally better than silent
    // corruption.
    await expect(
      toolNamed('update_file').execute(
        { path: 'models/sale_order.py', content: REDACTIONS.secret, summary: 'Change' },
        context,
      ),
    ).rejects.toThrow(/remove the credential from the repository/);
  });

  it('allows an ordinary write', async () => {
    const updated = `${original}\n# A new comment\n`;

    const result = (await toolNamed('update_file').execute(
      { path: 'models/sale_order.py', content: updated, summary: 'Add a comment' },
      context,
    )) as { change: string };

    expect(result.change).toBe('modified');
    expect(await readFile(join(repository, 'models', 'sale_order.py'), 'utf8')).toBe(updated);
  });
});
