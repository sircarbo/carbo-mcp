/**
 * Snapshot reader -- the gateway's only source of truth about the host.
 *
 * The MCP container deliberately cannot see the Docker socket, the host
 * filesystem, or any application port. A small privileged collector on the
 * host gathers what the tools need, sanitizes it, and writes JSON files that
 * are mounted here read-only. That keeps the container itself capability-free
 * and read-only: even a full compromise of this process yields nothing but
 * data the collector had already decided was safe to publish.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type SnapshotName =
  | 'system'
  | 'containers'
  | 'services'
  | 'websites'
  | 'n8n'
  | 'video'
  | 'backups'
  | 'projects'
  | 'errors'
  | 'design'
  | 'monitoring';

export interface SnapshotEnvelope<T> {
  /** When the collector produced this snapshot (UTC ISO-8601). */
  collectedAt: string;
  /** Seconds since collection, computed at read time. */
  ageSeconds: number;
  /** False when the snapshot is older than the configured tolerance. */
  fresh: boolean;
  data: T;
}

export class SnapshotUnavailableError extends Error {
  constructor(readonly snapshot: SnapshotName) {
    super(`snapshot "${snapshot}" is not available`);
    this.name = 'SnapshotUnavailableError';
  }
}

export class SnapshotReader {
  /** Short-lived memo so a burst of tool calls does not re-read the same file. */
  private cache = new Map<string, { mtimeMs: number; parsed: unknown }>();

  constructor(
    private readonly dir: string,
    private readonly maxAgeSeconds: number,
  ) {}

  read<T>(name: SnapshotName): SnapshotEnvelope<T> {
    const path = join(this.dir, `${name}.json`);

    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      throw new SnapshotUnavailableError(name);
    }

    const cached = this.cache.get(name);
    let parsed: unknown;
    if (cached && cached.mtimeMs === mtimeMs) {
      parsed = cached.parsed;
    } else {
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        throw new SnapshotUnavailableError(name);
      }
      this.cache.set(name, { mtimeMs, parsed });
    }

    const envelope = parsed as { collected_at?: string; data?: T };
    const collectedAt = envelope.collected_at ?? new Date(mtimeMs).toISOString();
    const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(collectedAt)) / 1000));

    if (envelope.data === undefined) throw new SnapshotUnavailableError(name);

    return {
      collectedAt,
      ageSeconds,
      fresh: ageSeconds <= this.maxAgeSeconds,
      data: envelope.data,
    };
  }

  /** True when every snapshot the readiness probe depends on is present and fresh. */
  readiness(required: SnapshotName[]): { ready: boolean; details: Record<string, string> } {
    const details: Record<string, string> = {};
    let ready = true;
    for (const name of required) {
      try {
        const env = this.read(name);
        details[name] = env.fresh ? `fresh (${env.ageSeconds}s)` : `stale (${env.ageSeconds}s)`;
        if (!env.fresh) ready = false;
      } catch {
        details[name] = 'unavailable';
        ready = false;
      }
    }
    return { ready, details };
  }
}
