import { z } from 'zod';

/**
 * Relay runtime configuration.
 *
 * Every process (web, worker, scripts) loads configuration through `loadConfig`, which
 * validates the environment once and fails closed:
 *  - unknown / malformed values are rejected with a readable error;
 *  - in `production`, demo authentication, simulated providers, default development
 *    secrets, plain-HTTP public URLs and local encryption keyrings are refused.
 *
 * `RELAY_ENV` (not NODE_ENV) selects the deployment environment. When it is absent and
 * NODE_ENV=production, Relay assumes `production` so a forgotten variable cannot silently
 * enable demo mode. Local `next start` runs (E2E) therefore set RELAY_ENV=test explicitly.
 */

export const DEPLOYMENT_ENVS = ['local', 'test', 'staging', 'production'] as const;
export type DeploymentEnv = (typeof DEPLOYMENT_ENVS)[number];

/** Values that ship in .env.example / compose. They must never reach production. */
export const KNOWN_DEV_SECRETS = [
  'relay-dev-session-secret-change-me-0123456789abcdef',
  'relay-dev-superuser',
  'relay-dev-migrator',
  'relay-dev-app',
  'relay-dev-worker',
  'relay-dev-access',
  'relay-dev-secret-key',
  'ZGV2LWtleS1kby1ub3QtdXNlLWluLXByb2R1Y3Rpb24=',
] as const;

const boolFromEnv = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v, ctx) => {
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off', ''].includes(v)) return false;
    ctx.addIssue({ code: 'custom', message: `expected a boolean, received "${v}"` });
    return z.NEVER;
  });

const intFromEnv = (min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, 'expected a non-negative integer')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

