import { Injectable, Logger } from '@nestjs/common';

/**
 * The Odoo Online execution surface (ADR-028): no filesystem, no Git, no clone.
 *
 * Customization happens through the Odoo JSON-RPC API, driven with the project's
 * credentials (URL, database, login and API key). This is the same mechanism Odoo
 * Studio uses under the hood - `ir.model.fields` for schema and `ir.ui.view` for
 * the form - and it was verified against a live Odoo Online instance rather than
 * assumed: the API key authenticates and creates fields and inherited views.
 *
 * The client exposes only the customization surface. Business records
 * (`res.partner`, `sale.order` rows and so on) are never read or written here;
 * the model allow-list below is what enforces the data-blind posture for this
 * mode, in code rather than by prompt.
 */

/** The JSON-RPC models the client may touch. Customization metadata only. */
const CUSTOMIZATION_MODELS = new Set([
  'ir.model',
  'ir.model.fields',
  'ir.ui.view',
]);

export interface OdooOnlineCredentials {
  /** Instance root, e.g. `https://vania-uat123.odoo.com`. Must be https. */
  readonly url: string;
  readonly db: string;
  readonly login: string;
  /** The API key, used as the RPC password. A secret, never logged. */
  readonly apiKey: string;
}

/** A JSON-RPC failure, with the message the operator or model can act on. */
export class OdooRpcError extends Error {
  constructor(
    readonly detail: string,
    readonly code?: number | string,
  ) {
    super(detail);
    this.name = 'OdooRpcError';
  }
}

/** A field as the model sees it, narrowed to what a customization needs. */
export interface OdooFieldInfo {
  readonly name: string;
  readonly label: string;
  readonly type: string;
  readonly required: boolean;
  readonly manual: boolean;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number | string; message?: string; data?: { message?: string } };
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The Odoo Online JSON-RPC client.
 *
 * Uses the global fetch of Node 20. The API key travels only inside the request
 * body to the configured instance; it is never written to a log. Every call to a
 * model outside the customization allow-list is refused before it leaves the
 * platform.
 */
@Injectable()
export class OdooOnlineClient {
  private readonly logger = new Logger(OdooOnlineClient.name);

  /** Authenticates and returns the user id (uid). */
  async authenticate(credentials: OdooOnlineCredentials): Promise<number> {
    const result = await this.request(credentials, 'common', 'authenticate', [
      credentials.db,
      credentials.login,
      credentials.apiKey,
      { user_agent: 'cartenz-odoo-online' },
    ]);

    if (typeof result !== 'number') {
      throw new OdooRpcError('authenticate returned no user id');
    }
    return result;
  }

