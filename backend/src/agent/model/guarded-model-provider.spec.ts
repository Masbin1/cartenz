import { z } from 'zod';
import { GuardedModelProvider } from './guarded-model-provider';
import { AiBoundaryService } from '../../core/ai-boundary/ai-boundary.service';
import { AiBoundaryRefusalError } from '../../core/ai-boundary/boundary-types';
import type {
  ModelProvider,
  ModelResult,
  StructuredRequest,
  ToolLoopOutcome,
  ToolLoopRequest,
} from './model-provider.interface';

/**
 * The guard is what makes the AI data boundary unavoidable (ADR-020), so these
 * tests assert on what the inner provider actually *received* - a guard that
 * filtered nothing would pass a test that only checked the return value.
 *
 * A recording double stands in for the provider: what reached it is the evidence.
 */
class RecordingProvider implements ModelProvider {
  readonly id = 'recording';
  readonly model = 'test-model';
  readonly callsExternalService = true;

  systemReceived = '';
  partsReceived: { label: string; content: string }[] = [];
  toolResultsReceived: Record<string, unknown>[] = [];
  /** What the loop should return as the model's closing text. */
  summaryToReturn = 'done';
  /** Tool calls the loop should make, in order. */
  scriptedCalls: { name: string; args: Record<string, unknown> }[] = [];

  async generateStructured<T>(request: StructuredRequest<T>): Promise<ModelResult<T>> {
    this.systemReceived = request.system;
    this.partsReceived = request.parts.map((part) => ({
      label: part.label,
      content: part.content,
    }));

    return {
      value: request.schema.parse(this.structuredToReturn),
      usage: { inputTokens: 10, outputTokens: 5, durationMs: 1 },
      boundaryFindings: [],
      redactionCount: 0,
      steps: 1,
    };
  }

  /** Set by a test to control the structured value produced. */
  structuredToReturn: unknown = {};

  async runToolLoop(request: ToolLoopRequest): Promise<ModelResult<ToolLoopOutcome>> {
    this.systemReceived = request.system;
    this.partsReceived = request.parts.map((part) => ({
      label: part.label,
      content: part.content,
    }));

    let halted: string | undefined;
    let calls = 0;

    for (const call of this.scriptedCalls) {
      const outcome = await request.execute(call.name, call.args);
      this.toolResultsReceived.push(outcome.result);
      calls += 1;
      if (outcome.halt) {
        halted = outcome.haltReason;
        break;
      }
    }

    return {
      value: { summary: this.summaryToReturn, toolCalls: calls, haltReason: halted },
      usage: { inputTokens: 20, outputTokens: 8, durationMs: 2 },
      boundaryFindings: [],
      redactionCount: 0,
      steps: calls,
    };
  }
}

