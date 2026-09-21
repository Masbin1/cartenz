import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  CONNECTION_TYPES,
  CREDENTIAL_KINDS,
  ENVIRONMENT_KINDS,
  ODOO_EDITIONS,
  ODOO_VERSIONS,
  PROJECT_TYPES,
  USER_REGIONS,
  type ConnectionType,
  type CredentialKind,
  type EnvironmentKind,
  type OdooEdition,
  type OdooVersion,
  type ProjectType,
  type UserRegion,
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
  @IsIn(USER_REGIONS, { message: `region must be one of: ${USER_REGIONS.join(', ')}` })
  region!: UserRegion;

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

  /**
   * Community or Enterprise (ADR-037). Omitted means enterprise, the behaviour
   * before the field existed. For a community project the generated odoo.conf
   * leaves the enterprise addons path out.
   */
  @IsOptional()
  @IsIn(ODOO_EDITIONS, { message: `odooEdition must be one of: ${ODOO_EDITIONS.join(', ')}` })
  odooEdition?: OdooEdition;

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
   * Create the project's custom addon on disk (ADR-032).
   *
   * On-premise only: the directory is created under ON_PREMISE_ROOT, initialised
   * as a Git repository and committed, so the first task has somewhere to write.
   */
  @IsOptional()
  @IsBoolean()
  scaffold?: boolean;

  /**
   * The Odoo module name to create, when `scaffold` is set. Derived from the
   * project name when omitted. Lowercase identifier: it is a Python package
   * name and a directory name, not a label.
   */
  @IsOptional()
  @IsString()
  @MaxLength(63)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  technicalName?: string;

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

  /**
   * Internal-only metadata about the linked instance the operator is
   * connecting to (ADR-050, ADR-054) — the customer's own odoo.sh/on-premise
   * project, so a later restore action can reach its database manager.
   *
   * This never creates a repository or a connection by itself: a
   * repository-backed project still pulls from `repositoryUrl` exactly as
   * before (ADR-049). It is metadata about a second, separate URL.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  projectUrl?: string;

  /** The database name at `projectUrl`, when the operator knows it. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trim)
  projectDatabase?: string;

  /** True when `projectUrl` names an Odoo.sh project. */
  @IsOptional()
  @IsBoolean()
  isOdoosh?: boolean;
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
  @IsIn(USER_REGIONS, { message: `region must be one of: ${USER_REGIONS.join(', ')}` })
  region!: UserRegion;

  @IsString()
  @IsNotEmpty({ message: 'A project name is required' })
  @MaxLength(200)
  @Transform(trim)
  name!: string;

  @IsIn(ODOO_VERSIONS, { message: `odooVersion must be one of: ${ODOO_VERSIONS.join(', ')}` })
  odooVersion!: OdooVersion;

  /**
   * Community or Enterprise (ADR-037). Omitted means enterprise, the behaviour
   * before the field existed.
   */
  @IsOptional()
  @IsIn(ODOO_EDITIONS, { message: `odooEdition must be one of: ${ODOO_EDITIONS.join(', ')}` })
  odooEdition?: OdooEdition;

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

  /**
   * Restrict this project's tasks to on-host models (ADR-055). Changed only by
   * an admin, the same rank that governs agent permissions: turning it off
   * allows customer material to reach an external provider.
   */
  @IsOptional()
  @IsBoolean()
  localProviderOnly?: boolean;
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
  @IsString()
  @IsNotEmpty({ message: 'A repository URL is required' })
  @MaxLength(2048)
  @Transform(trim)
  repositoryUrl!: string;
}

/** Query filter for the project list. */
export class ListProjectsQueryDto {
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  includeArchived?: boolean;
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

/**
 * ADR-057: which branch a restart should pull and serve.
 *
 * Not implied from the project's `defaultBranch` — the caller states it
 * because restarting a staging instance onto `staging` (re-syncing a preview
 * or staging instance with the latest staging commit) is exactly as
 * legitimate a call as restarting onto `main` after a merge, and this route
 * must not assume which one a person means.
 */
export class RestartProjectDto {
  @IsString()
  @IsNotEmpty({ message: 'branch is required' })
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/, {
    message: 'branch must be a valid git branch name',
  })
  branch!: string;
}
