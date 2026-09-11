/**
 * Builds a per-request MCP server instance.
 *
 * The transport runs in stateless mode: a fresh McpServer and transport are
 * created for each request and torn down when it completes. That costs a
 * little construction work per call and buys the property that matters most
 * for a multi-user gateway -- no session state can survive a request or leak
 * between two callers.
 *
 * Only the tools the caller's token actually authorizes are registered, so
 * tools/list is already scope-filtered and the model is never shown a
 * capability it would be refused.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import type { Config } from '../config.js';
import type { AuditLog } from '../logging/audit.js';
import type { Logger } from '../logging/logger.js';
import type { AuthContext } from '../auth/tokenVerifier.js';
import { ToolError, type ToolDefinition, type ToolRegistry } from '../tools/registry.js';

export const SERVER_INFO = {
  name: 'carbo-mcp-gateway',
  version: '1.0.0',
} as const;

const ELEVATED_INSTRUCTIONS = [
  '',
  'Exception: this token also carries the kling_* tools, which are NOT read-only. kling_animate_image',
  'submits a PAID video-generation job to Kling AI. Only call it when the operator has explicitly asked',
  'to generate; one explicit request authorizes one job. Use dry_run: true to show the exact image,',
  'prompt, model, duration and available cost information first when the request is not explicit.',
  'Never resubmit a job whose outcome is uncertain; check kling_video_status instead.',
].join('\n');

const INSTRUCTIONS = [
  'Carbo MCP Gateway exposes read-only operational visibility into carbo-server:',
  'system resources, Docker container state, monitored service and website health,',
  'n8n automation workflows and executions, Video Factory job status, backup freshness,',
  'project repository state, sanitized error summaries, and this gateway\'s own audit trail.',
  '',
  'Every tool is read-only. Nothing here can start, stop, restart, deploy, publish, send,',
  'delete, or execute anything. If asked to perform an action, say plainly that this',
  'connector is read-only and suggest the operator do it directly.',
  '',
  'Data comes from a host collector that refreshes periodically, not from live measurement.',
  'Each response carries a freshness block; when fresh is false, say the data is stale',
  'and give its age rather than presenting it as current.',
].join('\n');

/**
 * Runs one tool handler with scope enforcement, a hard timeout, and an audit
 * record for every outcome.
 */
async function invokeTool(
  def: ToolDefinition,
  args: unknown,
  cfg: Config,
  auth: AuthContext,
  requestId: string,
  audit: AuditLog,
  logger: Logger,
): Promise<{ ok: true; value: unknown } | { ok: false; category: string; message: string }> {
  const started = Date.now();
  const timeoutMs = def.timeoutMs ?? cfg.toolTimeoutMs;

  const record = (outcome: 'success' | 'denied' | 'error' | 'timeout', errorCategory?: string) => {
    audit.write({
      requestId,
      subject: auth.subject,
      ...(auth.clientId ? { clientId: auth.clientId } : {}),
      event: 'tool_call',
      toolName: def.name,
      requiredScope: def.scope,
      rawParams: args,
      outcome,
      durationMs: Date.now() - started,
      ...(errorCategory ? { errorCategory } : {}),
    });
  };

  // Defence in depth: the tool was only registered because the scope matched,
  // but the check is repeated here so a registration bug cannot become an
  // authorization bug.
  if (!auth.scopes.has(def.scope)) {
    record('denied', 'insufficient_scope');
    return {
      ok: false,
      category: 'insufficient_scope',
      message: `This tool requires the ${def.scope} scope, which your access token does not carry.`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const value = await Promise.race([
      def.handler(args, { requestId, subject: auth.subject, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new ToolError('timeout', 'Tool timed out.')));
      }),
    ]);
    record('success');
    return { ok: true, value };
  } catch (err) {
    if (err instanceof ToolError) {
      record(err.category === 'timeout' ? 'timeout' : 'error', err.category);
      return { ok: false, category: err.category, message: err.message };
    }
    // An unexpected exception is logged in full internally and reduced to a
    // stable category on the way out, so no internal path or message escapes.
    logger.error({ err, requestId, tool: def.name }, 'unhandled tool error');
    record('error', 'internal');
    return {
      ok: false,
      category: 'internal',
      message: 'The tool failed unexpectedly. The failure has been recorded in the gateway audit log.',
    };
  } finally {
    clearTimeout(timer);
  }
}

export function createMcpServer(
  cfg: Config,
  registry: ToolRegistry,
  auth: AuthContext,
  requestId: string,
  audit: AuditLog,
  logger: Logger,
): McpServer {
  const permitted = registry.enabled().filter((def) => auth.scopes.has(def.scope));
  const hasElevated = permitted.some((def) => def.risk !== 1);

  const server = new McpServer(SERVER_INFO, {
    instructions: hasElevated ? INSTRUCTIONS + ELEVATED_INSTRUCTIONS : INSTRUCTIONS,
    capabilities: { tools: {} },
  });

  for (const def of permitted) {
    // Annotations are derived from the declared risk level so a write tool can
    // never be advertised as read-only by accident.
    const annotations =
      def.risk === 1
        ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        : { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: (def.inputSchema as unknown as { shape: ZodRawShape }).shape,
        annotations: { title: def.title, ...annotations },
      },
      async (args: unknown) => {
        const result = await invokeTool(def, args ?? {}, cfg, auth, requestId, audit, logger);
        if (!result.ok) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `${result.category}: ${result.message}` }],
          };
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result.value, null, 2) }],
        };
      },
    );
  }

  return server;
}

/** Names of the tools a given token would see, used by /ready diagnostics. */
export function permittedToolNames(registry: ToolRegistry, auth: AuthContext): string[] {
  return registry
    .enabled()
    .filter((def) => auth.scopes.has(def.scope))
    .map((def) => def.name);
}
