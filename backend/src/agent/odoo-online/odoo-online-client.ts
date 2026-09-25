import { Injectable, Logger } from '@nestjs/common';
import { recordModelRefusal } from './odoo-record-surface';

/**
 * The Odoo Online execution surface (ADR-028, extended by ADR-064): no
 * filesystem, no Git, no clone.
 *
 * Customization happens through the Odoo JSON-RPC API, driven with the project's
 * credentials (URL, database, login and API key). This is the same mechanism Odoo
 * Studio uses under the hood - `ir.model.fields` for schema and `ir.ui.view` for
 * the form - and it was verified against a live Odoo Online instance rather than
 * assumed: the API key authenticates and creates fields and inherited views.
 *
 * Record data (`product.template`, `res.partner` rows and so on) is reachable
 * too, since ADR-064: this mode's whole reason to exist is often "make me some
 * sample data" or "add these five customers", and a client that could never
 * write a record could never do that. What stays fixed here rather than left to
 * the tool layer is the *shape* of a record call - only `search_read`,
 * `search_count`, `create` and `write` reach a model at all, `unlink` and
 * `execute` do not exist on this client - because a client method is a smaller,
 * more auditable boundary than trusting every caller to ask for the right thing.
 * Which models and how many records is the record surface's job
 * (`odoo-record-surface.ts`), reached through the tool and permission layers, not
 * this file.
 */

/** The JSON-RPC models the client may touch for customization. Metadata only. */
const CUSTOMIZATION_MODELS = new Set([
  'ir.model',
  'ir.model.fields',
  'ir.ui.view',
]);

/**
 * The record methods the client may address to a business model.
 *
 * A fixed list rather than "whatever the caller asks for": `unlink` is absent
 * deliberately (deleting customer records is not sample data, and nothing in this
 * mode asks for it), as is `execute` - a method that runs arbitrary server-side
 * code is the whole allow-list defeated in one call.
 */
