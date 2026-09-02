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

  /**
   * The data-blind posture, restated after the read route changed.
   *
   * `listFields` used to call `fields_get` on the model itself, which the
   * allow-list refused - so the tool could not answer the one question it exists
   * for. It now reads the same schema from `ir.model.fields`, which means the
   * *subject* of the read may be a business model while the model actually
   * addressed over RPC is not. That distinction is the whole property, so it is
   * asserted directly rather than through the refusal it used to produce.
   */
  it('reads a business model\'s schema without ever addressing it over RPC', async () => {
    const { client, calls } = clientWith(() => [
      { name: 'email', field_description: 'Email', ttype: 'char', required: false, state: 'base' },
    ]);

    const fields = await client.listFields(credentials, 86, 'res.partner');
    expect(fields).toEqual([
      { name: 'email', label: 'Email', type: 'char', required: false, manual: false },
    ]);

    // Every model addressed is a customization model. res.partner appears only
    // inside a domain, as the subject of a metadata query - never as the model a
    // method is executed against, which is what would reach its records.
    for (const call of calls) {
      expect(['ir.model', 'ir.model.fields', 'ir.ui.view']).toContain(modelOf(call));
    }
  });

  it('still refuses a business model reached directly, as a backstop', async () => {
    const { client } = clientWith(() => []);

    // No public method routes here any more; the allow-list stays because it is
    // what makes a future method that gets it wrong fail closed rather than read
    // records.
    await expect(
      (
        client as unknown as {
          call: (
            c: typeof credentials,
            uid: number,
            model: string,
            method: string,
            args: unknown[],
          ) => Promise<unknown>;
        }
      ).call(credentials, 86, 'res.partner', 'search_read', [[]]),
    ).rejects.toThrow(/not part of the customization surface/i);
  });

  /**
   * The shape of a real defect: `{fields, limit}` passed as a positional argument
   * became `search_read`'s `fields` parameter, and every call against a live Odoo
   * 19 failed with `Invalid field 'fields' on 'ir.ui.view'`. kwargs travel as the
   * seventh element of the RPC args, never inside the positional array.
   */
  it('sends kwargs as the seventh rpc argument, not inside the positional args', async () => {
    const { client, calls } = clientWith(() => [{ id: 1122 }]);
    await client.baseFormViewId(credentials, 86, 'sale.order');

    const [call] = calls;
    const positional = methodArgsOf(call);
    expect(positional).toHaveLength(1);
    expect(positional[0]).toEqual([
      ['model', '=', 'sale.order'],
      ['type', '=', 'form'],
      ['inherit_id', '=', false],
    ]);
    expect(call.args[6]).toEqual({ fields: ['id'], limit: 1 });
  });

  /**
   * What people copy out of the browser is the web client, not the instance root.
   * Posting JSON-RPC under it reaches the web controller, which answers
   * "400 Session expired (invalid CSRF token)" - an error naming nothing the user
   * did wrong. Verified against a live instance in both forms.
   */
  it('strips the /odoo web-client suffix from a pasted url', async () => {
    const { client, calls } = clientWith(() => 86);
    await client.authenticate({ ...credentials, url: 'https://vania-uat123.odoo.com/odoo' });

    expect(calls[0].endpoint).toBe('https://vania-uat123.odoo.com/jsonrpc');
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
