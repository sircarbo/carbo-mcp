/**
 * Per-request correlation id.
 *
 * A client-supplied id is accepted only if it is short and alphanumeric --
 * otherwise a hostile value would end up in the audit trail and in response
 * headers. Anything else is replaced with a fresh UUID.
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function correlationId(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.header('x-request-id');
  req.requestId = supplied && SAFE_ID.test(supplied) ? supplied : randomUUID();
  res.set('X-Request-Id', req.requestId);
  next();
}
