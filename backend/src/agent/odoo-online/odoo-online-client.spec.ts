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

/**
 * `createModel` (ADR-068): the sequence Studio runs, done over RPC. These tests
 * assert the shape of the calls - which model each step addresses, in what
 * order, and what it fails closed on - not what a live Odoo would compute, which
 * `ir_model.py` on this host already establishes.
 */
describe('OdooOnlineClient.createModel', () => {
  const credentials = {
    url: 'https://vania-uat123.odoo.com',
    db: 'vania-uat123',
    login: 'someone@example.com',
    apiKey: 'dummy-test-value',
  };

  interface CapturedCall {
    endpoint: string;
    service: string;
    method: string;
    args: unknown[];
  }

  const modelOf = (call: CapturedCall) => call.args[3] as string;
  const methodOf = (call: CapturedCall) => call.args[4] as string;
  const methodArgsOf = (call: CapturedCall) => call.args[5] as unknown[];

  /**
   * A responder that plays the group lookup, the "no existing model" search, the
   * model create and both view creates, in the shape createModel expects. Each
   * scripted response is consumed once, in the order calls are made.
   */
  const clientWithSequence = (
    respond: (call: CapturedCall, callIndex: number) => unknown,
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

      const value = respond(call, calls.length - 1);
      return {
        ok: true,
        json: async () => ({ result: value }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    return { client: new OdooOnlineClient(), calls };
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** The default, happy-path responder: no existing model, both groups found. */
  const happyPathResponder = (call: CapturedCall): unknown => {
    const model = modelOf(call);
    const method = methodOf(call);

    if (model === 'ir.model' && method === 'search_read') return [];
    if (model === 'ir.model.data' && method === 'search_read') {
      return [
        { name: 'group_system', res_id: 1 },
        { name: 'group_user', res_id: 2 },
      ];
    }
    if (model === 'ir.model' && method === 'create') return 900;
    if (model === 'ir.model.access' && method === 'create') return 1001 + callsSeen++;
    if (model === 'ir.ui.view' && method === 'create') return 2001 + callsSeen++;
    return null;
  };
  let callsSeen = 0;

  it('checks for an existing model first, and refuses to proceed if one exists', async () => {
    const { client, calls } = clientWithSequence((call) => {
      if (modelOf(call) === 'ir.model' && methodOf(call) === 'search_read') {
        return [{ id: 42 }];
      }
      return null;
    });

    await expect(
      client.createModel(credentials, 86, { model: 'x_servis', label: 'Servis' }),
    ).rejects.toThrow(/already exists.*id 42/i);

    // Nothing beyond the existence check was ever sent.
    expect(calls).toHaveLength(1);
    expect(modelOf(calls[0])).toBe('ir.model');
    expect(methodOf(calls[0])).toBe('search_read');
  });

  it('resolves group ids via ir.model.data with search_read only, never touching res.groups', async () => {
    callsSeen = 0;
    const { client, calls } = clientWithSequence(happyPathResponder);

    await client.createModel(credentials, 86, { model: 'x_servis', label: 'Servis' });

    const groupLookup = calls.find((call) => modelOf(call) === 'ir.model.data');
    expect(groupLookup).toBeDefined();
    expect(methodOf(groupLookup as CapturedCall)).toBe('search_read');
    const domain = methodArgsOf(groupLookup as CapturedCall)[0] as unknown[];
    expect(domain).toContainEqual(['model', '=', 'res.groups']);
    expect(domain).toContainEqual(['module', '=', 'base']);

    // res.groups is never the model a method executes against.
    for (const call of calls) {
      expect(modelOf(call)).not.toBe('res.groups');
    }
  });

  it('creates the model with x_name nested in field_id, before access or views', async () => {
    callsSeen = 0;
    const { client, calls } = clientWithSequence(happyPathResponder);

    const result = await client.createModel(credentials, 86, {
      model: 'x_servis',
      label: 'Servis',
    });

    expect(result.modelId).toBe(900);

    const modelCreate = calls.find(
      (call) => modelOf(call) === 'ir.model' && methodOf(call) === 'create',
    );
    expect(modelCreate).toBeDefined();
    const vals = methodArgsOf(modelCreate as CapturedCall)[0] as Record<string, unknown>;
    expect(vals.model).toBe('x_servis');
    expect(vals.state).toBe('manual');
    const fieldCommand = (vals.field_id as unknown[])[0] as unknown[];
    expect(fieldCommand[0]).toBe(0); // Command.create's leading tag
    expect(fieldCommand[2]).toMatchObject({ name: 'x_name', ttype: 'char', required: true });

    // The model create happens before access rows and views.
    const modelCreateIndex = calls.indexOf(modelCreate as CapturedCall);
    const accessIndex = calls.findIndex((call) => modelOf(call) === 'ir.model.access');
    const viewIndex = calls.findIndex((call) => modelOf(call) === 'ir.ui.view');
    expect(modelCreateIndex).toBeLessThan(accessIndex);
    expect(modelCreateIndex).toBeLessThan(viewIndex);
  });

  it('creates exactly two access rows, group_system with unlink and group_user without', async () => {
    callsSeen = 0;
    const { client, calls } = clientWithSequence(happyPathResponder);

    const result = await client.createModel(credentials, 86, {
      model: 'x_servis',
      label: 'Servis',
    });

    expect(result.accessIds).toHaveLength(2);
    const accessCreates = calls.filter(
      (call) => modelOf(call) === 'ir.model.access' && methodOf(call) === 'create',
    );
    expect(accessCreates).toHaveLength(2);

    const byGroup = new Map(
      accessCreates.map((call) => {
        const vals = methodArgsOf(call)[0] as Record<string, unknown>;
        return [vals.group_id, vals];
      }),
    );
    expect(byGroup.get(1)).toMatchObject({ perm_unlink: true, model_id: 900 }); // group_system
    expect(byGroup.get(2)).toMatchObject({ perm_unlink: false, model_id: 900 }); // group_user
  });

  it('creates a form view and a list view, both against the new model', async () => {
    callsSeen = 0;
    const { client, calls } = clientWithSequence(happyPathResponder);

    const result = await client.createModel(credentials, 86, {
      model: 'x_servis',
      label: 'Servis',
    });

    expect(result.formViewId).toBeGreaterThan(0);
    expect(result.listViewId).toBeGreaterThan(0);
    expect(result.formViewId).not.toBe(result.listViewId);

    const viewCreates = calls.filter(
      (call) => modelOf(call) === 'ir.ui.view' && methodOf(call) === 'create',
    );
    expect(viewCreates).toHaveLength(2);
    const types = viewCreates.map((call) => (methodArgsOf(call)[0] as Record<string, unknown>).type);
    expect(types.sort()).toEqual(['form', 'list']);
    for (const call of viewCreates) {
      const vals = methodArgsOf(call)[0] as Record<string, unknown>;
      expect(vals.model).toBe('x_servis');
    }
  });

  it('refuses when a required group cannot be found, before writing anything', async () => {
    callsSeen = 0;
    const { client, calls } = clientWithSequence((call) => {
      if (modelOf(call) === 'ir.model' && methodOf(call) === 'search_read') return [];
      if (modelOf(call) === 'ir.model.data') return [{ name: 'group_system', res_id: 1 }]; // group_user missing
      return null;
    });

    await expect(
      client.createModel(credentials, 86, { model: 'x_servis', label: 'Servis' }),
    ).rejects.toThrow(/group_user/i);

    expect(calls.every((call) => methodOf(call) !== 'create')).toBe(true);
  });

  it('reports the model id in the error if setup fails after the model row was created', async () => {
    callsSeen = 0;
    const { client } = clientWithSequence((call) => {
      const model = modelOf(call);
      const method = methodOf(call);
      if (model === 'ir.model' && method === 'search_read') return [];
      if (model === 'ir.model.data') {
        return [
          { name: 'group_system', res_id: 1 },
          { name: 'group_user', res_id: 2 },
        ];
      }
      if (model === 'ir.model' && method === 'create') return 900;
      // Every write after the model row fails.
      throw new Error('the instance rejected the access rule');
    });

    await expect(
      client.createModel(credentials, 86, { model: 'x_servis', label: 'Servis' }),
    ).rejects.toThrow(/id 900/);
  });

  it('never addresses ir.model.data with anything but a read method', async () => {
    // A backstop on the client's own gate, independent of createModel's call sites.
    callsSeen = 0;
    const { client } = clientWithSequence(() => null);

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
      ).call(credentials, 86, 'ir.model.data', 'create', [{}]),
    ).rejects.toThrow(/read-only/i);
  });
});