const optionalString = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  RELAY_ENV: z.enum(DEPLOYMENT_ENVS).optional(),

  // Core
  RELAY_PUBLIC_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:3000'),
  RELAY_DEMO_MODE: boolFromEnv.default(false),
  RELAY_SESSION_SECRET: z.string().min(32, 'RELAY_SESSION_SECRET must be at least 32 characters'),
  RELAY_SESSION_ABSOLUTE_TTL_SECONDS: intFromEnv(300, 60 * 60 * 24 * 90).default(60 * 60 * 24 * 14),
  RELAY_SESSION_IDLE_TTL_SECONDS: intFromEnv(300, 60 * 60 * 24 * 30).default(60 * 60 * 24),

  // Separate least-privilege logins (local development, production)...
  DATABASE_URL_APP: optionalString,
  DATABASE_URL_WORKER: optionalString,
  DATABASE_URL_MIGRATOR: optionalString,
  // ...or ONE login for hosted staging (what Neon's Vercel integration injects): each pool
  // then runs SET ROLE relay_app / relay_worker itself. Refused in production.
  DATABASE_URL: optionalString,
  DATABASE_URL_UNPOOLED: optionalString,
  RELAY_DB_POOL_MAX: intFromEnv(1, 200).default(10),

  // Application sign-in (production uses OIDC; demo sign-in only outside production)
  RELAY_OIDC_ISSUER: optionalString,
  RELAY_OIDC_CLIENT_ID: optionalString,
  RELAY_OIDC_CLIENT_SECRET: optionalString,
  RELAY_OIDC_SCOPES: z.string().default('openid email profile'),
  RELAY_OIDC_ALLOWED_EMAIL_DOMAINS: z.string().default(''),

  // Storage
  S3_ENDPOINT: optionalString,
  S3_PUBLIC_ENDPOINT: optionalString,
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  S3_FORCE_PATH_STYLE: boolFromEnv.default(false),
  RELAY_UPLOAD_URL_TTL_SECONDS: intFromEnv(60, 60 * 60 * 6).default(60 * 30),
  RELAY_MEDIA_URL_TTL_SECONDS: intFromEnv(30, 60 * 60).default(300),
  RELAY_UPLOAD_SESSION_TTL_SECONDS: intFromEnv(300, 60 * 60 * 48).default(60 * 60 * 6),

  // Upload and media caps (conservative defaults; all configurable)
  RELAY_MAX_VIDEO_BYTES: intFromEnv(1024, Number.MAX_SAFE_INTEGER).default(4 * 1024 ** 3),
  RELAY_MAX_IMAGE_BYTES: intFromEnv(1024, Number.MAX_SAFE_INTEGER).default(30 * 1024 ** 2),
  RELAY_MAX_VIDEO_DURATION_MS: intFromEnv(1000, 24 * 60 * 60 * 1000).default(4 * 60 * 60 * 1000),
  RELAY_MAX_VIDEO_DIMENSION: intFromEnv(16, 16384).default(7680),
  RELAY_MAX_IMAGE_PIXELS: intFromEnv(256, 400_000_000).default(50_000_000),
  RELAY_SINGLE_UPLOAD_MAX_BYTES: intFromEnv(1024, 5 * 1024 ** 3).default(32 * 1024 ** 2),
  RELAY_MULTIPART_PART_BYTES: intFromEnv(5 * 1024 ** 2, 512 * 1024 ** 2).default(16 * 1024 ** 2),
  RELAY_MAX_CAROUSEL_ITEMS: intFromEnv(2, 50).default(10),
  RELAY_WORKSPACE_STORAGE_QUOTA_BYTES: intFromEnv(1024, Number.MAX_SAFE_INTEGER).default(
    200 * 1024 ** 3,
  ),

  // Media processing sandbox
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  RELAY_MEDIA_SCRATCH_DIR: optionalString,
  RELAY_MEDIA_TIMEOUT_SECONDS: intFromEnv(5, 60 * 60 * 6).default(60 * 30),
  RELAY_MEDIA_MEMORY_LIMIT_MB: intFromEnv(64, 65536).default(2048),
  RELAY_MEDIA_THREADS: intFromEnv(1, 64).default(2),
  RELAY_MEDIA_USE_PRLIMIT: boolFromEnv.default(true),

  // Worker
  RELAY_WORKER_POOLS: z.string().default('general,media'),
  RELAY_WORKER_CONCURRENCY: intFromEnv(1, 64).default(4),
  RELAY_MEDIA_CONCURRENCY: intFromEnv(1, 16).default(1),
  RELAY_WORKER_HEALTH_PORT: intFromEnv(0, 65535).default(3101),
  /** 127.0.0.1 locally; containers probed over the network (e.g. Kubernetes) set 0.0.0.0. */
  RELAY_WORKER_HEALTH_HOST: z.string().trim().min(1).default('127.0.0.1'),
  RELAY_WORKER_ID: optionalString,

  // Encryption (envelope). Local keyring for dev/test; KMS in production.
  RELAY_ENCRYPTION_PROVIDER: z.enum(['local', 'kms']).default('local'),
  RELAY_ENCRYPTION_KEYS: optionalString,
  RELAY_KMS_KEY_ID: optionalString,

  // Operations
  RELAY_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  RELAY_PUBLISH_KILL_SWITCH: boolFromEnv.default(false),
  // Hosted staging only: the worker migrates and seeds the database when it starts.
  RELAY_AUTO_MIGRATE: boolFromEnv.default(false),
  RELAY_AUTO_SEED: boolFromEnv.default(false),
  RELAY_SCHEDULER_LATE_GRACE_SECONDS: intFromEnv(0, 60 * 60 * 24).default(15 * 60),
  RELAY_TELEMETRY_ENDPOINT: optionalString,

  // Provider integrations (real adapters land in M3+; flags default off)
  RELAY_PROVIDER_YOUTUBE_ENABLED: boolFromEnv.default(false),
  RELAY_PROVIDER_INSTAGRAM_ENABLED: boolFromEnv.default(false),
  RELAY_PROVIDER_FACEBOOK_PAGE_ENABLED: boolFromEnv.default(false),
  RELAY_PROVIDER_TIKTOK_ENABLED: boolFromEnv.default(false),
  RELAY_PROVIDER_TWITCH_ENABLED: boolFromEnv.default(false),
});

export type RawEnv = z.input<typeof envSchema>;

export interface KeyringEntry {
  kid: string;
  key: Buffer;
}