  /** Fields of a model, as name -> label/type/etc, for the model to plan against. */
  async listFields(
    credentials: OdooOnlineCredentials,
    uid: number,
    model: string,
  ): Promise<OdooFieldInfo[]> {
    const fields = await this.call(credentials, uid, model, 'fields_get', []);
    const record = fields as Record<string, Record<string, unknown>>;

    return Object.entries(record)
      .map(([name, field]) => ({
        name,
        label: String(field.string ?? name),
        type: String(field.type ?? 'unknown'),
        required: field.required === true,
        manual: field.manual === true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The id of a model by its technical name, e.g. `sale.order`. */
  async modelId(credentials: OdooOnlineCredentials, uid: number, model: string): Promise<number> {
    const rows = (await this.call(credentials, uid, 'ir.model', 'search_read', [
      [['model', '=', model]],
      { fields: ['id'], limit: 1 },
    ])) as { id: number }[];

    if (rows.length === 0) {
      throw new OdooRpcError(`No model named "${model}" was found`);
    }
    return rows[0].id;
  }

  /** Models whose technical name matches a fragment, for the model to discover. */
  async listModels(
    credentials: OdooOnlineCredentials,
    uid: number,
    query?: string,
  ): Promise<{ name: string; model: string }[]> {
    const domain = query ? [['model', 'ilike', query]] : [];
    const rows = (await this.call(credentials, uid, 'ir.model', 'search_read', [
      domain,
      { fields: ['name', 'model'], limit: 200 },
    ])) as { name: string; model: string }[];

    return rows
      .map((row) => ({ name: row.name, model: row.model }))
      .sort((a, b) => a.model.localeCompare(b.model));
  }

  /** Creates a custom field on a model, Studio-style (`x_` prefix, `manual`). */
  async createField(
    credentials: OdooOnlineCredentials,
    uid: number,
    model: string,
    values: { name: string; label: string; type: string; required?: boolean },
  ): Promise<number> {
    const modelId = await this.modelId(credentials, uid, model);
    const name = values.name.startsWith('x_') ? values.name : `x_${values.name}`;

    return (await this.call(credentials, uid, 'ir.model.fields', 'create', [
      {
        name,
        field_description: values.label,
        ttype: values.type,
        required: values.required ?? false,
        model_id: modelId,
      },
    ])) as number;
  }

  /** The base form view of a model (the one Studio inherits from). */
  async baseFormViewId(
    credentials: OdooOnlineCredentials,
    uid: number,
    model: string,
  ): Promise<number> {
    const views = (await this.call(credentials, uid, 'ir.ui.view', 'search_read', [
      [['model', '=', model], ['type', '=', 'form'], ['inherit_id', '=', false]],
      { fields: ['id'], limit: 1 },
    ])) as { id: number }[];

    if (views.length === 0) {
      throw new OdooRpcError(`No base form view was found for "${model}"`);
    }
    return views[0].id;
  }

  /** Adds a field to a form view after another field, via an inherited view. */
  async addFieldToFormView(
    credentials: OdooOnlineCredentials,
    uid: number,
    model: string,
    field: string,
    after: string,
  ): Promise<number> {
    const inheritId = await this.baseFormViewId(credentials, uid, model);
    const arch = `<field name="${after}" position="after"><field name="${field}"/></field>`;

    return (await this.call(credentials, uid, 'ir.ui.view', 'create', [
      {
        name: `${model}.form.${field} (Cartenz)`,
        model,
        inherit_id: inheritId,
        arch,
        type: 'form',
        priority: 16,
      },
    ])) as number;
  }

  /** Generic execute_kw, restricted to the customization allow-list. */
  private async call(
    credentials: OdooOnlineCredentials,
    uid: number,
    model: string,
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    if (!CUSTOMIZATION_MODELS.has(model)) {
      throw new OdooRpcError(
        `The model "${model}" is not part of the customization surface. ` +
          'The Odoo Online agent may only read and write schema and views, never business records.',
      );
    }

    return this.request(credentials, 'object', 'execute_kw', [
      credentials.db,
      uid,
      credentials.apiKey,
      model,
      method,
      args,
    ]);
  }

  private async request(
    credentials: OdooOnlineCredentials,
    service: 'common' | 'object',
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    const endpoint = this.endpointFor(credentials.url);
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'call',
      params: { service, method, args },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'cartenz-odoo-online/1.0',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const body = (await response.json()) as JsonRpcResponse;

      if (!response.ok || body.error) {
        const detail =
          body.error?.data?.message ?? body.error?.message ?? `HTTP ${response.status}`;
        this.logger.warn(`Odoo Online ${service}.${method} failed: ${detail}`);
        throw new OdooRpcError(detail, body.error?.code ?? response.status);
      }

      return body.result;
    } catch (error) {
      if (error instanceof OdooRpcError) throw error;
      if ((error as Error).name === 'AbortError') {
        throw new OdooRpcError(`the Odoo Online request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw new OdooRpcError(`could not reach Odoo Online: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Builds the JSON-RPC endpoint, requiring an https instance root. */
  private endpointFor(url: string): string {
    const value = url.trim();
    if (!/^https:\/\//i.test(value)) {
      throw new OdooRpcError(`the Odoo Online URL must be https, got "${value}"`);
    }
    return `${value.replace(/\/+$/, '')}/jsonrpc`;
  }
}
