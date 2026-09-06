/**
 * Append-only audit trail.
 *
 * Audit records are a separate stream from application logs: they go to a
 * dedicated, rotated file on the one writable volume, and they carry a fixed
 * schema so they can be queried later (including by the
 * carbo_get_mcp_audit_summary tool). Writes are best-effort and never throw --
 * an audit failure must not take down request handling -- but every failure is
 * surfaced on the application logger rather than swallowed.
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, readdirSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from './logger.js';
import { redact, summarizeParams } from './redact.js';

export type AuditOutcome = 'success' | 'denied' | 'error' | 'timeout' | 'rate_limited';

export interface AuditEvent {
  /** UTC ISO-8601. */
  timestamp: string;
  /** Correlation id shared with the application log and the response headers. */
  requestId: string;
  /** `sub` claim of the presented token, or `anonymous`. */
  subject: string;
  /** OAuth client id (`azp`/`client_id`) when the token carries one. */
  clientId?: string;
  event:
    | 'tool_call'
    | 'tools_list'
    | 'initialize'
    | 'protocol'
    | 'auth_failure'
    | 'rate_limit'
    | 'startup'
    | 'shutdown'
    | 'health';
  /** JSON-RPC method, for protocol-level events that are not tool calls. */
  method?: string;
  toolName?: string;
  /** Scope the tool required, not the full scope set of the token. */
  requiredScope?: string;
  /** Key names and value shapes only -- never argument values. */
  params?: Record<string, string>;
  /**
   * Small, non-sensitive facts worth keeping verbatim -- the connecting client's
   * name and the protocol version it asked for, say. Unlike `params` these keep
   * their values, so only put things here that are safe to read back. They still
   * pass through redaction.
   */
  detail?: Record<string, string>;
  /** HTTP status the request finished with, for protocol-level events. */
  httpStatus?: number;
  outcome: AuditOutcome;
  durationMs?: number;
  /** Stable category, safe to expose. Never a raw exception message. */
  errorCategory?: string;
  sourceAddress?: string;
  userAgent?: string;
}

const FILENAME = 'audit.log';

export class AuditLog {
  private stream: ReturnType<typeof createWriteStream> | null = null;
  private bytesWritten = 0;

  constructor(
    private readonly dir: string,
    private readonly maxFileBytes: number,
    private readonly maxFiles: number,
    private readonly logger: Logger,
  ) {}

  init(): void {
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, FILENAME);
    this.bytesWritten = existsSync(path) ? statSync(path).size : 0;
    this.stream = createWriteStream(path, { flags: 'a' });
    this.stream.on('error', (err) => {
      this.logger.error({ err }, 'audit log stream error');
    });
  }

  /**
   * Records one event. Parameters are summarized, then the whole record is
   * redacted, so neither path can leak a value.
   */
  write(event: Omit<AuditEvent, 'timestamp'> & { rawParams?: unknown }): void {
    const { rawParams, ...rest } = event;
    const record: AuditEvent = {
      timestamp: new Date().toISOString(),
      ...rest,
      ...(rawParams !== undefined ? { params: summarizeParams(rawParams) } : {}),
    };

    let line: string;
    try {
      line = JSON.stringify(redact(record)) + '\n';
    } catch (err) {
      this.logger.error({ err }, 'failed to serialize audit record');
      return;
    }

    try {
      this.rotateIfNeeded(Buffer.byteLength(line));
      this.stream?.write(line);
      this.bytesWritten += Buffer.byteLength(line);
    } catch (err) {
      this.logger.error({ err }, 'failed to write audit record');
    }
  }

  private rotateIfNeeded(incoming: number): void {
    if (this.bytesWritten + incoming <= this.maxFileBytes) return;
    const path = join(this.dir, FILENAME);
    this.stream?.end();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    renameSync(path, join(this.dir, `${FILENAME}.${stamp}`));
    this.stream = createWriteStream(path, { flags: 'a' });
    this.stream.on('error', (err) => this.logger.error({ err }, 'audit log stream error'));
    this.bytesWritten = 0;
    this.pruneOldFiles();
  }

  private pruneOldFiles(): void {
    const rotated = readdirSync(this.dir)
      .filter((f) => f.startsWith(`${FILENAME}.`))
      .sort()
      .reverse();
    for (const stale of rotated.slice(this.maxFiles)) {
      try {
        unlinkSync(join(this.dir, stale));
      } catch (err) {
        this.logger.warn({ err, file: stale }, 'failed to prune rotated audit file');
      }
    }
  }

  /**
   * Reads back recent events for the audit summary tool. Bounded by line count
   * so a large file cannot be pulled into memory or into a tool response.
   */
  readRecent(limit: number): AuditEvent[] {
    const path = join(this.dir, FILENAME);
    if (!existsSync(path)) return [];
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return [];
    }
    const lines = text.split('\n').filter(Boolean);
    const tail = lines.slice(-Math.max(1, Math.min(limit, 5000)));
    const out: AuditEvent[] = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line) as AuditEvent);
      } catch {
        // A partially written final line is expected; skip it.
      }
    }
    return out;
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}
