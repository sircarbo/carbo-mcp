/**
 * Shapes the host collector writes and the tools read.
 *
 * These are the contract between `scripts/collector.py` and the gateway. The
 * collector is responsible for making sure nothing sensitive ever reaches
 * these structures in the first place; the gateway re-sanitizes on the way out
 * as a second line of defence.
 */

export interface SystemSnapshot {
  hostname: string;
  os: string;
  kernel: string;
  architecture: string;
  uptimeSeconds: number;
  loadAverage: { one: number; five: number; fifteen: number };
  cpu: { cores: number; usagePercent: number };
  memory: { totalMb: number; usedMb: number; availableMb: number; usedPercent: number };
  swap: { totalMb: number; usedMb: number; usedPercent: number };
  disks: Array<{
    mount: string;
    filesystem: string;
    totalGb: number;
    usedGb: number;
    availableGb: number;
    usedPercent: number;
  }>;
  /** Fahrenheit is intentionally omitted; this is a server, not a thermostat. */
  temperatureCelsius?: number;
}

export interface ContainerSnapshot {
  name: string;
  image: string;
  state: 'running' | 'exited' | 'paused' | 'restarting' | 'created' | 'dead' | 'unknown';
  /** Docker health status where the image defines a health check. */
  health: 'healthy' | 'unhealthy' | 'starting' | 'none';
  status: string;
  restartPolicy: string;
  restartCount: number;
  startedAt: string | null;
  /** Published port bindings, host side only. Never internal-only ports. */
  publishedPorts: string[];
}

export interface ServiceSnapshot {
  id: string;
  name: string;
  category: 'automation' | 'web' | 'media' | 'monitoring' | 'ai' | 'design' | 'infrastructure';
  description: string;
  container: string | null;
  /** Present only for services this gateway is allowed to probe. */
  probe: { kind: 'http' | 'container' | 'none'; target: string | null };
  status: 'up' | 'down' | 'degraded' | 'unknown';
  httpStatus: number | null;
  responseTimeMs: number | null;
  lastCheckedAt: string;
  note: string | null;
}

export interface WebsiteSnapshot {
  domain: string;
  label: string;
  host: string;
  status: 'up' | 'down' | 'degraded' | 'unknown';
  httpStatus: number | null;
  responseTimeMs: number | null;
  tls: { valid: boolean; expiresAt: string | null; daysRemaining: number | null } | null;
  lastCheckedAt: string;
}

export interface N8nSnapshot {
  reachable: boolean;
  healthStatus: string | null;
  workflows: Array<{
    id: string;
    name: string;
    active: boolean;
    updatedAt: string | null;
    nodeCount: number | null;
  }>;
  executions: Array<{
    id: string;
    workflowId: string;
    workflowName: string | null;
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
  }>;
  counts: { workflowsTotal: number; workflowsActive: number; executionsSampled: number };
}

export interface VideoJobSnapshot {
  id: string;
  name: string | null;
  state: 'queued' | 'started' | 'progress' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  stage: string | null;
  progressPercent: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Sanitized, single-line failure category. Never a stack trace. */
  errorSummary: string | null;
}

export interface VideoSnapshot {
  pipelineName: string;
  lastBatchRunAt: string | null;
  lastBatchResult: 'success' | 'failed' | 'unknown';
  nextScheduledRunAt: string | null;
  jobs: VideoJobSnapshot[];
  outputs: { count: number; latestAt: string | null; totalSizeMb: number };
  counts: Record<string, number>;
}

export interface BackupSnapshot {
  id: string;
  name: string;
  schedule: string;
  lastRunAt: string | null;
  ageHours: number | null;
  status: 'ok' | 'stale' | 'missing' | 'unknown';
  artifactCount: number;
  latestArtifactSizeKb: number | null;
  retentionNote: string | null;
}

export interface ProjectSnapshot {
  id: string;
  name: string;
  path: string;
  branch: string | null;
  /** True when the working tree has uncommitted changes. */
  dirty: boolean;
  changedFileCount: number;
  lastCommit: { shortSha: string; subject: string; authoredAt: string } | null;
  aheadBehind: { ahead: number; behind: number } | null;
  status: string;
}

export interface ErrorSummarySnapshot {
  sources: Array<{
    source: string;
    windowHours: number;
    errorCount: number;
    warningCount: number;
    /** Sanitized, deduplicated, bounded. Never raw log lines. */
    topPatterns: Array<{ pattern: string; count: number; lastSeenAt: string | null }>;
  }>;
  securityScan: {
    lastRunAt: string | null;
    findingsCount: number;
    severitySummary: string | null;
  } | null;
}

/**
 * Carbo Design — the visual component system at /opt/carbo-design.
 *
 * Read through its own REST API with a token scoped to the six `*:read`
 * permissions, so this gateway inherits that project's authorisation model
 * rather than reaching around it into its database.
 */
export interface DesignSnapshot {
  reachable: boolean;
  projects: Array<{
    id: string;
    slug: string;
    name: string;
    description: string;
    componentCount: number;
    updatedAt: string | null;
  }>;
  components: Array<{
    id: string;
    slug: string;
    name: string;
    kind: string;
    status: string;
    projectSlug: string | null;
    latestVersion: number | null;
    updatedAt: string | null;
  }>;
  sites: Array<{
    slug: string;
    name: string;
    environment: string;
    baseUrl: string;
    isActive: boolean;
    publishedCount: number;
  }>;
  publications: Array<{
    siteSlug: string;
    componentSlug: string;
    componentName: string | null;
    version: number | null;
    publishedAt: string | null;
  }>;
  /** Aggregate counts only. Never actor ids, never IP addresses. */
  activity: {
    windowHours: number;
    total: number;
    byAction: Array<{ action: string; count: number }>;
    failures: number;
    lastEventAt: string | null;
  };
  counts: {
    projects: number;
    components: number;
    componentsPublished: number;
    componentsDraft: number;
    sites: number;
    publications: number;
  };
}

/**
 * Uptime Kuma on the EC2 box, read through its Prometheus `/metrics` endpoint
 * over Tailscale. Requires an API key; when none is configured the snapshot
 * still exists and says so, rather than the tool failing opaquely.
 */
export interface MonitoringSnapshot {
  reachable: boolean;
  /** False when no API key is configured. Distinct from "unreachable". */
  configured: boolean;
  note: string | null;
  source: string;
  monitors: Array<{
    name: string;
    status: 'up' | 'down' | 'pending' | 'maintenance' | 'unknown';
    responseTimeMs: number | null;
    certDaysRemaining: number | null;
  }>;
  counts: { total: number; up: number; down: number; other: number };
}

/** Liveness of the wetty browser terminal and the doors that front it. Facts only. */
export interface TerminalSnapshot {
  overall: 'up' | 'degraded' | 'down';
  container: { state: string; health: string; image: string | null };
  backend: { status: 'up' | 'down'; httpStatus: number | null; responseTimeMs: number | null };
  tailscaleServeActive: boolean;
  doors: Array<{
    id: string;
    url: string;
    status: 'up' | 'down';
    httpStatus: number | null;
    responseTimeMs: number | null;
    note: string;
  }>;
  watchdog: { timerActive: boolean; lastResult: string | null; lastRunAt: string | null };
  recentWatchdogEvents: string[];
  sshTarget: string;
}
