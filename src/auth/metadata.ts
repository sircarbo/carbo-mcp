/**
 * RFC 9728 protected resource metadata.
 *
 * This is the document an MCP client fetches after a 401 to discover which
 * authorization server it should send the user to. It is intentionally the
 * only unauthenticated endpoint that reveals anything about the auth setup,
 * and it reveals nothing beyond what the spec requires.
 */
import type { Config } from '../config.js';
import { ALL_SCOPES } from '../config.js';

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
}

/** Canonical location of the metadata document for this resource. */
export function protectedResourceMetadataUrl(cfg: Config): string {
  const path = new URL(cfg.resourceIdentifier).pathname.replace(/\/$/, '');
  return `${cfg.publicOrigin}/.well-known/oauth-protected-resource${path}`;
}

export function protectedResourceMetadata(cfg: Config): ProtectedResourceMetadata {
  return {
    resource: cfg.resourceIdentifier,
    authorization_servers: [cfg.issuer],
    scopes_supported: [...ALL_SCOPES],
    bearer_methods_supported: ['header'],
  };
}

/**
 * Builds the WWW-Authenticate value that points a client at the metadata
 * document above. Getting this header right is what makes the Claude.ai
 * connector able to start its OAuth flow on its own.
 */
export function wwwAuthenticate(
  cfg: Config,
  error?: string,
  description?: string,
  requiredScope?: string,
): string {
  // RFC 9728 inserts the resource's path after the well-known segment. Our
  // resource is <origin>/mcp, so the metadata document is at
  // <origin>/.well-known/oauth-protected-resource/mcp -- pointing a client at
  // the bare path would send it somewhere the spec does not put the document.
  const parts = [
    `Bearer realm="carbo-mcp"`,
    `resource_metadata="${protectedResourceMetadataUrl(cfg)}"`,
  ];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  if (requiredScope) parts.push(`scope="${requiredScope}"`);
  return parts.join(', ');
}
