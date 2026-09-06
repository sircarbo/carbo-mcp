/**
 * Bearer authentication middleware.
 *
 * Failures are audited and answered with a spec-shaped 401/403. The response
 * body carries a stable error code and nothing else -- no internal paths, no
 * exception text, no hint about which part of the token was wrong beyond the
 * category, which the spec requires clients to see.
 */
import type { NextFunction, Request, Response } from 'express';
import { ALL_SCOPES, type Config } from '../config.js';
import type { AuditLog } from '../logging/audit.js';
import type { Logger } from '../logging/logger.js';
import { wwwAuthenticate } from '../auth/metadata.js';
import { AuthError, type AuthContext, type TokenVerifier } from '../auth/tokenVerifier.js';

declare module 'express-serve-static-core' {
  interface Request {
    carboAuth?: AuthContext;
    requestId?: string;
  }
}

export function createAuthMiddleware(
  cfg: Config,
  verifier: TokenVerifier,
  audit: AuditLog,
  logger: Logger,
) {
  return async function authenticate(req: Request, res: Response, next: NextFunction) {
    const started = Date.now();
    const header = req.header('authorization');

    const fail = (err: AuthError, status: 401 | 403) => {
      audit.write({
        requestId: req.requestId ?? 'unknown',
        subject: 'anonymous',
        event: 'auth_failure',
        outcome: 'denied',
        errorCategory: err.code,
        durationMs: Date.now() - started,
        sourceAddress: req.ip,
        userAgent: req.header('user-agent'),
      });
      logger.warn(
        { requestId: req.requestId, code: err.code, sourceAddress: req.ip },
        'authentication rejected',
      );
      res
        .status(status)
        .set('WWW-Authenticate', wwwAuthenticate(cfg, err.oauthError, err.message))
        .json({ error: err.oauthError, error_description: err.message });
    };

    if (!header) {
      return fail(
        new AuthError('missing_token', 'invalid_request', 'authorization header is required'),
        401,
      );
    }

    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match?.[1]) {
      return fail(
        new AuthError('malformed_token', 'invalid_request', 'expected a Bearer token'),
        401,
      );
    }

    try {
      const ctx = await verifier.verify(match[1]);

      // A valid token that carries none of this gateway's scopes is refused
      // outright rather than shown an empty tool list: the caller has proven
      // who they are and has no authority here, which is a 403, not a 200.
      if (ctx.scopes.size === 0) {
        audit.write({
          requestId: req.requestId ?? 'unknown',
          subject: ctx.subject,
          ...(ctx.clientId ? { clientId: ctx.clientId } : {}),
          event: 'auth_failure',
          outcome: 'denied',
          errorCategory: 'insufficient_scope',
          durationMs: Date.now() - started,
          sourceAddress: req.ip,
          userAgent: req.header('user-agent'),
        });
        logger.warn({ requestId: req.requestId, subject: ctx.subject }, 'token carries no gateway scope');
        res
          .status(403)
          .set(
            'WWW-Authenticate',
            wwwAuthenticate(
              cfg,
              'insufficient_scope',
              'token carries none of this resource\'s scopes',
              ALL_SCOPES.join(' '),
            ),
          )
          .json({
            error: 'insufficient_scope',
            error_description: 'Your access token carries none of this gateway\'s scopes.',
          });
        return;
      }

      req.carboAuth = ctx;
      return next();
    } catch (err) {
      if (err instanceof AuthError) return fail(err, 401);
      logger.error({ err, requestId: req.requestId }, 'unexpected error during token verification');
      return fail(
        new AuthError('jwks_unavailable', 'invalid_token', 'token could not be validated'),
        401,
      );
    }
  };
}
