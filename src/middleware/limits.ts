/**
 * Request-level safety limits: body size, wall-clock timeout, and rate limits.
 *
 * Rate limiting keys on the authenticated subject where one exists, so one
 * noisy user cannot exhaust another's budget, and falls back to the source
 * address for unauthenticated traffic (which is where abuse actually arrives).
 */
import type { NextFunction, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';
import type { Config } from '../config.js';
import type { AuditLog } from '../logging/audit.js';
import type { Logger } from '../logging/logger.js';

export function requestTimeout(cfg: Config, logger: Logger) {
  return function timeout(req: Request, res: Response, next: NextFunction): void {
    // Streamable HTTP responses are long-lived by design, so the guard is armed
    // only until headers are sent; after that the stream owns its own lifetime.
    const timer = setTimeout(() => {
      if (res.headersSent) return;
      logger.warn({ requestId: req.requestId, path: req.path }, 'request timed out');
      res.status(504).json({ error: 'request_timeout' });
    }, cfg.requestTimeoutMs);
    timer.unref();

    const clear = () => clearTimeout(timer);
    res.on('finish', clear);
    res.on('close', clear);
    next();
  };
}

function limiterOptions(
  cfg: Config,
  max: number,
  audit: AuditLog,
  logger: Logger,
): Partial<Options> {
  return {
    windowMs: cfg.rateLimitWindowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Authenticated callers are bucketed per subject. Unauthenticated traffic
    // falls back to the source address via the library's own helper, which
    // masks IPv6 to a /64 -- keying on the raw address would let a caller with
    // any ordinary IPv6 allocation rotate through addresses to evade the limit.
    keyGenerator: (req: Request) =>
      req.carboAuth?.subject ?? `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`,
    handler: (req: Request, res: Response) => {
      audit.write({
        requestId: req.requestId ?? 'unknown',
        subject: req.carboAuth?.subject ?? 'anonymous',
        event: 'rate_limit',
        outcome: 'rate_limited',
        sourceAddress: req.ip,
        userAgent: req.header('user-agent'),
      });
      logger.warn(
        { requestId: req.requestId, subject: req.carboAuth?.subject ?? 'anonymous' },
        'rate limit exceeded',
      );
      res.status(429).json({ error: 'rate_limited' });
    },
  };
}

/** Applied after authentication, keyed on subject. */
export function toolRateLimiter(cfg: Config, audit: AuditLog, logger: Logger) {
  return rateLimit(limiterOptions(cfg, cfg.rateLimitMax, audit, logger));
}

/** Applied before authentication, keyed on source address. Tighter budget. */
export function unauthenticatedRateLimiter(cfg: Config, audit: AuditLog, logger: Logger) {
  return rateLimit(limiterOptions(cfg, cfg.authRateLimitMax, audit, logger));
}
