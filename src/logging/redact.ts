/**
 * Redaction applied to everything that leaves this process -- log lines, audit
 * records, and tool output alike.
 *
 * The rule enforced here is deliberately blunt: it is better to redact a
 * harmless string than to leak one credential. Patterns are checked against
 * both keys (a field literally named `password`) and values (a string that
 * looks like a JWT regardless of what it is called).
 */

/** Field names whose value is always replaced, no matter what it contains. */
const SENSITIVE_KEY_PATTERN =
  /(pass(word|wd|phrase)?|pwd|secret|token|key|api[-_]?key|apikey|access[-_]?key|auth(orization)?|credential|private[-_]?key|client[-_]?secret|cookie|session|bearer|salt|signature|cert|otp|pin|ssn|dob)/i;

/** Value shapes that are redacted wherever they appear. */
const VALUE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi },
  { name: 'basic', re: /\bBasic\s+[A-Za-z0-9+/]{8,}=*/gi },
  { name: 'pem', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'ssh-key', re: /\bssh-(rsa|ed25519|dss)\s+[A-Za-z0-9+/]{20,}=*/g },
  { name: 'aws-key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    name: 'env-assignment',
    re: /\b([A-Za-z0-9_.-]*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|KEY|CREDENTIAL|AUTH|CERT|SALT|SIGNATURE|SESSION|COOKIE))\s*[=:]\s*\S+/gi,
  },
  // Any SHOUTY_ENV_VAR=value loses its value, keyword or not. The suffix rule
  // above misses names like TOS_ACCESS_KEY_ID, which ends in "ID".
  { name: 'shouty-assignment', re: /\b([A-Z][A-Z0-9_]{3,})\s*=\s*(\S+)/g },
  // Long opaque strings are treated as credentials on sight: a false positive
  // costs a redacted word, a false negative costs a leaked key.
  { name: 'opaque-blob', re: /\b[A-Za-z0-9+_-]{40,}={0,2}\b/g },
  { name: 'url-credentials', re: /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi },
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

export const REDACTED = '[redacted]';

/** Redacts credential-shaped substrings inside a single string. */
export function redactString(input: string): string {
  let out = input;
  for (const { name, re } of VALUE_PATTERNS) {
    re.lastIndex = 0;
    if (name === 'url-credentials') {
      out = out.replace(re, (_m, scheme: string) => `${scheme}${REDACTED}@`);
    } else if (name === 'env-assignment' || name === 'shouty-assignment') {
      out = out.replace(re, (_m, key: string) => `${key}=${REDACTED}`);
    } else {
      out = out.replace(re, REDACTED);
    }
  }
  return out;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * Deep-redacts an arbitrary value. Cycles are broken, depth and breadth are
 * bounded so a hostile or malformed structure cannot cause unbounded work.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 8) return '[truncated: depth]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return '[unsupported]';

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[circular]';
    seen.add(value as object);

    if (Array.isArray(value)) {
      const limited = value.slice(0, 200).map((v) => redact(v, depth + 1, seen));
      if (value.length > 200) limited.push(`[truncated: ${value.length - 200} more]`);
      return limited;
    }

    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (count++ >= 100) {
        out['[truncated]'] = 'additional keys omitted';
        break;
      }
      out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1, seen);
    }
    return out;
  }
  return '[unsupported]';
}

/**
 * Produces a short, safe description of tool arguments for the audit trail:
 * key names with value *shapes*, never the values themselves.
 */
export function summarizeParams(params: unknown): Record<string, string> {
  if (params === null || params === undefined || typeof params !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (isSensitiveKey(k)) {
      out[k] = REDACTED;
    } else if (typeof v === 'string') {
      out[k] = `string(${v.length})`;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = String(v);
    } else if (Array.isArray(v)) {
      out[k] = `array(${v.length})`;
    } else if (v === null) {
      out[k] = 'null';
    } else if (typeof v === 'object') {
      out[k] = `object(${Object.keys(v as object).length})`;
    } else {
      out[k] = typeof v;
    }
  }
  return out;
}
