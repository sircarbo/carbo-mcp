/**
 * Configuration loading and startup validation.
 *
 * Every value comes from the environment. Secrets are never read from an
 * environment variable directly -- they are read from a file whose path is
 * given by a *_FILE variable, so nothing sensitive shows up in `docker inspect`
 * or in a process listing. Validation is strict and happens once at startup:
 * an invalid configuration aborts the process rather than producing a server
 * that half-works.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const KNOWN_SCOPES = [
  'carbo:server:read',
  'carbo:docker:read',
  'carbo:video:read',
  'carbo:n8n:read',
  'carbo:websites:read',
  'carbo:backups:read',
  'carbo:projects:read',
  'carbo:audit:read',
  'carbo:design:read',
  'carbo:monitoring:read',
] as const;

export type CarboScope = (typeof KNOWN_SCOPES)[number];
export const ALL_SCOPES: readonly CarboScope[] = KNOWN_SCOPES;

const httpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith('https://'), { message: 'must be an https:// URL' });

const ConfigSchema = z.object({
  /** Interface the HTTP server binds to inside the container. */
  bindHost: z.string().min(1).default('0.0.0.0'),
  port: z.coerce.number().int().min(1).max(65535).default(8110),

  /** Canonical public origin, e.g. https://mcp.carbocomputers.com */
  publicOrigin: httpsUrl,
  /** Canonical resource identifier this server accepts tokens for. */
  resourceIdentifier: httpsUrl,

  /** OAuth 2.1 authorization server (Keycloak realm issuer URL). */
  issuer: httpsUrl,
  /** JWKS endpoint. Reached over the internal Docker network, so http is allowed here. */
  jwksUri: z.string().url(),
  /** Optional explicit expected `iss` claim when it differs from the discovery issuer. */
  expectedIssuer: z.string().url().optional(),

  /** Directory holding collector snapshots. Mounted read-only. */
  snapshotDir: z.string().min(1).default('/app/snapshots'),
  /** Age past which a snapshot is reported as stale rather than fresh. */
  snapshotMaxAgeSeconds: z.coerce.number().int().min(30).max(3600).default(300),

  /** Directory the audit log is written to. The only writable mount. */
  auditDir: z.string().min(1).default('/app/data/audit'),
  auditMaxFileBytes: z.coerce.number().int().min(65536).default(16 * 1024 * 1024),
  auditMaxFiles: z.coerce.number().int().min(1).max(200).default(14),

  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  /** Per-request limits. */
  maxRequestBodyBytes: z.coerce.number().int().min(1024).max(4 * 1024 * 1024).default(256 * 1024),
  requestTimeoutMs: z.coerce.number().int().min(1000).max(120000).default(30000),
  toolTimeoutMs: z.coerce.number().int().min(500).max(60000).default(10000),

  /** Rate limiting, applied per authenticated subject and falling back to source address. */
  rateLimitWindowMs: z.coerce.number().int().min(1000).default(60000),
  rateLimitMax: z.coerce.number().int().min(1).default(120),
  authRateLimitMax: z.coerce.number().int().min(1).default(20),

  /** Number of reverse proxies in front of this server. */
  trustProxyHops: z.coerce.number().int().min(0).max(5).default(1),

  /** Subjects allowed to call the gateway at all. Empty means "any valid token". */
  allowedSubjects: z.array(z.string().min(1)).default([]),

  /** Clock skew tolerated when validating exp/nbf. */
  clockToleranceSeconds: z.coerce.number().int().min(0).max(300).default(30),
});

export type Config = z.infer<typeof ConfigSchema>;

function readSecretFile(pathValue: string, label: string): string {
  try {
    const contents = readFileSync(pathValue, 'utf8').trim();
    if (!contents) throw new Error('file is empty');
    return contents;
  } catch (err) {
    throw new Error(
      `${label}: could not read secret file at ${pathValue} (${(err as Error).message})`,
    );
  }
}

/** Reads a value that may be supplied inline or via a companion *_FILE variable. */
export function envOrFile(name: string): string | undefined {
  const filePath = process.env[`${name}_FILE`];
  if (filePath) return readSecretFile(filePath, name);
  return process.env[name];
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = {
    bindHost: env.MCP_BIND_HOST,
    port: env.MCP_PORT,
    publicOrigin: env.MCP_PUBLIC_ORIGIN,
    resourceIdentifier: env.MCP_RESOURCE_IDENTIFIER ?? env.MCP_PUBLIC_ORIGIN,
    issuer: env.OAUTH_ISSUER,
    jwksUri: env.OAUTH_JWKS_URI,
    expectedIssuer: env.OAUTH_EXPECTED_ISSUER,
    snapshotDir: env.MCP_SNAPSHOT_DIR,
    snapshotMaxAgeSeconds: env.MCP_SNAPSHOT_MAX_AGE_SECONDS,
    auditDir: env.MCP_AUDIT_DIR,
    auditMaxFileBytes: env.MCP_AUDIT_MAX_FILE_BYTES,
    auditMaxFiles: env.MCP_AUDIT_MAX_FILES,
    logLevel: env.MCP_LOG_LEVEL,
    maxRequestBodyBytes: env.MCP_MAX_BODY_BYTES,
    requestTimeoutMs: env.MCP_REQUEST_TIMEOUT_MS,
    toolTimeoutMs: env.MCP_TOOL_TIMEOUT_MS,
    rateLimitWindowMs: env.MCP_RATE_LIMIT_WINDOW_MS,
    rateLimitMax: env.MCP_RATE_LIMIT_MAX,
    authRateLimitMax: env.MCP_AUTH_RATE_LIMIT_MAX,
    trustProxyHops: env.MCP_TRUST_PROXY_HOPS,
    allowedSubjects: splitList(env.MCP_ALLOWED_SUBJECTS),
    clockToleranceSeconds: env.MCP_CLOCK_TOLERANCE_SECONDS,
  };

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

/** Human-readable, secret-free summary of the effective configuration. */
export function describeConfig(cfg: Config): Record<string, unknown> {
  return {
    bind: `${cfg.bindHost}:${cfg.port}`,
    publicOrigin: cfg.publicOrigin,
    resourceIdentifier: cfg.resourceIdentifier,
    issuer: cfg.issuer,
    jwksUri: cfg.jwksUri,
    snapshotDir: cfg.snapshotDir,
    snapshotMaxAgeSeconds: cfg.snapshotMaxAgeSeconds,
    auditDir: cfg.auditDir,
    logLevel: cfg.logLevel,
    maxRequestBodyBytes: cfg.maxRequestBodyBytes,
    requestTimeoutMs: cfg.requestTimeoutMs,
    toolTimeoutMs: cfg.toolTimeoutMs,
    rateLimit: `${cfg.rateLimitMax}/${cfg.rateLimitWindowMs}ms`,
    subjectAllowlist: cfg.allowedSubjects.length > 0 ? `${cfg.allowedSubjects.length} entries` : 'open to any valid token',
    scopes: ALL_SCOPES,
  };
}
