/**
 * CHISMOSO V1.3 — MCP → CHISMOSO ToolRegistry Bridge (Task MCP-2)
 *
 * Bridges MCP tools (exposed by external MCP servers like the official
 * GitHub, Filesystem, Postgres servers) into CHISMOSO's native
 * ToolRegistry, so the ReAct loop and the fixed-plan Orchestrator can
 * call them exactly like the built-in `search_web` / `search_community` /
 * `deepen_content` / `collect_trends` tools.
 *
 * Tool naming:
 *   - Each MCP tool's dotted name `server.tool` (e.g. `github.search_repositories`)
 *     is flattened to `server_tool` (e.g. `github_search_repositories`)
 *     because CHISMOSO's tool names are simple identifiers used as JSON
 *     object keys in LLM prompts.
 *   - The description is prefixed with `[MCP:<server>]` so the LLM can
 *     see at a glance which tools are local vs remote.
 *
 * Result serialization:
 *   - MCP `callTool` returns an array of `content` blocks (text/image/etc).
 *   - For the orchestrator we extract the textual ones, join them, and
 *     also return the raw result under `raw` for callers that want to
 *     inspect structured data.
 *
 * MCP failure handling:
 *   - If `callTool` throws (e.g. server died, invalid args, transport
 *     error), we re-throw — the orchestrator already has try/catch
 *     around tool execution and will record the error in the
 *     investigation's `errors[]` array.
 */

import { mcpRegistry } from './registry.js';
import type { ToolDefinition } from '../orchestrator/tools.js';
import { ErrorCode } from '../errors.js';

// ---------------------------------------------------------------------------
// MCP TOOL → CHISMOSO ToolDefinition
// ---------------------------------------------------------------------------

/**
 * Builds CHISMOSO ToolDefinitions for every connected MCP tool. The
 * orchestrator can register these alongside its native tools. Each call
 * routes to `mcpRegistry.callTool(fullName, args)`.
 *
 * §23 compliance: MCP-bridged tools are categorised as EXTERNAL (they
 * cross process boundaries), risk=medium (we cannot audit their
 * behaviour), side_effects=external_call, allowedInModes=['react',
 * 'mcp_client', 'autonomous'] (NOT 'sync' — the fixed-plan orchestrator
 * does not invoke MCP tools). Their timeout_ms is set to a generous 30s
 * because MCP servers may legitimately take longer than the native
 * provider tools.
 *
 * NOTE: returns a fresh array on each call, but the tool `execute`
 * closures read the live registry at call time — so a tool registered
 * before the underlying MCP server disconnects will throw a clear
 * "not connected" error instead of silently no-op'ing.
 */
export function getMCPToolDefinitions(): ToolDefinition<any, any>[] {
  const mcpTools = mcpRegistry.getAllTools();
  return mcpTools.map((mcpTool) => {
    const flatName = mcpTool.fullName.replace(/\./g, '_');
    const description =
      `[MCP:${mcpTool.serverName}] ` +
      (mcpTool.description ?? mcpTool.toolName);
    return {
      id: `chismoso.tool.mcp.${flatName}.v1`,
      name: flatName,
      description,
      purpose: `Invoke remote MCP tool ${mcpTool.fullName} on server ${mcpTool.serverName}.`,
      category: ['EXTERNAL' as const],
      permissions: {
        categories: ['EXTERNAL' as const],
        allowedInModes: ['react' as const, 'mcp_client' as const, 'autonomous' as const],
      },
      risk: 'medium' as const,
      side_effects: 'external_call' as const,
      timeout_ms: 30_000,
      retry_policy: {
        maxRetries: 1,
        baseDelayMs: 1000,
        backoffMultiplier: 2,
        retryableErrors: [ErrorCode.TEMPORARY_FAILURE, ErrorCode.TIMEOUT],
      },
      evidence_behavior: 'none' as const,
      audit_behavior: 'logged' as const,
      async execute(args: any) {
        const result = await mcpRegistry.callTool(mcpTool.fullName, args);
        // MCP returns `{ content: [{ type: 'text', text: '...' }, ...], ... }`.
        // For the orchestrator we want a textual blob it can feed back to
        // the LLM in the next iteration. Non-text blocks are skipped.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const contentArr = Array.isArray(result?.content) ? result.content : [];
        const text = contentArr
          .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
          .filter((t: string) => t.length > 0)
          .join('\n');
        const serialized = text.length > 0 ? text : JSON.stringify(result);
        return { result: serialized, raw: result };
      },
    } satisfies ToolDefinition<any, any>;
  });
}

// ---------------------------------------------------------------------------
// REGISTRATION HELPER
// ---------------------------------------------------------------------------

/**
 * Registers all currently-connected MCP tools with the given
 * CHISMOSO ToolRegistry. Returns the count of tools registered.
 *
 * Call this during orchestrator initialization (after MCP servers are
 * connected via `mcpRegistry.connectAll()`).
 *
 * Idempotent in the sense that re-calling it will re-register the same
 * tool names (overwriting prior definitions) — safe to call from a
 * scheduler tick.
 */
export function registerMCPTools(toolRegistry: {
  register: (tool: ToolDefinition<any, any>) => void;
}): number {
  const tools = getMCPToolDefinitions();
  for (const tool of tools) {
    toolRegistry.register(tool);
  }
  return tools.length;
}