const RECORD_METHODS = new Set(['search_read', 'search_count', 'create', 'write']);

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

  /**
   * Fields of a model, for the agent to plan against.
   *
   * Read from `ir.model.fields` rather than by calling `fields_get` on the model
   * itself. Both return the same schema, but only this one stays inside the
   * customization allow-list: `fields_get` would require permitting a call against
   * `sale.order`, and a surface that may call one method on a business model is one
   * narrow reading away from permitting another. The allow-list is the control
   * here, so the route that does not widen it is the right one.
   *
   * `state` is Odoo's own record of where a field came from: `manual` for one added
   * through Studio or by this platform, `base` for one that ships with the module.
   */
  async listFields(
    credentials: OdooOnlineCredentials,
    uid: number,
    model: string,
  ): Promise<OdooFieldInfo[]> {
    const rows = (await this.call(
      credentials,
      uid,
      'ir.model.fields',
      'search_read',
      [[['model', '=', model]]],
      { fields: ['name', 'field_description', 'ttype', 'required', 'state'], limit: 500 },
    )) as {
      name: string;
      field_description: string;
      ttype: string;
      required: boolean;
      state: string;
    }[];

    return rows
      .map((row) => ({
        name: row.name,
        label: row.field_description ?? row.name,
        type: row.ttype ?? 'unknown',
        required: row.required === true,
        manual: row.state === 'manual',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The id of a model by its technical name, e.g. `sale.order`. */
  async modelId(credentials: OdooOnlineCredentials, uid: number, model: string): Promise<number> {
    const rows = (await this.call(
      credentials,
      uid,
      'ir.model',
      'search_read',
      [[['model', '=', model]]],
      { fields: ['id'], limit: 1 },
    )) as { id: number }[];

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
    const rows = (await this.call(credentials, uid, 'ir.model', 'search_read', [domain], {
      fields: ['name', 'model'],
      limit: 200,
    })) as { name: string; model: string }[];

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
    const views = (await this.call(
      credentials,
      uid,
      'ir.ui.view',
      'search_read',
      [[['model', '=', model], ['type', '=', 'form'], ['inherit_id', '=', false]]],
      { fields: ['id'], limit: 1 },
    )) as { id: number }[];

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

  /**
   * Record reads, restricted to the record surface (ADR-064).
   *
   * The model is checked again here although the tool validated it first: the
   * client is the last point before the network, and a caller added later that
   * forgets the tool-level check must still fail closed.
   */
  async searchRecords(
    credentials: OdooOnlineCredentials,
    uid: number,
    model: string,
    domain: unknown[],
    fields: readonly string[],
    limit: number,
  ): Promise<Record<string, unknown>[]> {
    return (await this.recordCall(credentials, uid, model, 'search_read', [domain], {
      fields: [...fields],
      limit,
    })) as Record<string, unknown>[];
  }

  /** How many records match, so a model can report totals without reading rows. */
  async countRecords(
    credentials: OdooOnlineCredentials,
    uid: number,
    model: string,
    domain: unknown[],
  ): Promise<number> {
    return (await this.recordCall(credentials, uid, model, 'search_count', [domain])) as number;
  }

  /**
   * Creates records in one call, returning the ids Odoo assigned.
   *
   * Odoo 17+ accepts a list of value dicts to `create` and returns a list of ids;
   * older versions returned a single id for a single dict. Both are normalised to
   * an array so a caller never has to know which it is talking to.
   */
  async createRecords(
    credentials: OdooOnlineCredentials,
    uid: number,
    model: string,
    records: readonly Record<string, unknown>[],
  ): Promise<number[]> {
    const result = await this.recordCall(credentials, uid, model, 'create', [[...records]]);
    if (Array.isArray(result)) return result as number[];
    if (typeof result === 'number') return [result];
    throw new OdooRpcError(`create on ${model} returned no ids`);
  }

  /** Writes the same values to existing records. Odoo answers `true`. */
  async updateRecords(
    credentials: OdooOnlineCredentials,
    uid: number,
    model: string,
    ids: readonly number[],
    values: Record<string, unknown>,
  ): Promise<boolean> {
    return (await this.recordCall(credentials, uid, model, 'write', [[...ids], values])) === true;
  }

  /**
   * Generic execute_kw, restricted to the customization allow-list.
   *
   * `kwargs` is a seventh element of the RPC argument list, not a trailing entry
   * of the positional array. Odoo binds positional arguments by position, so a
   * `{fields, limit}` object passed positionally became `search_read`'s `fields`
   * parameter and every call failed with `Invalid field 'fields'`. Verified
   * against a live Odoo 19 instance, in both shapes.
   */
  private async call(
    credentials: OdooOnlineCredentials,
    uid: number,
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (!CUSTOMIZATION_MODELS.has(model)) {
      throw new OdooRpcError(
        `The model "${model}" is not part of the customization surface. ` +
          'Schema and view changes go through ir.model, ir.model.fields and ir.ui.view only.',
      );
    }

    return this.executeKw(credentials, uid, model, method, args, kwargs);
  }

  /**
   * execute_kw against a business model, for the record surface (ADR-064).
   *
   * Two checks, both before anything leaves the platform: the method must be one
   * of the four record methods, and the model must be outside the protected set
   * (users, groups, `ir.*` and the rest in `odoo-record-surface.ts`).
   */
  private async recordCall(
    credentials: OdooOnlineCredentials,
    uid: number,
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (!RECORD_METHODS.has(method)) {
      throw new OdooRpcError(`The record method "${method}" is not permitted on Odoo Online.`);
    }
    const refusal = recordModelRefusal(model);
    if (refusal) {
      throw new OdooRpcError(`Refused: ${refusal}.`);
    }

    return this.executeKw(credentials, uid, model, method, args, kwargs);
  }

  private async executeKw(
    credentials: OdooOnlineCredentials,
    uid: number,
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request(credentials, 'object', 'execute_kw', [
      credentials.db,
      uid,
      credentials.apiKey,
      model,
      method,
      args,
      kwargs,
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
    return `${instanceRootOf(url)}/jsonrpc`;
  }
}

/**
 * The instance root, from whatever a person pasted.
 *
 * What people copy out of the browser is the web client - `https://x.odoo.com/odoo`
 * in Odoo 17+, `/web` before that - and posting JSON-RPC under that path reaches the
 * web controller instead, which answers `400 Session expired (invalid CSRF token)`.
 * That error names nothing the user did wrong, so the suffix is stripped here rather
 * than left for them to discover. Verified against a live instance in both forms.
 */
export function instanceRootOf(url: string): string {
  const value = url.trim();
  if (!/^https:\/\//i.test(value)) {
    throw new OdooRpcError(`the Odoo Online URL must be https, got "${value}"`);
  }
  return value.replace(/\/+$/, '').replace(/\/(odoo|web)$/i, '');
}

/**
 * The database name implied by an Odoo Online URL.
 *
 * On odoo.com the database is the subdomain, so asking for it separately asks a
 * person to retype something the URL already says. Offered as a default; the
 * connection may still carry an explicit `db` for an instance where it differs.
 */
export function databaseFromUrl(url: string): string | null {
  try {
    const host = new URL(instanceRootOf(url)).hostname;
    const [subdomain, ...rest] = host.split('.');
    return rest.length >= 2 && subdomain.length > 0 ? subdomain : null;
  } catch {
    return null;
  }
}
