import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { isLoopbackUrl } from '../enums';

/**
 * Environment contract for the API and the worker.
 *
 * The schema is the only place environment variables are read. Nothing else in
 * the codebase touches process.env, so a value cannot be consumed without first
 * being declared, documented in .env.example and validated here.
 *
 * Validation runs at boot. A misconfigured deployment fails to start rather than
 * failing at the first request that happens to need the missing value.
 */

const HEX_64 = /^[0-9a-fA-F]{64}$/;

const durationSchema = z
  .string()
  .regex(/^[0-9]+(ms|s|m|h|d)$/, 'must be a duration such as 15m, 24h or 30d');

const csvOrigins = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  )
  .pipe(z.array(z.string().url()).min(1, 'at least one CORS origin is required'));

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().min(1).default('0.0.0.0'),
  CORS_ORIGINS: csvOrigins.default('http://localhost:3000'),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
      'DATABASE_URL must be a postgres:// or postgresql:// connection string',
    ),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),


  REDIS_URL: z
    .string()
    .min(1, 'REDIS_URL is required')
    .refine(
      (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
      'REDIS_URL must be a redis:// or rediss:// connection string',
    ),

  // ADR-015. No default: a deployable secret must be supplied deliberately.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: durationSchema.default('15m'),
  JWT_REFRESH_TTL: durationSchema.default('30d'),

  // ADR-014. 32 bytes, hex encoded. Wraps every per-project data key.
  SECRETS_ROOT_KEY: z
    .string()
    .regex(HEX_64, 'SECRETS_ROOT_KEY must be 64 hex characters (32 bytes)'),
  SECRETS_PROVIDER: z.enum(['envelope', 'vault']).default('envelope'),

  AI_PROVIDER: z.enum(['mock', 'openai-compatible', 'anthropic']).default('mock'),
  AI_MODEL: z.string().min(1).default('mock-agent-v1'),
  AI_BASE_URL: z.union([z.string().url(), z.literal('')]).optional(),
  AI_API_KEY: z.string().optional(),

  /**
   * Model call bounds (ADR-020).
   *
   * These are what stop a task running until something else stops it. A loop that
   * exhausts any of them fails with the reason stated rather than continuing.
   */
  AI_MAX_STEPS: z.coerce.number().int().min(1).max(50).default(12),
  AI_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(200).default(30),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(64000).default(8000),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5000).max(600000).default(120000),
  /** 0 for the most deterministic output, which is what a code change wants. */
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0),

  AGENT_STEP_DELAY_MS: z.coerce.number().int().min(0).max(60000).default(900),
  AGENT_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),

  // Workspaces (ADR-019). Every task clones into its own directory below this
  // root, and the root is the boundary every filesystem operation is checked
  // against.
  WORKSPACE_ROOT: z.string().min(1).default('.runtime/workspaces'),
  WORKSPACE_MAX_BYTES: z.coerce.number().int().min(1048576).default(536870912),
  WORKSPACE_MAX_FILES: z.coerce.number().int().min(100).default(50000),
  // Workspaces are destroyed with their task. Retaining them is a debugging aid
  // and is refused in production, because a retained clone is customer source
  // code left on platform disk.
  WORKSPACE_RETAIN_ON_FAILURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /**
   * On-premise execution (ADR-028).
   *
   * ON_PREMISE_ROOT is the base directory under which on-premise projects live,
   * e.g. /home/masbintang/linkederp. Empty means on-premise execution is disabled:
   * a task on an on_premise project is refused with a message an operator can act
   * on rather than failing obscurely inside the workspace layer.
   *
   * ON_PREMISE_READ_ONLY_PATHS names the shared Odoo directories (base,
   * enterprise) the agent may READ for dependency analysis and testing but must
   * never modify. Comma-separated absolute paths; each becomes a read-only root
   * whose prefix is its directory name.
   */
  ON_PREMISE_ROOT: z.string().default(''),
  ON_PREMISE_READ_ONLY_PATHS: z.string().default(''),

  // Git. Shallow by default: a task needs a branch and a diff, not history.
  GIT_CLONE_DEPTH: z.coerce.number().int().min(1).max(1000).default(1),
  GIT_AUTHOR_NAME: z.string().min(1).default('LinkedERP AI Agent'),
  GIT_AUTHOR_EMAIL: z.string().email().default('ai-agent@linkederp.com'),
  /**
   * Permits file:// remotes. Off by default and refused in production: a
   * file:// remote lets a caller read any repository on the platform host. It
   * exists so the test suite can clone without network access.
   */
  GIT_ALLOW_LOCAL_REMOTES: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /**
   * The master switch for pushing to a customer repository (ADR-021).
   *
   * Off by default, and enforced by CommandRunner refusing the subcommand before
   * the process is built. It is not a permission or an approval: with this false,
   * no code path in the platform can push, whatever else is configured.
   */
  GIT_PUSH_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /**
   * SSH host key policy (ADR-021).
   *
   * "yes" is correct and requires a recorded host key on the connection.
   * "accept-new" trusts the first connection and records what it learned, which is
   * a real compromise and is logged as one. "no" is not offered: it accepts any
   * host key and makes the connection trivially man-in-the-middleable.
   */
  GIT_SSH_HOST_KEY_POLICY: z.enum(['yes', 'accept-new']).default('accept-new'),
  /**
   * Validation: running the repository's own Odoo modules (ADR-027).
   *
   * Off by default, and enforced at the process chokepoint rather than by the
   * tool, for the same reason as GIT_PUSH_ENABLED: a guarantee that rests on a
   * tool being unimplemented ends the moment someone implements it.
   *
   * Enabling it lets the platform start an Odoo process on this host. That is a
   * deliberate widening of what the platform may execute, and it is the operator's
   * decision, not a permission a project can grant itself.
   */
  VALIDATION_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /**
   * Which Odoo core serves which series: `19.0=/opt/odoo19,17.0=/opt/odoo17`.
   *
   * A consultancy host carries several. A project whose series is not configured
   * is skipped rather than run against a different one.
   */
  ODOO_RUNTIMES: z.string().default(''),

  /** Addon directories shared across series: enterprise, OCA, and so on. */
  ODOO_SHARED_ADDON_PATHS: z.string().default(''),

  /**
   * The Postgres role validation runs as. NOT the customer's Odoo role.
   *
   * On the host this was written for, the `odoo` role is a superuser owning every
   * customer database. A test run authenticating as it would have superuser on the
   * cluster, and an Odoo test run writes.
   */
  VALIDATION_DB_USER: z.string().default(''),
  VALIDATION_DB_PASSWORD: z.string().default(''),

  /**
   * Where validation reaches Postgres.
   *
   * Separate from DATABASE_URL rather than parsed out of it, because they are not
   * the same connection: the platform's own database may be elsewhere, and the
   * one that matters here is the cluster Odoo uses.
   */
  VALIDATION_DB_HOST: z.string().default('127.0.0.1'),
  VALIDATION_DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),

  /** A run that has not finished by here is killed. Installing modules is slow. */
  VALIDATION_TIMEOUT_MS: z.coerce.number().int().min(60_000).default(900_000),

  // Child process limits, enforced by CommandRunner.
  PROCESS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(60000),
  PROCESS_MAX_TIMEOUT_MS: z.coerce.number().int().min(1000).max(1800000).default(300000),
  PROCESS_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65536).default(8388608),

  // Bounds on the read and search tools, so one tool call cannot return a
  // repository's worth of text to a model or a browser.
  CODE_SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).max(1000).default(60),
  CODE_SEARCH_MAX_FILE_BYTES: z.coerce.number().int().min(1024).default(1048576),
  READ_FILE_MAX_BYTES: z.coerce.number().int().min(1024).default(262144),
});

