/**
 * HTTP entry point.
 *
 * Route surface, and why each one is where it is:
 *   GET  /health                              unauthenticated liveness, minimal detail
 *   GET  /ready                               unauthenticated readiness, snapshot ages only
 *   GET  /.well-known/oauth-protected-resource  RFC 9728 discovery, must be public
 *   POST /mcp                                 the MCP endpoint, always authenticated
 *   GET|DELETE /mcp                            405 -- stateless transport has no session to resume
 *
 * Nothing else is served. There is no static directory, no index, no admin
 * surface and no error page that reveals a path.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { describeConfig, loadConfig, type Config } from '../config.js';
import { createLogger, type Logger } from '../logging/logger.js';
import { AuditLog } from '../logging/audit.js';
import { TokenVerifier } from '../auth/tokenVerifier.js';
import { protectedResourceMetadata, wwwAuthenticate } from '../auth/metadata.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { correlationId } from '../middleware/correlation.js';
import { requestTimeout, toolRateLimiter, unauthenticatedRateLimiter } from '../middleware/limits.js';
import { SnapshotReader, type SnapshotName } from '../adapters/snapshots.js';
import { ToolRegistry } from '../tools/registry.js';
import { buildTools } from '../tools/definitions.js';
import { createMcpServer, SERVER_INFO } from './mcpServer.js';
import { auditProtocolRequest } from './protocolAudit.js';

/** Snapshots that must be present and fresh for the gateway to call itself ready. */
const READINESS_SNAPSHOTS: SnapshotName[] = ['system', 'containers', 'services'];

export function createApp(
  cfg: Config,
  logger: Logger,
  audit: AuditLog,
  registry: ToolRegistry,
  snapshots: SnapshotReader,
  verifier: TokenVerifier,
) {
  const app = express();

  // Exactly one proxy hop is expected (nginx on the VPS). Trusting a fixed
  // number rather than `true` keeps X-Forwarded-For from being spoofable into
  // the rate limiter's key.
  app.set('trust proxy', cfg.trustProxyHops);
  app.disable('x-powered-by');
  app.disable('etag');

  app.use(correlationId);
  app.use(requestTimeout(cfg, logger));
  app.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  // ------------------------------------------------------------- liveness

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: SERVER_INFO.name,
      version: SERVER_INFO.version,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/ready', (_req: Request, res: Response) => {
    const { ready, details } = snapshots.readiness(READINESS_SNAPSHOTS);
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      service: SERVER_INFO.name,
      snapshots: details,
      tools_enabled: registry.names().length,
      timestamp: new Date().toISOString(),
    });
  });

  // ------------------------------------------------------------- discovery

  const metadata = (_req: Request, res: Response) => {
    res.status(200).json(protectedResourceMetadata(cfg));
  };
  app.get('/.well-known/oauth-protected-resource', metadata);
  // Path-suffixed form, which clients use when the resource lives under a path.
  app.get('/.well-known/oauth-protected-resource/mcp', metadata);

  // ------------------------------------------------------------------ mcp

  const authenticate = createAuthMiddleware(cfg, verifier, audit, logger);

  app.post(
    '/mcp',
    unauthenticatedRateLimiter(cfg, audit, logger),
    express.json({ limit: cfg.maxRequestBodyBytes }),
    authenticate,
    toolRateLimiter(cfg, audit, logger),
    async (req: Request, res: Response) => {
      const auth = req.carboAuth!;
      const requestId = req.requestId!;

      // Records initialize / tools/list, and any protocol message the transport
      // rejects before a handler sees it. Tool calls audit themselves, with more
      // detail, from inside the handler wrapper.
      auditProtocolRequest(req, res, auth, requestId, audit);

      const transport = new StreamableHTTPServerTransport({
        // Stateless: no session id, nothing retained between requests.
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      const server = createMcpServer(cfg, registry, auth, requestId, audit, logger);

      res.on('close', () => {
        void transport.close();
        void server.close();
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        logger.error({ err, requestId }, 'MCP request handling failed');
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          });
        }
      }
    },
  );

  // The stateless transport cannot resume a stream or delete a session.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).set('Allow', 'POST').json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. This endpoint accepts POST only.' },
      id: null,
    });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  // ----------------------------------------------------------- fallbacks

  app.use((req: Request, res: Response) => {
    // A 404 body that says nothing about what does exist.
    if (req.path.startsWith('/mcp')) {
      res.set('WWW-Authenticate', wwwAuthenticate(cfg));
    }
    res.status(404).json({ error: 'not_found' });
  });

  // Express 5 error handler. Body-parser size and syntax failures land here.
  app.use((err: Error & { type?: string; status?: number }, req: Request, res: Response, _next: NextFunction) => {
    const requestId = req.requestId ?? 'unknown';
    if (err.type === 'entity.too.large') {
      logger.warn({ requestId }, 'request body exceeded limit');
      res.status(413).json({ error: 'payload_too_large' });
      return;
    }
    if (err.type === 'entity.parse.failed') {
      logger.warn({ requestId }, 'request body was not valid JSON');
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    logger.error({ err, requestId }, 'unhandled request error');
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

async function main(): Promise<void> {
  let cfg: Config;
  const bootLogger = createLogger(process.env.MCP_LOG_LEVEL ?? 'info');
  try {
    cfg = loadConfig();
  } catch (err) {
    bootLogger.fatal({ err: (err as Error).message }, 'configuration validation failed');
    process.exit(78); // EX_CONFIG
  }

  const logger = createLogger(cfg.logLevel);
  const audit = new AuditLog(cfg.auditDir, cfg.auditMaxFileBytes, cfg.auditMaxFiles, logger);
  audit.init();

  const snapshots = new SnapshotReader(cfg.snapshotDir, cfg.snapshotMaxAgeSeconds);
  const registry = new ToolRegistry();
  for (const tool of buildTools({ snapshots, audit })) registry.register(tool);

  const verifier = new TokenVerifier({
    jwksUri: cfg.jwksUri,
    expectedIssuer: cfg.expectedIssuer ?? cfg.issuer,
    expectedAudience: cfg.resourceIdentifier,
    clockToleranceSeconds: cfg.clockToleranceSeconds,
    allowedSubjects: cfg.allowedSubjects,
  });

  const app = createApp(cfg, logger, audit, registry, snapshots, verifier);
  const server = app.listen(cfg.port, cfg.bindHost, () => {
    logger.info(
      { config: describeConfig(cfg), tools: registry.names() },
      'carbo-mcp-gateway listening',
    );
    audit.write({
      requestId: 'startup',
      subject: 'system',
      event: 'startup',
      outcome: 'success',
    });
  });

  server.headersTimeout = cfg.requestTimeoutMs + 5000;
  server.requestTimeout = cfg.requestTimeoutMs + 5000;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    audit.write({ requestId: 'shutdown', subject: 'system', event: 'shutdown', outcome: 'success' });

    // Stop accepting new work, let in-flight requests finish, then give up.
    server.close(() => {
      audit.close();
      logger.info('shutdown complete');
      process.exit(0);
    });
    setTimeout(() => {
      logger.warn('forcing shutdown after grace period');
      audit.close();
      process.exit(0);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    shutdown('uncaughtException');
  });
}

// Only run when executed directly, so tests can import createApp.
const invokedDirectly = process.argv[1]?.endsWith('index.js') ?? false;
if (invokedDirectly) {
  void main();
}
