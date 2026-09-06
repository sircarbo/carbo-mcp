/**
 * Structured application logging.
 *
 * Every record is JSON on stdout so the Docker log driver and any future log
 * shipper get machine-readable events. The redaction serializer runs on the
 * whole record, which means a caller cannot accidentally log a token by
 * putting it somewhere unexpected in the object.
 */
import pino from 'pino';
import { redact } from './redact.js';

export type Logger = pino.Logger;

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'carbo-mcp-gateway' },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'message',
    formatters: {
      level: (label) => ({ level: label }),
      // Belt and braces: pino's own redact paths plus a full deep sweep.
      log: (obj) => redact(obj) as Record<string, unknown>,
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        'headers.cookie',
        'token',
        'access_token',
        'client_secret',
      ],
      censor: '[redacted]',
    },
  });
}