describe('GuardedModelProvider', () => {
  const boundary = new AiBoundaryService();
  let inner: RecordingProvider;
  let guarded: GuardedModelProvider;

  beforeEach(() => {
    inner = new RecordingProvider();
    guarded = new GuardedModelProvider(inner, boundary);
  });

  it('passes the inner provider identity through', () => {
    expect(guarded.id).toBe('recording');
    expect(guarded.model).toBe('test-model');
    expect(guarded.callsExternalService).toBe(true);
  });

  describe('outbound filtering', () => {
    const schema = z.object({ answer: z.string() });

    it('removes a secret from a prompt part before the provider sees it', async () => {
      inner.structuredToReturn = { answer: 'ok' };

      await guarded.generateStructured({
        system: 'You are an agent.',
        parts: [
          { label: 'File: settings.py', content: 'TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"' },
        ],
        schema,
        schemaName: 'Answer',
      });

      // The evidence: what the provider received, not what was returned.
      expect(inner.partsReceived[0].content).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
      expect(inner.partsReceived[0].content).toContain('redacted');
    });

    it('filters the system prompt too', async () => {
      inner.structuredToReturn = { answer: 'ok' };

      await guarded.generateStructured({
        system: 'You are an agent. Use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz01.',
        parts: [{ label: 'Request', content: 'Add a field' }],
        schema,
        schemaName: 'Answer',
      });

      expect(inner.systemReceived).not.toContain('sk-ant-api03');
    });

    it('refuses the whole call when a part contains customer data', async () => {
      const dump = ['-- PostgreSQL database dump', 'COPY public.res_partner (id) FROM stdin;'].join('\n');

      await expect(
        guarded.generateStructured({
          system: 'You are an agent.',
          parts: [{ label: 'File: export.sql', content: dump }],
          schema,
          schemaName: 'Answer',
        }),
      ).rejects.toThrow(AiBoundaryRefusalError);

      // Nothing reached the provider at all.
      expect(inner.partsReceived).toHaveLength(0);
    });

    it('leaves ordinary source unchanged, so the model gets full context', async () => {
      inner.structuredToReturn = { answer: 'ok' };
      const source = "class SaleOrder(models.Model):\n    _inherit = 'sale.order'\n";

      await guarded.generateStructured({
        system: 'You are an agent.',
        parts: [{ label: 'File: sale_order.py', content: source }],
        schema,
        schemaName: 'Answer',
      });

      expect(inner.partsReceived[0].content).toBe(source);
    });
  });

  describe('inbound filtering', () => {
    it('removes a secret the model repeated in a structured field', async () => {
      const schema = z.object({ summary: z.string() });
      inner.structuredToReturn = {
        summary: 'I used the token ghp_abcdefghijklmnopqrstuvwxyz0123456789 from settings.py.',
      };

      const result = await guarded.generateStructured({
        system: 'You are an agent.',
        parts: [{ label: 'Request', content: 'Add a field' }],
        schema,
        schemaName: 'Answer',
      });

      // The output reaches the action log, the event stream and a browser.
      expect(result.value.summary).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
      expect(result.redactionCount).toBeGreaterThan(0);
    });

    it('removes a secret the model repeated in its loop summary', async () => {
      inner.summaryToReturn = 'Found sk-ant-api03-abcdefghijklmnopqrstuvwxyz01 in the config.';

      const result = await guarded.runToolLoop({
        system: 'You are an agent.',
        parts: [{ label: 'Request', content: 'Add a field' }],
        tools: [],
        execute: async () => ({ result: {} }),
        maxSteps: 4,
        maxToolCalls: 4,
      });

      expect(result.value.summary).not.toContain('sk-ant-api03');
    });
  });

  describe('tool results', () => {
    it('filters a tool result before the model sees it', async () => {
      // read_file returns repository content straight into the model's context.
      // It is the one place the platform hands over material it has not inspected.
      inner.scriptedCalls = [{ name: 'read_file', args: { path: 'settings.py' } }];

      await guarded.runToolLoop({
        system: 'You are an agent.',
        parts: [{ label: 'Request', content: 'Read the settings' }],
        tools: [],
        execute: async () => ({
          result: { content: 'SECRET_KEY = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"' },
        }),
        maxSteps: 4,
        maxToolCalls: 4,
      });

      const seen = JSON.stringify(inner.toolResultsReceived);
      expect(seen).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    });

    it('withholds a tool result that is customer data, without halting the task', async () => {
      inner.scriptedCalls = [{ name: 'read_file', args: { path: 'data/customers.csv' } }];

      const csv = [
        'first_name,last_name,email,phone,vat',
        'Thandi,Mokoena,t.m@acme.test,011 555 0001,4123456789',
        'Sipho,Ndlovu,s.n@acme.test,011 555 0002,4123456790',
        'Anna,Botha,a.b@acme.test,011 555 0003,4123456791',
        'Johan,Smit,j.s@acme.test,011 555 0004,4123456792',
        'Lerato,Dube,l.d@acme.test,011 555 0005,4123456793',
      ].join('\n');

      await guarded.runToolLoop({
        system: 'You are an agent.',
        parts: [{ label: 'Request', content: 'Read the data' }],
        tools: [],
        execute: async () => ({ result: { content: csv } }),
        maxSteps: 4,
        maxToolCalls: 4,
      });

      const seen = inner.toolResultsReceived[0];
      expect(seen.withheld).toBe(true);
      // Halting here would let repository content decide whether the task runs.
      expect(seen.reason).toContain('AI data boundary');
      expect(JSON.stringify(seen)).not.toContain('Mokoena');
    });

    it('passes an ordinary tool result through unchanged', async () => {
      inner.scriptedCalls = [{ name: 'list_modules', args: {} }];

      await guarded.runToolLoop({
        system: 'You are an agent.',
        parts: [{ label: 'Request', content: 'List modules' }],
        tools: [],
        execute: async () => ({ result: { modules: ['omnisurge_sale'], moduleCount: 1 } }),
        maxSteps: 4,
        maxToolCalls: 4,
      });

      expect(inner.toolResultsReceived[0]).toEqual({
        modules: ['omnisurge_sale'],
        moduleCount: 1,
      });
    });

    it('propagates a halt from the platform', async () => {
      inner.scriptedCalls = [
        { name: 'delete_file', args: { path: 'a.py' } },
        { name: 'read_file', args: { path: 'b.py' } },
      ];

      const result = await guarded.runToolLoop({
        system: 'You are an agent.',
        parts: [{ label: 'Request', content: 'Delete a file' }],
        tools: [],
        execute: async (name) =>
          name === 'delete_file'
            ? { result: { status: 'approval_required' }, halt: true, haltReason: 'needs approval' }
            : { result: {} },
        maxSteps: 4,
        maxToolCalls: 4,
      });

      // The second call never happened.
      expect(inner.toolResultsReceived).toHaveLength(1);
      expect(result.value.haltReason).toBe('needs approval');
    });
  });

  describe('accounting', () => {
    it('reports what it removed, in both directions', async () => {
      const schema = z.object({ summary: z.string() });
      inner.structuredToReturn = { summary: 'Used ghp_zyxwvutsrqponmlkjihgfedcba9876543210.' };

      const result = await guarded.generateStructured({
        system: 'You are an agent.',
        parts: [{ label: 'File: a.py', content: 'K = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz01"' }],
        schema,
        schemaName: 'Answer',
      });

      // One outbound, one inbound.
      expect(result.redactionCount).toBe(2);
      expect(result.boundaryFindings.map((finding) => finding.rule).sort()).toEqual([
        'anthropic_api_key',
        'github_token',
      ]);
    });
  });
});
