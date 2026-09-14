import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { AiSdkModelProvider } from './ai-sdk-model-provider';
import type { AppConfig } from '../../core/config/configuration';

/**
 * What an endpoint that cannot enforce a schema is sent, and what it may answer
 * with (ADR-023).
 *
 * Written after a plan failed against a chain of DeepSeek and an agent-backed
 * Hermes endpoint. Two separate faults, both invisible from the portal:
 *
 * - The planning prompt never contained the word "json", which DeepSeek requires
 *   before it will accept `response_format: json_object`. It answered HTTP 400,
 *   and a 400 ends the chain rather than failing over, so the task died there.
 * - The tool loop was sent in `json_object` mode as well, which is neither what
 *   it asks for nor something that prompt could ever satisfy.
 *
 * These assert against a real HTTP server rather than a mocked SDK, because what
 * broke was the request body on the wire, which a mock would have been free to
 * agree with.
 */

const schema = z.object({ summary: z.string(), steps: z.array(z.string()) });

const config = {
  ai: {
    temperature: 0,
    maxOutputTokens: 512,
    requestTimeoutMs: 10000,
    structuredOutputs: false,
  },
} as unknown as AppConfig;

describe('an endpoint configured without structured outputs', () => {
  let server: Server;
  let baseUrl: string;
  let received: Record<string, unknown>[] = [];
  let reply = 'the model answered';

  beforeEach(async () => {
    received = [];
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 0,
            model: 'test-model',
            choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const build = () =>
    new AiSdkModelProvider(config, {
      provider: 'openai-compatible',
      baseUrl,
      model: 'test-model',
      apiKey: 'k',
      structuredOutputs: false,
    });

  const generate = () =>
    build().generateStructured({
      system: 'You are the LinkedERP AI Development Agent.',
      parts: [{ label: 'Development request', content: 'Add a field.' }],
      schema,
      schemaName: 'ImplementationPlan',
    });

  it('says the word "json" in the prompt, which is what DeepSeek requires', async () => {
    reply = JSON.stringify({ summary: 'done', steps: ['one'] });

    await generate();

    const sent = JSON.stringify(received[0].messages);
    expect(sent.toLowerCase()).toContain('json');
  });

  it('states the schema, which no longer reaches an endpoint in this mode', async () => {
    reply = JSON.stringify({ summary: 'done', steps: ['one'] });

    await generate();

    const sent = JSON.stringify(received[0].messages);
    expect(sent).toContain('ImplementationPlan');
    expect(sent).toContain('summary');
  });

  /**
   * An agent-backed endpoint introduces its answer and offers to continue, either
   * side of the object it was asked for. The object is still the answer, and the
   * schema is validated against it afterwards.
   */
  it('recovers the object from an answer that is wrapped in prose', async () => {
    reply = [
      'Here is the plan:',
      '```json',
      JSON.stringify({ summary: 'done', steps: ['one { two }'] }),
      '```',
      'Want me to start on it?',
    ].join('\n');

    const result = await generate();

    expect(result.value).toEqual({ summary: 'done', steps: ['one { two }'] });
  });

  it('leaves the tool loop out of JSON mode, which it can never satisfy', async () => {
    reply = 'I have finished.';

    await build().runToolLoop({
      system: 'You are the LinkedERP AI Development Agent.',
      parts: [{ label: 'Development request', content: 'Add a field.' }],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file.',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
      execute: async () => ({ result: {} }),
      maxSteps: 1,
      maxToolCalls: 1,
    });

    expect(received[0].response_format).toBeUndefined();
  });

  it('asks for JSON when the plan is what is wanted', async () => {
    reply = JSON.stringify({ summary: 'done', steps: ['one'] });

    await generate();

    expect(received[0].response_format).toEqual({ type: 'json_object' });
  });
});
