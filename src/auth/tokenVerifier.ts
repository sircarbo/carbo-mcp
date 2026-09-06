/**
 * OAuth 2.1 resource-server token validation.
 *
 * This is the resource-server half of the MCP authorization spec only. The
 * gateway never issues, refreshes, or stores tokens -- Keycloak does that.
 * Here we do exactly what a resource server must: fetch the authorization
 * server's public keys, verify the signature, and check every claim that
 * bounds the token's authority (issuer, audience, expiry, not-before, and the
 * scopes the caller actually holds).
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { ALL_SCOPES, type CarboScope } from '../config.js';

export type AuthErrorCode =
  | 'missing_token'
  | 'malformed_token'
  | 'invalid_signature'
  | 'invalid_issuer'
  | 'invalid_audience'
  | 'expired_token'
  | 'not_yet_valid'
  | 'subject_not_allowed'
  | 'jwks_unavailable';

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    /** Value for the `error` parameter of WWW-Authenticate. */
    readonly oauthError: 'invalid_token' | 'invalid_request' | 'insufficient_scope',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface AuthContext {
  subject: string;
  clientId?: string;
  scopes: Set<string>;
  issuer: string;
  audience: string[];
  expiresAt: number;
  /** Preferred display name if the token carries one. Never an email address. */
  username?: string;
}

export interface TokenVerifierOptions {
  jwksUri: string;
  expectedIssuer: string;
  expectedAudience: string;
  clockToleranceSeconds: number;
  allowedSubjects: string[];
}

function toArray(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/**
 * Splits the space-delimited `scope` claim, falling back to Keycloak's
 * `scp` array form. Only scopes this gateway knows about are retained, so an
 * unrelated scope from another audience can never satisfy a tool check.
 */
export function extractScopes(payload: JWTPayload): Set<string> {
  const raw = new Set<string>();
  if (typeof payload.scope === 'string') {
    for (const s of payload.scope.split(/\s+/).filter(Boolean)) raw.add(s);
  }
  for (const s of toArray((payload as Record<string, unknown>).scp)) raw.add(s);

  const known = new Set<string>(ALL_SCOPES as readonly string[]);
  return new Set([...raw].filter((s) => known.has(s)));
}

export class TokenVerifier {
  private jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly opts: TokenVerifierOptions) {
    this.jwks = createRemoteJWKSet(new URL(opts.jwksUri), {
      // Bound how often a token with an unknown `kid` can force an outbound
      // fetch, so an attacker cannot use us to hammer the auth server.
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
      timeoutDuration: 5_000,
    });
  }

  /** Verifies a bearer token and returns the caller's identity and scopes. */
  async verify(token: string): Promise<AuthContext> {
    if (!token || token.split('.').length !== 3) {
      throw new AuthError('malformed_token', 'invalid_token', 'token is not a well-formed JWS');
    }

    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, this.jwks, {
        issuer: this.opts.expectedIssuer,
        audience: this.opts.expectedAudience,
        clockTolerance: this.opts.clockToleranceSeconds,
        algorithms: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'PS256'],
      });
      payload = result.payload;
    } catch (err) {
      throw mapJoseError(err);
    }

    if (!payload.sub) {
      throw new AuthError('malformed_token', 'invalid_token', 'token has no subject');
    }
    if (
      this.opts.allowedSubjects.length > 0 &&
      !this.opts.allowedSubjects.includes(payload.sub)
    ) {
      throw new AuthError('subject_not_allowed', 'invalid_token', 'subject is not permitted');
    }

    const clientId =
      typeof payload.azp === 'string'
        ? payload.azp
        : typeof (payload as Record<string, unknown>).client_id === 'string'
          ? ((payload as Record<string, unknown>).client_id as string)
          : undefined;

    const username =
      typeof (payload as Record<string, unknown>).preferred_username === 'string'
        ? ((payload as Record<string, unknown>).preferred_username as string)
        : undefined;

    return {
      subject: payload.sub,
      ...(clientId ? { clientId } : {}),
      ...(username ? { username } : {}),
      scopes: extractScopes(payload),
      issuer: String(payload.iss),
      audience: toArray(payload.aud),
      expiresAt: payload.exp ?? 0,
    };
  }
}

/**
 * Translates a jose failure into a stable category. The original message is
 * deliberately discarded: it can echo token contents back to the caller.
 */
function mapJoseError(err: unknown): AuthError {
  const code = (err as { code?: string })?.code ?? '';
  switch (code) {
    case 'ERR_JWT_EXPIRED':
      return new AuthError('expired_token', 'invalid_token', 'token has expired');
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED': {
      const claim = (err as { claim?: string }).claim;
      if (claim === 'iss') return new AuthError('invalid_issuer', 'invalid_token', 'unexpected issuer');
      if (claim === 'aud') return new AuthError('invalid_audience', 'invalid_token', 'token audience does not include this resource');
      if (claim === 'nbf') return new AuthError('not_yet_valid', 'invalid_token', 'token is not yet valid');
      return new AuthError('malformed_token', 'invalid_token', 'token claim validation failed');
    }
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
    case 'ERR_JWKS_NO_MATCHING_KEY':
      return new AuthError('invalid_signature', 'invalid_token', 'token signature could not be verified');
    case 'ERR_JWKS_TIMEOUT':
    case 'ERR_JWKS_MULTIPLE_MATCHING_KEYS':
      return new AuthError('jwks_unavailable', 'invalid_token', 'key set could not be resolved');
    default:
      return new AuthError('malformed_token', 'invalid_token', 'token could not be validated');
  }
}

export function hasScope(ctx: AuthContext, required: CarboScope): boolean {
  return ctx.scopes.has(required);
}
