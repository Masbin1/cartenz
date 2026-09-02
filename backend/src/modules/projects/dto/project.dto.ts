import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  CONNECTION_TYPES,
  CREDENTIAL_KINDS,
  ENVIRONMENT_KINDS,
  ODOO_VERSIONS,
  PROJECT_TYPES,
  type ConnectionType,
  type CredentialKind,
  type EnvironmentKind,
  type OdooVersion,
  type ProjectType,
} from '../../../core/enums';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * One environment on a project (ADR-021).
 *
 * In Odoo.sh an environment is a branch. `kind` is what the platform reasons
 * about: a task targeting a production environment is refused.
 */
export class EnvironmentDto {
  @IsString()
  @IsNotEmpty({ message: 'An environment needs a name' })
  @MaxLength(100)
  @Transform(trim)
  name!: string;

  @IsString()
  @IsNotEmpty({ message: 'An environment needs a branch' })
  @MaxLength(200)
  @Transform(trim)
  branch!: string;

  @IsIn(ENVIRONMENT_KINDS, {
    message: `kind must be one of: ${ENVIRONMENT_KINDS.join(', ')}`,
  })
  kind!: EnvironmentKind;

  @IsOptional()
  @IsBoolean()
  isDefaultTarget?: boolean;
}

/**
 * Connect an existing project. The repository URL is accepted; the credential to
 * reach it is supplied separately through the connection endpoint, so a
 * credential never travels in a project payload.
 */
export class CreateProjectDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @IsNotEmpty({ message: 'A project name is required' })
  @MaxLength(200)
  @Transform(trim)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  @Transform(trim)
  description?: string;

  @IsIn(PROJECT_TYPES, { message: `projectType must be one of: ${PROJECT_TYPES.join(', ')}` })
  projectType!: ProjectType;

  @IsOptional()
  @IsIn(ODOO_VERSIONS, { message: `odooVersion must be one of: ${ODOO_VERSIONS.join(', ')}` })
  odooVersion?: OdooVersion;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  defaultBranch?: string;

  /**
   * Validated by assertSafeRemoteUrl in the service, not here.
   *
   * A second URL rule in the DTO would inevitably disagree with the one that
   * actually governs cloning - it did, refusing a scheme the clone path accepts -
   * and two validators with different answers is worse than one. This checks only
   * that a string of plausible length arrived.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  repositoryUrl?: string;

  /** Non-sensitive environment configuration. Rejected if it carries a secret. */
  @IsOptional()
  @IsObject()
  environmentConfig?: Record<string, unknown>;

  /**
   * The environments this project has (ADR-021).
   *
   * Declared here because this is when the person creating the project knows which
   * branch is which. Omitted, the project gets one development environment from
   * its default branch - so nothing is silently treated as production.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => EnvironmentDto)
  environments?: EnvironmentDto[];
}

/** One requirement in the AI project specification. */
export class RequirementDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @Transform(trim)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Transform(trim)
  detail?: string;
}

/**
 * Create a new project with AI. Collects the four documented inputs - name,
 * Odoo version, description and initial requirements - and produces a structured
 * specification, so that project context is persisted rather than left to be
 * re-derived from chat history.
 */
export class CreateAiProjectDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @IsNotEmpty({ message: 'A project name is required' })
  @MaxLength(200)
  @Transform(trim)
  name!: string;

  @IsIn(ODOO_VERSIONS, { message: `odooVersion must be one of: ${ODOO_VERSIONS.join(', ')}` })
  odooVersion!: OdooVersion;

  @IsString()
  @IsNotEmpty({ message: 'A project description is required' })
  @MaxLength(4000)
  @Transform(trim)
  description!: string;

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RequirementDto)
  requirements!: RequirementDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  modules?: string[];
}

export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Transform(trim)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  @Transform(trim)
  description?: string;

  @IsOptional()
  @IsIn(ODOO_VERSIONS)
  odooVersion?: OdooVersion;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  defaultBranch?: string;

  @IsOptional()
  @IsObject()
  environmentConfig?: Record<string, unknown>;
}

/**
 * Agent permission update. Values are validated against the declared permission
 * set in the service, so an unknown key is rejected rather than stored and
 * silently ignored.
 */
export class UpdateAgentPermissionsDto {
  @IsObject()
  permissions!: Record<string, boolean>;
}

/**
 * Create a project connection. `credential` is the only field in the API that
 * carries secret material; it is sealed immediately and is never read back,
 * logged or returned.
 */
export class CreateConnectionDto {
  @IsIn(CONNECTION_TYPES, {
    message: `connectionType must be one of: ${CONNECTION_TYPES.join(', ')}`,
  })
  connectionType!: ConnectionType;

  @IsOptional()
  @IsString()
  @MaxLength(16384)
  credential?: string;

  /**
   * What the credential is (ADR-021). A token for HTTPS, or an SSH private key -
   * which is how Odoo.sh's native remote is reached.
   */
  @IsOptional()
  @IsIn(CREDENTIAL_KINDS, {
    message: `credentialKind must be one of: ${CREDENTIAL_KINDS.join(', ')}`,
  })
  credentialKind?: CredentialKind;

  /**
   * The remote's SSH host key, in known_hosts form.
   *
   * Not a secret - a host's public key is public. Supplying it reaches the strict
   * verification posture; omitting it means the first connection is trusted and
   * the key recorded (ADR-021).
   */
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  @Transform(trim)
  sshHostKey?: string;

  /** Non-sensitive detail: host, account, repository slug. */
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

/**
 * Asking a repository which branches it has, before a project exists.
 *
 * Same shape of check as `repositoryUrl` above and for the same reason: the URL
 * rule that governs the network call lives in `assertSafeRemoteUrl`, not here.
 */
export class RemoteBranchesDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @IsNotEmpty({ message: 'A repository URL is required' })
  @MaxLength(2048)
  @Transform(trim)
  repositoryUrl!: string;
}

/** Query filter for the project list. */
export class ListProjectsQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  includeArchived?: boolean;
}

/**
 * Query for the on-premise location list, read while the project form is being
 * filled in. Gated behind developer membership like project creation itself.
 */
export class OnPremiseLocationsQueryDto {
  @IsUUID()
  organizationId!: string;
}

/**
 * Confirmation for a permanent delete (ADR-024).
 *
 * The project's own name, typed back. A boolean would be as easy to send by
 * accident as it is to send on purpose, and the point of the field is to make the
 * caller read which project they are about to destroy.
 */
export class DeleteProjectDto {
  @IsString()
  @IsNotEmpty({ message: 'confirmName is required: type the project name to confirm' })
  @MaxLength(200)
  confirmName!: string;
}
