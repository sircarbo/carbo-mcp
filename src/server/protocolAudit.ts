/**
 * Audit records for protocol-level MCP traffic.
 *
 * Tool calls audit themselves from inside the handler wrapper, where the scope,
 * parameters and duration are known. Everything else -- `initialize`,
 * `tools/list`, and any request the transport rejects before a handler sees it
 * -- previously left no trace at all, which meant the audit log could not answer
 * "did the connector actually connect?". It also meant a transport-level
 * rejection (an unsupported protocol version, say) was invisible outside the
 * reverse proxy's access log.
 *
 * This module fills that gap by reading the JSON-RPC envelope on the way in and
 * recording the outcome once the response has finished.
 */
import type { Request, Response } from 'express';
import type { AuditLog, AuditOutcome } from '../logging/audit.js';
import type { AuthContext } from '../auth/tokenVerifier.js';

/** A JSON-RPC message reduced to the parts worth auditing. */
interface ParsedMessage {
  method: string;
  isNotification: boolean;
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: string;
}

function parseOne(value: unknown): ParsedMessage | null {
  if (value === null || typeof value !== 'object') return null;
  const msg = value as Record<string, unknown>;
  if (typeof msg.method !== 'string') return null;

  const parsed: ParsedMessage = {
    method: msg.method,
    isNotification: msg.id === undefined || msg.id === null,
  };

  const params = msg.params as Record<string, unknown> | undefined;
  if (params && typeof params === 'object') {
    const info = params.clientInfo as Record<string, unknown> | undefined;
    if (info && typeof info === 'object') {
      if (typeof info.name === 'string') parsed.clientName = info.name.slice(0, 80);
      if (typeof info.version === 'string') parsed.clientVersion = info.version.slice(0, 40);
    }
    if (typeof params.protocolVersion === 'string') {
      parsed.protocolVersion = params.protocolVersion.slice(0, 40);
    }
  }
  return parsed;
}

/** Extracts every JSON-RPC message from a body, which may be a batch. */
export function parseMessages(body: unknown): ParsedMessage[] {
  if (Array.isArray(body)) {
    return body.map(parseOne).filter((m): m is ParsedMessage => m !== null).slice(0, 20);
  }
  const one = parseOne(body);
  return one ? [one] : [];
}

export function outcomeForStatus(status: number): AuditOutcome {
  if (status >= 200 && status < 300) return 'success';
  if (status === 401 || status === 403) return 'denied';
  if (status === 429) return 'rate_limited';
  if (status === 504) return 'timeout';
  return 'error';
}

/** Maps a JSON-RPC method to the audit event type it belongs to. */
function eventFor(method: string): 'initialize' | 'tools_list' | 'protocol' | null {
  if (method === 'initialize') return 'initialize';
  if (method === 'tools/list') return 'tools_list';
  // tools/call is audited per-tool, with far more detail, inside the handler.
  if (method === 'tools/call') return null;
  // Notifications and keepalives are noise; only record them if they fail,
  // which the caller decides.
  return 'protocol';
}

/**
 * Registers a `finish` listener that records one audit event per protocol-level
 * message in the request. Attach it after authentication, so the subject is known.
 */
export function auditProtocolRequest(
  req: Request,
  res: Response,
  auth: AuthContext,
  requestId: string,
  audit: AuditLog,
): void {
  const started = Date.now();
  const messages = parseMessages(req.body);
  if (messages.length === 0) return;

  res.on('finish', () => {
    const status = res.statusCode;
    const outcome = outcomeForStatus(status);

    for (const msg of messages) {
      const event = eventFor(msg.method);
      if (event === null) continue;

      // A successful notification or ping is not worth a record; a failing one is,
      // because that is where a protocol mismatch shows up.
      if (event === 'protocol' && outcome === 'success') continue;

      const detail: Record<string, string> = {};
      if (msg.clientName) detail.clientName = msg.clientName;
      if (msg.clientVersion) detail.clientVersion = msg.clientVersion;
      if (msg.protocolVersion) detail.protocolVersion = msg.protocolVersion;
      const requested = req.header('mcp-protocol-version');
      if (requested) detail.requestedProtocolVersion = requested.slice(0, 40);

      audit.write({
        requestId,
        subject: auth.subject,
        ...(auth.clientId ? { clientId: auth.clientId } : {}),
        event,
        method: msg.method,
        outcome,
        httpStatus: status,
        durationMs: Date.now() - started,
        ...(Object.keys(detail).length > 0 ? { detail } : {}),
        ...(outcome !== 'success' ? { errorCategory: `http_${status}` } : {}),
        sourceAddress: req.ip,
        userAgent: req.header('user-agent'),
      });
    }
  });
}
