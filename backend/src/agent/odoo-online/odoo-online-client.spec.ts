import { OdooOnlineClient, OdooRpcError } from './odoo-online-client';

/**
 * The Odoo Online JSON-RPC client (ADR-028).
 *
 * The property under test is the customization surface: it reaches `ir.model`,
 * `ir.model.fields` and `ir.ui.view`, and refuses every business model - the same
 * data-blind posture the rest of the platform holds, enforced here in code. The
 * transport is mocked, so the tests assert what is sent and refused rather than
 * what a live Odoo would answer.
 */
describe('OdooOnlineClient', () => {
  const credentials = {
    url: 'https://vania-uat123.odoo.com',
    db: 'vania-uat123',
    login: 'someone@example.com',
    apiKey: 'secret-key',
  };

  interface CapturedCall {
    endpoint: string;
    service: string;
    method: string;
    args: unknown[];
  }

  /** `execute_kw` args are [db, uid, key, model, method, [...method args]]. */
  const modelOf = (call: CapturedCall) => call.args[3] as string;
  const methodOf = (call: CapturedCall) => call.args[4] as string;
  const methodArgsOf = (call: CapturedCall) => call.args[5] as unknown[];

  const clientWith = (
    respond: (call: CapturedCall) => unknown | { error?: unknown } = () => null,
  ) => {
    const calls: CapturedCall[] = [];

    global.fetch = jest.fn(async (_endpoint: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        params: { service: string; method: string; args: unknown[] };
      };
      const call: CapturedCall = {
        endpoint: _endpoint,
        service: body.params.service,
        method: body.params.method,
        args: body.params.args,
      };
      calls.push(call);

      const value = respond(call);
      const isError = value !== null && typeof value === 'object' && 'error' in value;
      return {
        ok: true,
        json: async () => (isError ? value : { result: value }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    return { client: new OdooOnlineClient(), calls };
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('authenticates and returns the uid', async () => {
    const { client } = clientWith(() => 86);
    expect(await client.authenticate(credentials)).toBe(86);
  });

  it('posts to /jsonrpc on the instance root', async () => {
    const { client, calls } = clientWith(() => 86);
    await client.authenticate(credentials);

    expect(calls[0].endpoint).toBe('https://vania-uat123.odoo.com/jsonrpc');
    expect(calls[0].service).toBe('common');
    expect(calls[0].method).toBe('authenticate');
  });

  it('prefixes a custom field with x_ and creates it via ir.model.fields', async () => {
    const { client, calls } = clientWith((call) => {
      if (methodOf(call) === 'search_read') return [{ id: 604 }];
      return 28320;
    });

    const fieldId = await client.createField(credentials, 86, 'sale.order', {
      name: 'referensi',
      label: 'Referensi',
      type: 'char',
    });

    expect(fieldId).toBe(28320);

    const create = calls.find((call) => methodOf(call) === 'create');
    expect(create).toBeDefined();
    expect(modelOf(create as CapturedCall)).toBe('ir.model.fields');
    expect(methodArgsOf(create as CapturedCall)[0]).toMatchObject({
      name: 'x_referensi',
      field_description: 'Referensi',
      ttype: 'char',
      model_id: 604,
    });
  });

  it('builds an inherited view placing the field after another', async () => {
    const { client, calls } = clientWith((call) => {
      if (methodOf(call) === 'search_read') return [{ id: 1122 }];
      return 3717;
    });

    const viewId = await client.addFieldToFormView(
      credentials,
      86,
      'sale.order',
      'x_referensi',
      'payment_term_id',
    );

    expect(viewId).toBe(3717);

    const create = calls.find((call) => methodOf(call) === 'create');
    const vals = methodArgsOf(create as CapturedCall)[0] as Record<string, unknown>;
    expect(vals.arch).toBe(
      '<field name="payment_term_id" position="after"><field name="x_referensi"/></field>',
    );
    expect(vals.inherit_id).toBe(1122);
  });

  it('refuses a business model, keeping the surface customization-only', async () => {
    const { client } = clientWith(() => []);

    await expect(client.listFields(credentials, 86, 'res.partner')).rejects.toThrow(
      /not part of the customization surface/i,
    );
  });

  it('refuses a non-https instance url', async () => {
    const { client } = clientWith(() => 86);

    await expect(
      client.authenticate({ ...credentials, url: 'http://insecure.odoo.com' }),
    ).rejects.toThrow(/https/i);
  });

  it('raises an OdooRpcError for an rpc error', async () => {
    const { client } = clientWith(() => ({ error: { code: 2, data: { message: 'Access denied' } } }));

    await expect(client.authenticate(credentials)).rejects.toThrow(OdooRpcError);
    await expect(client.authenticate(credentials)).rejects.toThrow(/Access denied/);
  });
});