export type Environment = z.infer<typeof environmentSchema>;

/**
 * Typed configuration exposed to the application. Grouped by concern so that a
 * consumer injects the section it needs rather than reaching for a flat bag of
 * strings.
 */
export interface AppConfig {
  readonly env: Environment['NODE_ENV'];
  readonly isProduction: boolean;
  readonly api: {
    readonly port: number;
    readonly host: string;
    readonly corsOrigins: readonly string[];
  };
  readonly database: {
    readonly url: string;
    readonly poolMax: number;
    readonly ssl: boolean;
  };
  readonly redis: {
    readonly url: string;
  };
  readonly auth: {
    readonly jwtSecret: string;
    readonly accessTtl: string;
    readonly refreshTtl: string;
  };
  readonly secrets: {
    readonly rootKey: Buffer;
    readonly provider: Environment['SECRETS_PROVIDER'];
  };
  readonly ai: {
    readonly provider: Environment['AI_PROVIDER'];
    readonly model: string;
    readonly baseUrl?: string;
    readonly apiKey?: string;
    readonly maxSteps: number;
    readonly maxToolCalls: number;
    readonly maxOutputTokens: number;
    readonly requestTimeoutMs: number;
    readonly temperature: number;
  };
  readonly agent: {
    readonly stepDelayMs: number;
    readonly workerConcurrency: number;
  };
  readonly workspace: {
    readonly root: string;
    readonly maxBytes: number;
    readonly maxFiles: number;
    readonly retainOnFailure: boolean;
  };
  readonly onPremise: {
    /** Base directory for on-premise projects, or null when disabled. */
    readonly root: string | null;
    /** Shared Odoo directories the agent may read but never write. */
    readonly readOnlyPaths: readonly string[];
  };
  readonly git: {
    readonly cloneDepth: number;
    readonly authorName: string;
    readonly authorEmail: string;
    readonly allowLocalRemotes: boolean;
    readonly pushEnabled: boolean;
    readonly sshHostKeyPolicy: Environment['GIT_SSH_HOST_KEY_POLICY'];
  };
  readonly validation: {
    readonly enabled: boolean;
    readonly runtimes: string;
    readonly sharedAddonPaths: readonly string[];
    readonly databaseUser: string;
    readonly databasePassword: string;
    readonly databaseHost: string;
    readonly databasePort: number;
    readonly timeoutMs: number;
  };
  readonly process: {
    readonly timeoutMs: number;
    readonly maxTimeoutMs: number;
    readonly maxOutputBytes: number;
  };
  readonly limits: {
    readonly searchMaxResults: number;
    readonly searchMaxFileBytes: number;
    readonly readFileMaxBytes: number;
  };
}