export interface RelayConfig {
  env: DeploymentEnv;
  isProduction: boolean;
  publicUrl: URL;
  publicOrigin: string;
  demoMode: boolean;
  session: {
    secret: string;
    cookieName: string;
    csrfCookieName: string;
    secureCookies: boolean;
    absoluteTtlSeconds: number;
    idleTtlSeconds: number;
  };
  database: {
    appUrl: string;
    workerUrl: string;
    migratorUrl: string | undefined;
    poolMax: number;
    /** One login for every pool; pools assume relay_app / relay_worker with SET ROLE. */
    singleLogin: boolean;
  };
  oidc: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    scopes: string;
    allowedEmailDomains: string[];
    redirectUri: string;
  } | null;
  storage: {
    endpoint: string | undefined;
    publicEndpoint: string | undefined;
    region: string;
    bucket: string;
    accessKeyId: string | undefined;
    secretAccessKey: string | undefined;
    forcePathStyle: boolean;
    uploadUrlTtlSeconds: number;
    mediaUrlTtlSeconds: number;
    uploadSessionTtlSeconds: number;
  };
  uploads: {
    maxVideoBytes: number;
    maxImageBytes: number;
    maxVideoDurationMs: number;
    maxVideoDimension: number;
    maxImagePixels: number;
    singleUploadMaxBytes: number;
    multipartPartBytes: number;
    maxCarouselItems: number;
    workspaceStorageQuotaBytes: number;
  };
  media: {
    ffmpegPath: string;
    ffprobePath: string;
    scratchDir: string | undefined;
    timeoutSeconds: number;
    memoryLimitMb: number;
    threads: number;
    usePrlimit: boolean;
  };
  worker: {
    pools: Array<'general' | 'media'>;
    generalConcurrency: number;
    mediaConcurrency: number;
    healthPort: number;
    healthHost: string;
    workerId: string | undefined;
  };
  encryption: {
    provider: 'local' | 'kms';
    keyring: KeyringEntry[];
    kmsKeyId: string | undefined;
  };
  ops: {
    logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
    publishKillSwitch: boolean;
    autoMigrate: boolean;
    autoSeed: boolean;
    lateGraceSeconds: number;
    telemetryEndpoint: string | undefined;
  };
  providers: Record<
    'youtube' | 'instagram' | 'facebook_page' | 'tiktok' | 'twitch',
    { enabled: boolean }
  >;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid Relay configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * ConfigError check that survives duplicated module instances (bundlers can load a package
 * twice, which defeats `instanceof`).
 */
export function isConfigError(error: unknown): error is ConfigError {
  return (
    error instanceof ConfigError ||
    (error instanceof Error &&
      error.name === 'ConfigError' &&
      Array.isArray((error as ConfigError).problems))
  );
}

function parseKeyring(raw: string | undefined, problems: string[]): KeyringEntry[] {
  if (!raw) return [];
  const entries: KeyringEntry[] = [];
  for (const part of raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const idx = part.indexOf(':');
    if (idx <= 0) {
      problems.push('RELAY_ENCRYPTION_KEYS entries must look like "<kid>:<base64-32-byte-key>"');
      continue;
    }
    const kid = part.slice(0, idx);
    const key = Buffer.from(part.slice(idx + 1), 'base64');
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(kid)) {
      problems.push(`RELAY_ENCRYPTION_KEYS key id "${kid}" is not a valid identifier`);
      continue;
    }
    if (key.length !== 32) {
      problems.push(`RELAY_ENCRYPTION_KEYS key "${kid}" must decode to exactly 32 bytes`);
      continue;
    }
    entries.push({ kid, key });
  }
  return entries;
}

/**
 * Pin TLS verification. pg treats sslmode=prefer|require|verify-ca as verify-full today and
 * warns on every start that its next major version will weaken them to libpq semantics. Spelling
 * out verify-full keeps certificate and hostname verification independent of the driver version
 * and keeps the logs quiet. Only the parameter value is touched; an explicit uselibpqcompat=true
 * is the operator's choice and is left alone.
 */
function pinSslMode<T extends string | undefined>(url: T): T {
  if (!url || /[?&]uselibpqcompat=true(?=&|$)/.test(url)) return url;
  return url.replace(
    /([?&])sslmode=(?:prefer|require|verify-ca)(?=&|$)/,
    '$1sslmode=verify-full',
  ) as T;
}

/** Hostnames and parameters that providers use for their transaction poolers. */
function looksPooled(url: string): boolean {
  try {
    const u = new URL(url);
    return /pooler/i.test(u.hostname) || u.searchParams.get('pgbouncer') === 'true';
  } catch {
    return false;
  }
}

function containsDevSecret(value: string | undefined): boolean {
  if (!value) return false;
  return KNOWN_DEV_SECRETS.some((secret) => value.includes(secret));
}

