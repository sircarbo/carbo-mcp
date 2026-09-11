/**
 * Tool registry.
 *
 * Every tool is declared with the same metadata so that authorization, audit,
 * timeouts and documentation all derive from one place. A tool cannot be
 * registered without a scope and a risk level, which is what stops a
 * convenience helper from quietly becoming an unauthenticated capability.
 */
import { z } from 'zod';
import type { CarboScope } from '../config.js';

/** Matches the four-level classification in docs/TOOLS.md. */
export type RiskLevel = 1 | 2 | 3 | 4;

export interface ToolContext {
  requestId: string;
  subject: string;
  signal: AbortSignal;
}

export interface ToolDefinition<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  title: string;
  /** Shown to the model. States what the tool does *and* what it cannot do. */
  description: string;
  inputSchema: TInput;
  outputSchema: z.ZodTypeAny;
  scope: CarboScope;
  risk: RiskLevel;
  /** Per-tool override of the global tool timeout. */
  timeoutMs?: number;
  /** False keeps the tool out of tools/list entirely. */
  enabled: boolean;
  handler: (input: z.infer<TInput>, ctx: ToolContext) => Promise<unknown>;
}

/**
 * A capability that is deliberately not implemented yet. Declaring it here
 * keeps the future plan reviewable in code rather than only in prose, and
 * guarantees it cannot be called: there is no handler to call.
 */
export interface DeferredTool {
  name: string;
  title: string;
  description: string;
  scope: string;
  risk: RiskLevel;
  reason: string;
  prerequisites: string[];
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private readonly elevated: Set<string>;

  /**
   * `elevated` is the explicit, operator-supplied list of tool names that may
   * be enabled above risk level 1 (MCP_ELEVATED_TOOLS). With the default empty
   * list the registry behaves exactly as before: nothing but Level 1 loads.
   */
  constructor(options: { elevated?: Iterable<string> } = {}) {
    this.elevated = new Set(options.elevated ?? []);
  }

  register<T extends z.ZodTypeAny>(def: ToolDefinition<T>): void {
    if (this.tools.has(def.name)) {
      throw new Error(`duplicate tool registration: ${def.name}`);
    }
    if (def.risk !== 1 && def.enabled && !this.elevated.has(def.name)) {
      throw new Error(
        `tool ${def.name} is risk level ${def.risk}; only level 1 tools may be enabled in this deployment ` +
          '(a tool above level 1 must be named explicitly in MCP_ELEVATED_TOOLS)',
      );
    }
    if (def.risk === 4 && def.enabled) {
      throw new Error(`tool ${def.name} is risk level 4, which cannot be enabled under any configuration`);
    }
    this.tools.set(def.name, def as unknown as ToolDefinition);
  }

  enabled(): ToolDefinition[] {
    return [...this.tools.values()].filter((t) => t.enabled);
  }

  get(name: string): ToolDefinition | undefined {
    const tool = this.tools.get(name);
    return tool?.enabled ? tool : undefined;
  }

  names(): string[] {
    return this.enabled().map((t) => t.name);
  }
}

/** Stable, caller-safe error surface for tool failures. */
export class ToolError extends Error {
  constructor(
    readonly category:
      | 'unavailable'
      | 'stale_data'
      | 'not_found'
      | 'invalid_input'
      | 'timeout'
      | 'internal'
      /** An external service (Kling) answered with a refusal or failure of its own. */
      | 'upstream',
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}