export class ConfigurationError extends Error {
  constructor(issues: readonly string[]) {
    super(
      'Invalid environment configuration. The process will not start.\n' +
        issues.map((issue) => `  - ${issue}`).join('\n') +
        '\nSee .env.example for the full contract.',
    );
    this.name = 'ConfigurationError';
  }
}

/**
 * Parses and validates the environment. Throws ConfigurationError listing every
 * problem at once, so a developer fixes one round of errors rather than
 * discovering them one restart at a time.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = environmentSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new ConfigurationError(issues);
  }

  const env = result.data;

  /**
   * A provider named without a key would fail at the first task rather than at
   * boot, which is the wrong place: the operator who set AI_PROVIDER is not the
   * person who submits the task.
   */
  if (env.AI_PROVIDER !== 'mock' && !env.AI_API_KEY) {
    throw new ConfigurationError([
      `AI_PROVIDER is "${env.AI_PROVIDER}" but AI_API_KEY is not set. Set a key, or set AI_PROVIDER=mock.`,
    ]);
  }

  /**
   * The same transport rule the portal applies (ADR-023).
   *
   * The portal refuses a plaintext endpoint that is not on this machine, because
   * the prompt carries repository source and the key travels with it. The
   * environment path did not, which meant the safer of the two ways to configure
   * a gateway was the one with the check — and the operator path, where a mistake
   * is quietest, was the one without.
   */
  if (
    env.AI_PROVIDER === 'openai-compatible' &&
    env.AI_BASE_URL &&
    env.AI_BASE_URL.startsWith('http://') &&
    !isLoopbackUrl(env.AI_BASE_URL)
  ) {
    throw new ConfigurationError([
      'AI_BASE_URL uses plain http for an endpoint that is not on this machine. The prompt ' +
        'carries repository source code and the API key travels with it. Use https, or a ' +
        'gateway on localhost.',
    ]);
  }

  if (env.AI_PROVIDER === 'openai-compatible' && !env.AI_BASE_URL) {
    throw new ConfigurationError([
      'AI_PROVIDER is "openai-compatible" but AI_BASE_URL is not set.',
    ]);
  }

  // On-premise paths are validated at boot so a typo fails here rather than at the
  // first task that targets the misconfigured directory.
  if (env.ON_PREMISE_ROOT && !isAbsolute(env.ON_PREMISE_ROOT)) {
    throw new ConfigurationError(['ON_PREMISE_ROOT must be an absolute path.']);
  }
  const readOnlyPaths = env.ON_PREMISE_READ_ONLY_PATHS.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const path of readOnlyPaths) {
    if (!isAbsolute(path)) {
      throw new ConfigurationError([
        `ON_PREMISE_READ_ONLY_PATHS entry "${path}" must be an absolute path.`,
      ]);
    }
  }

  // Guard against a production deployment left on the development providers.
  if (env.NODE_ENV === 'production') {
    const unsafe: string[] = [];
    if (env.SECRETS_PROVIDER === 'envelope') {
      unsafe.push('SECRETS_PROVIDER=envelope is not permitted in production; see docs/adr/ADR-014');
    }
    if (env.AI_PROVIDER === 'mock') {
      unsafe.push('AI_PROVIDER=mock is not permitted in production');
    }
    if (env.GIT_ALLOW_LOCAL_REMOTES) {
      unsafe.push(
        'GIT_ALLOW_LOCAL_REMOTES=true is not permitted in production; see docs/adr/ADR-019',
      );
    }
    if (env.WORKSPACE_RETAIN_ON_FAILURE) {
      unsafe.push(
        'WORKSPACE_RETAIN_ON_FAILURE=true is not permitted in production: it leaves customer source code on platform disk',
      );
    }
    if (unsafe.length > 0) {
      throw new ConfigurationError(unsafe);
    }
  }

  const emptyToUndefined = (value: string | undefined): string | undefined =>
    value === undefined || value.length === 0 ? undefined : value;

  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    api: {
      port: env.API_PORT,
      host: env.API_HOST,
      corsOrigins: env.CORS_ORIGINS,
    },
    database: {
      url: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
      ssl: env.DATABASE_SSL,
    },
    redis: {
      url: env.REDIS_URL,
    },
    auth: {
      jwtSecret: env.JWT_SECRET,
      accessTtl: env.JWT_ACCESS_TTL,
      refreshTtl: env.JWT_REFRESH_TTL,
    },
    secrets: {
      rootKey: Buffer.from(env.SECRETS_ROOT_KEY, 'hex'),
      provider: env.SECRETS_PROVIDER,
    },
    ai: {
      provider: env.AI_PROVIDER,
      model: env.AI_MODEL,
      baseUrl: emptyToUndefined(env.AI_BASE_URL),
      apiKey: emptyToUndefined(env.AI_API_KEY),
      maxSteps: env.AI_MAX_STEPS,
      maxToolCalls: env.AI_MAX_TOOL_CALLS,
      maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
      requestTimeoutMs: env.AI_REQUEST_TIMEOUT_MS,
      temperature: env.AI_TEMPERATURE,
    },
    agent: {
      stepDelayMs: env.AGENT_STEP_DELAY_MS,
      workerConcurrency: env.AGENT_WORKER_CONCURRENCY,
    },
    workspace: {
      root: env.WORKSPACE_ROOT,
      maxBytes: env.WORKSPACE_MAX_BYTES,
      maxFiles: env.WORKSPACE_MAX_FILES,
      retainOnFailure: env.WORKSPACE_RETAIN_ON_FAILURE,
    },
    onPremise: {
      root: emptyToUndefined(env.ON_PREMISE_ROOT) ?? null,
      readOnlyPaths,
    },
    git: {
      cloneDepth: env.GIT_CLONE_DEPTH,
      authorName: env.GIT_AUTHOR_NAME,
      authorEmail: env.GIT_AUTHOR_EMAIL,
      allowLocalRemotes: env.GIT_ALLOW_LOCAL_REMOTES,
      pushEnabled: env.GIT_PUSH_ENABLED,
      sshHostKeyPolicy: env.GIT_SSH_HOST_KEY_POLICY,
    },
    validation: {
      enabled: env.VALIDATION_ENABLED,
      runtimes: env.ODOO_RUNTIMES,
      sharedAddonPaths: env.ODOO_SHARED_ADDON_PATHS.split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
      databaseUser: env.VALIDATION_DB_USER,
      databasePassword: env.VALIDATION_DB_PASSWORD,
      databaseHost: env.VALIDATION_DB_HOST,
      databasePort: env.VALIDATION_DB_PORT,
      timeoutMs: env.VALIDATION_TIMEOUT_MS,
    },
    process: {
      timeoutMs: env.PROCESS_TIMEOUT_MS,
      maxTimeoutMs: env.PROCESS_MAX_TIMEOUT_MS,
      maxOutputBytes: env.PROCESS_MAX_OUTPUT_BYTES,
    },
    limits: {
      searchMaxResults: env.CODE_SEARCH_MAX_RESULTS,
      searchMaxFileBytes: env.CODE_SEARCH_MAX_FILE_BYTES,
      readFileMaxBytes: env.READ_FILE_MAX_BYTES,
    },
  };
}