/** Validate and normalise the environment. Throws ConfigError listing every problem. */
export function parseConfig(source: Record<string, string | undefined>): RelayConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const e = parsed.data;
  const problems: string[] = [];

  const env: DeploymentEnv = e.RELAY_ENV ?? (e.NODE_ENV === 'production' ? 'production' : 'local');
  const isProduction = env === 'production';

  // Database logins: either both per-role URLs, or DATABASE_URL alone (single-login mode).
  // Single-login pools assume their role with SET ROLE, which is session state that transaction
  // poolers (PgBouncer, Neon's "-pooler" host) do not preserve, so every pool uses the direct
  // host: DATABASE_URL_UNPOOLED when the provider supplies one.
  const singleLogin = !e.DATABASE_URL_APP && !e.DATABASE_URL_WORKER && Boolean(e.DATABASE_URL);
  const directUrl = e.DATABASE_URL_UNPOOLED ?? e.DATABASE_URL;
  const appUrl = e.DATABASE_URL_APP ?? directUrl;
  const workerUrl = e.DATABASE_URL_WORKER ?? directUrl;
  const migratorUrl = e.DATABASE_URL_MIGRATOR ?? (singleLogin ? directUrl : undefined);
  if (singleLogin && directUrl && looksPooled(directUrl)) {
    problems.push(
      'DATABASE_URL points at a connection pooler, which drops SET ROLE between transactions: set DATABASE_URL_UNPOOLED to the direct connection string (Neon calls it "unpooled")',
    );
  }
  if (!appUrl || !workerUrl) {
    problems.push(
      'Database: set DATABASE_URL_APP and DATABASE_URL_WORKER (separate least-privilege logins), or DATABASE_URL alone for a single-login staging database',
    );
  } else if (!singleLogin && (!e.DATABASE_URL_APP || !e.DATABASE_URL_WORKER)) {
    problems.push(
      'DATABASE_URL_APP and DATABASE_URL_WORKER must be set together; a pool must never fall back to the DATABASE_URL login without assuming its role',
    );
  }
  const publicUrl = new URL(e.RELAY_PUBLIC_URL);
  const secureCookies = publicUrl.protocol === 'https:';

  const pools = e.RELAY_WORKER_POOLS.split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  for (const pool of pools) {
    if (pool !== 'general' && pool !== 'media') {
      problems.push(`RELAY_WORKER_POOLS contains unknown pool "${pool}" (expected general, media)`);
    }
  }

  const keyring = parseKeyring(e.RELAY_ENCRYPTION_KEYS, problems);
  if (e.RELAY_ENCRYPTION_PROVIDER === 'local' && keyring.length === 0) {
    problems.push('RELAY_ENCRYPTION_KEYS is required when RELAY_ENCRYPTION_PROVIDER=local');
  }
  if (e.RELAY_ENCRYPTION_PROVIDER === 'kms' && !e.RELAY_KMS_KEY_ID) {
    problems.push('RELAY_KMS_KEY_ID is required when RELAY_ENCRYPTION_PROVIDER=kms');
  }

  const oidcFields = [e.RELAY_OIDC_ISSUER, e.RELAY_OIDC_CLIENT_ID, e.RELAY_OIDC_CLIENT_SECRET];
  const oidcConfigured = oidcFields.every(Boolean);
  if (!oidcConfigured && oidcFields.some(Boolean)) {
    problems.push(
      'RELAY_OIDC_ISSUER, RELAY_OIDC_CLIENT_ID and RELAY_OIDC_CLIENT_SECRET must be set together',
    );
  }
  if (e.RELAY_OIDC_ISSUER && !/^https:\/\//.test(e.RELAY_OIDC_ISSUER) && isProduction) {
    problems.push('RELAY_OIDC_ISSUER must use https in production');
  }

  if (e.S3_ACCESS_KEY_ID && !e.S3_SECRET_ACCESS_KEY) {
    problems.push('S3_SECRET_ACCESS_KEY is required when S3_ACCESS_KEY_ID is set');
  }

  if (e.RELAY_MULTIPART_PART_BYTES > e.RELAY_MAX_VIDEO_BYTES) {
    problems.push('RELAY_MULTIPART_PART_BYTES must not exceed RELAY_MAX_VIDEO_BYTES');
  }
  // S3 allows at most 10,000 parts per multipart upload.
  if (Math.ceil(e.RELAY_MAX_VIDEO_BYTES / e.RELAY_MULTIPART_PART_BYTES) > 10_000) {
    problems.push(
      'RELAY_MAX_VIDEO_BYTES / RELAY_MULTIPART_PART_BYTES exceeds the 10,000-part S3 limit',
    );
  }

  // ----- Production fail-closed rules -------------------------------------------------
  if (isProduction) {
    if (e.RELAY_DEMO_MODE) {
      problems.push(
        'RELAY_DEMO_MODE must be false in production (demo sign-in and simulated providers are forbidden)',
      );
    }
    if (publicUrl.protocol !== 'https:') {
      problems.push('RELAY_PUBLIC_URL must use https in production');
    }
    if (containsDevSecret(e.RELAY_SESSION_SECRET)) {
      problems.push('RELAY_SESSION_SECRET is a known development default');
    }
    for (const [name, value] of [
      ['DATABASE_URL_APP', e.DATABASE_URL_APP],
      ['DATABASE_URL_WORKER', e.DATABASE_URL_WORKER],
      ['DATABASE_URL_MIGRATOR', e.DATABASE_URL_MIGRATOR],
      ['DATABASE_URL', e.DATABASE_URL],
      ['DATABASE_URL_UNPOOLED', e.DATABASE_URL_UNPOOLED],
      ['S3_ACCESS_KEY_ID', e.S3_ACCESS_KEY_ID],
      ['S3_SECRET_ACCESS_KEY', e.S3_SECRET_ACCESS_KEY],
      ['RELAY_ENCRYPTION_KEYS', e.RELAY_ENCRYPTION_KEYS],
    ] as const) {
      if (containsDevSecret(value)) problems.push(`${name} contains a known development default`);
    }
    if (e.RELAY_ENCRYPTION_PROVIDER !== 'kms') {
      problems.push('RELAY_ENCRYPTION_PROVIDER must be "kms" in production');
    }
    if (singleLogin) {
      problems.push(
        'DATABASE_URL single-login mode is for staging: production requires DATABASE_URL_APP and DATABASE_URL_WORKER with separate least-privilege roles',
      );
    }
    if (e.RELAY_AUTO_MIGRATE || e.RELAY_AUTO_SEED) {
      problems.push(
        'RELAY_AUTO_MIGRATE and RELAY_AUTO_SEED are refused in production (migrations are an operator action)',
      );
    }
    if (!oidcConfigured) {
      problems.push('OIDC sign-in (RELAY_OIDC_*) must be configured in production');
    }
    if (e.S3_ENDPOINT && !e.S3_ENDPOINT.startsWith('https://')) {
      problems.push('S3_ENDPOINT must use https in production');
    }
    if (e.S3_PUBLIC_ENDPOINT && !e.S3_PUBLIC_ENDPOINT.startsWith('https://')) {
      problems.push('S3_PUBLIC_ENDPOINT must use https in production');
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    env,
    isProduction,
    publicUrl,
    publicOrigin: publicUrl.origin,
    demoMode: e.RELAY_DEMO_MODE,
    session: {
      secret: e.RELAY_SESSION_SECRET,
      // __Host- requires Secure + Path=/ + no Domain; only usable over https.
      cookieName: secureCookies ? '__Host-relay_session' : 'relay_session',
      csrfCookieName: secureCookies ? '__Host-relay_csrf' : 'relay_csrf',
      secureCookies,
      absoluteTtlSeconds: e.RELAY_SESSION_ABSOLUTE_TTL_SECONDS,
      idleTtlSeconds: e.RELAY_SESSION_IDLE_TTL_SECONDS,
    },
    database: {
      appUrl: pinSslMode(appUrl as string),
      workerUrl: pinSslMode(workerUrl as string),
      migratorUrl: pinSslMode(migratorUrl),
      poolMax: e.RELAY_DB_POOL_MAX,
      singleLogin,
    },
    oidc: oidcConfigured
      ? {
          issuer: e.RELAY_OIDC_ISSUER!,
          clientId: e.RELAY_OIDC_CLIENT_ID!,
          clientSecret: e.RELAY_OIDC_CLIENT_SECRET!,
          scopes: e.RELAY_OIDC_SCOPES,
          allowedEmailDomains: e.RELAY_OIDC_ALLOWED_EMAIL_DOMAINS.split(',')
            .map((d) => d.trim().toLowerCase())
            .filter(Boolean),
          redirectUri: new URL('/api/auth/oidc/callback', publicUrl).toString(),
        }
      : null,
    storage: {
      endpoint: e.S3_ENDPOINT,
      publicEndpoint: e.S3_PUBLIC_ENDPOINT ?? e.S3_ENDPOINT,
      region: e.S3_REGION,
      bucket: e.S3_BUCKET,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      uploadUrlTtlSeconds: e.RELAY_UPLOAD_URL_TTL_SECONDS,
      mediaUrlTtlSeconds: e.RELAY_MEDIA_URL_TTL_SECONDS,
      uploadSessionTtlSeconds: e.RELAY_UPLOAD_SESSION_TTL_SECONDS,
    },
    uploads: {
      maxVideoBytes: e.RELAY_MAX_VIDEO_BYTES,
      maxImageBytes: e.RELAY_MAX_IMAGE_BYTES,
      maxVideoDurationMs: e.RELAY_MAX_VIDEO_DURATION_MS,
      maxVideoDimension: e.RELAY_MAX_VIDEO_DIMENSION,
      maxImagePixels: e.RELAY_MAX_IMAGE_PIXELS,
      singleUploadMaxBytes: e.RELAY_SINGLE_UPLOAD_MAX_BYTES,
      multipartPartBytes: e.RELAY_MULTIPART_PART_BYTES,
      maxCarouselItems: e.RELAY_MAX_CAROUSEL_ITEMS,
      workspaceStorageQuotaBytes: e.RELAY_WORKSPACE_STORAGE_QUOTA_BYTES,
    },
    media: {
      ffmpegPath: e.FFMPEG_PATH,
      ffprobePath: e.FFPROBE_PATH,
      scratchDir: e.RELAY_MEDIA_SCRATCH_DIR,
      timeoutSeconds: e.RELAY_MEDIA_TIMEOUT_SECONDS,
      memoryLimitMb: e.RELAY_MEDIA_MEMORY_LIMIT_MB,
      threads: e.RELAY_MEDIA_THREADS,
      usePrlimit: e.RELAY_MEDIA_USE_PRLIMIT,
    },
    worker: {
      pools: pools as Array<'general' | 'media'>,
      generalConcurrency: e.RELAY_WORKER_CONCURRENCY,
      mediaConcurrency: e.RELAY_MEDIA_CONCURRENCY,
      healthPort: e.RELAY_WORKER_HEALTH_PORT,
      healthHost: e.RELAY_WORKER_HEALTH_HOST,
      workerId: e.RELAY_WORKER_ID,
    },
    encryption: {
      provider: e.RELAY_ENCRYPTION_PROVIDER,
      keyring,
      kmsKeyId: e.RELAY_KMS_KEY_ID,
    },
    ops: {
      logLevel: e.RELAY_LOG_LEVEL,
      publishKillSwitch: e.RELAY_PUBLISH_KILL_SWITCH,
      autoMigrate: e.RELAY_AUTO_MIGRATE,
      autoSeed: e.RELAY_AUTO_SEED,
      lateGraceSeconds: e.RELAY_SCHEDULER_LATE_GRACE_SECONDS,
      telemetryEndpoint: e.RELAY_TELEMETRY_ENDPOINT,
    },
    providers: {
      youtube: { enabled: e.RELAY_PROVIDER_YOUTUBE_ENABLED },
      instagram: { enabled: e.RELAY_PROVIDER_INSTAGRAM_ENABLED },
      facebook_page: { enabled: e.RELAY_PROVIDER_FACEBOOK_PAGE_ENABLED },
      tiktok: { enabled: e.RELAY_PROVIDER_TIKTOK_ENABLED },
      twitch: { enabled: e.RELAY_PROVIDER_TWITCH_ENABLED },
    },
  };
}

let cached: RelayConfig | undefined;

/** Load (and memoise) configuration from process.env. */
export function loadConfig(): RelayConfig {
  cached ??= parseConfig(process.env);
  return cached;
}

/** Test helper: forget the memoised config. */
export function resetConfigCache(): void {
  cached = undefined;
}
