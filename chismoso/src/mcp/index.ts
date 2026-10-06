/**
 * CHISMOSO V1.3 — MCP Server barrel (Task MCP-1)
 *
 * Single import surface for everything related to running CHISMOSO as an
 * MCP server (inbound — exposing CHISMOSO to LLM clients like Claude
 * Desktop / Cursor / Continue.dev).
 *
 * For the outbound direction (CHISMOSO consuming other MCP servers), see
 * the sibling files `client.ts`, `registry.ts`, `bridge.ts` — those are
 * imported by `src/cli.ts` and the orchestrator init path.
 */

// Inbound MCP server (this task) — server.ts, tools.ts, resources.ts, prompts.ts
export * from './tools.js';
export * from './resources.js';
export * from './prompts.js';
export { createChismosoMCPServer, startStdioServer } from './server.js';

// Outbound MCP client (Task MCP-2) — re-exported for convenience so callers
// can `import { mcpRegistry, connectToMCPServer, registerMCPTools } from '@/mcp'`.
export * from './client.js';
export * from './registry.js';
export * from './bridge.js';
