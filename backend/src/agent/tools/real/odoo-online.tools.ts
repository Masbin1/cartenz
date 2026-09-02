import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';
import { DatabaseService } from '../../../core/database/database.service';
import { projectConnections } from '../../../core/database/schema';
import { SECRETS_PROVIDER, type SecretsProvider } from '../../../core/secrets/secrets.provider';
import {
  OdooOnlineClient,
  type OdooOnlineCredentials,
} from '../../odoo-online/odoo-online-client';
import {
  ODOO_ADD_FIELD_TO_VIEW_SCHEMA,
  ODOO_CREATE_FIELD_SCHEMA,
  ODOO_LIST_FIELDS_SCHEMA,
  ODOO_LIST_MODELS_SCHEMA,
} from '../tool-schemas';
import type { AnyToolDefinition, ToolDefinition, ToolExecutionContext } from '../tool.interface';

/**
 * The Odoo Online tools (ADR-028).
 *
 * These are the whole tool surface for `odoo_online` - no filesystem, no Git, no
 * shell. Each resolves the project's sealed Odoo Online credentials, then drives
 * the customization surface (schema and views) through the JSON-RPC client. The
 * data-blind posture holds because the client only permits `ir.model`,
 * `ir.model.fields` and `ir.ui.view`; business records are unreachable here.
 */

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

@Injectable()
export class OdooOnlineTools {
  constructor(
    private readonly client: OdooOnlineClient,
    private readonly database: DatabaseService,
    @Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider,
  ) {}

  get definitions(): readonly AnyToolDefinition[] {
    return [
      this.listModels,
      this.listFields,
      this.createField,
      this.addFieldToView,
    ];
  }

  /**
   * Resolves and unseals the Odoo Online credentials for a task's project.
   *
   * The API key is a sealed secret, unsealed here on demand and never held beyond
   * the call. URL, database and login are non-secret connection metadata.
   */
  private async resolveCredentials(context: ToolExecutionContext): Promise<OdooOnlineCredentials> {
    const [connection] = await this.database.db
      .select({
        secretRef: projectConnections.secretRef,
        metadata: projectConnections.metadata,
      })
      .from(projectConnections)
      .where(
        and(
          eq(projectConnections.projectId, context.projectId),
          eq(projectConnections.connectionType, 'odoo_api'),
          isNotNull(projectConnections.secretRef),
        ),
      )
      .limit(1);

    if (!connection?.secretRef) {
      throw new Error(
        'This Odoo Online project has no odoo_api connection with an API key. ' +
          'Add one in the project settings.',
      );
    }

    const metadata = connection.metadata ?? {};
    const url = readString(metadata, 'url');
    const db = readString(metadata, 'db');
    const login = readString(metadata, 'login');

    if (!url || !db || !login) {
      throw new Error(
        'The Odoo Online connection is missing url, db or login in its metadata.',
      );
    }

    const apiKey = await this.secrets.read(connection.secretRef);
    return { url, db, login, apiKey };
  }

  private readonly listModels: ToolDefinition<{ query?: string }> = {
    name: 'odoo_list_models',
    description: 'List Odoo models whose technical name matches a fragment',
    permission: 'database_metadata_read',
    modes: ['odoo_online'],
    leavesPlatform: false,
    simulated: false,
    parameters: ODOO_LIST_MODELS_SCHEMA,
    availableToModel: true,
    validate: () => null,
    execute: async (input, context) => {
      const credentials = await this.resolveCredentials(context);
      const uid = await this.client.authenticate(credentials);
      const models = await this.client.listModels(credentials, uid, input.query?.trim());
      return { count: models.length, models };
    },
  };

  private readonly listFields: ToolDefinition<{ model: string }> = {
    name: 'odoo_list_fields',
    description: 'List the fields of an Odoo model, with label and type',
    permission: 'database_metadata_read',
    modes: ['odoo_online'],
    leavesPlatform: false,
    simulated: false,
    parameters: ODOO_LIST_FIELDS_SCHEMA,
    availableToModel: true,
    validate: () => null,
    execute: async (input, context) => {
      const credentials = await this.resolveCredentials(context);
      const uid = await this.client.authenticate(credentials);
      const fields = await this.client.listFields(credentials, uid, input.model);
      return { model: input.model, count: fields.length, fields };
    },
  };

  private readonly createField: ToolDefinition<{
    model: string;
    name: string;
    label: string;
    type: string;
    required?: boolean;
  }> = {
    name: 'odoo_create_field',
    description: 'Create a custom field on an Odoo model, as Odoo Studio does',
    permission: 'odoo_customize',
    modes: ['odoo_online'],
    leavesPlatform: false,
    simulated: false,
    parameters: ODOO_CREATE_FIELD_SCHEMA,
    availableToModel: true,
    validate: () => null,
    execute: async (input, context) => {
      const credentials = await this.resolveCredentials(context);
      const uid = await this.client.authenticate(credentials);
      const fieldId = await this.client.createField(credentials, uid, input.model, {
        name: input.name,
        label: input.label,
        type: input.type,
        required: input.required,
      });
      return {
        model: input.model,
        field: `x_${input.name.replace(/^x_/, '')}`,
        fieldId,
      };
    },
  };

  private readonly addFieldToView: ToolDefinition<{
    model: string;
    field: string;
    after: string;
  }> = {
    name: 'odoo_add_field_to_view',
    description: 'Place a field in the form view, below another field',
    permission: 'odoo_customize',
    modes: ['odoo_online'],
    leavesPlatform: false,
    simulated: false,
    parameters: ODOO_ADD_FIELD_TO_VIEW_SCHEMA,
    availableToModel: true,
    validate: () => null,
    execute: async (input, context) => {
      const credentials = await this.resolveCredentials(context);
      const uid = await this.client.authenticate(credentials);
      const viewId = await this.client.addFieldToFormView(
        credentials,
        uid,
        input.model,
        input.field,
        input.after,
      );
      return { model: input.model, field: input.field, after: input.after, viewId };
    },
  };
}
