/**
 * CHISMOSO V1.3 — MCP Server (Task MCP-1)
 *
 * Wires the 8 MCP tools, 6 resources, and 3 prompts declared in `tools.ts`,
 * `resources.ts`, and `prompts.ts` into a single `Server` instance from
 * `@modelcontextprotocol/sdk`.
 *
 * Exports:
 *   - createChismosoMCPServer(deps) — returns a configured `Server` (no
 *     transport attached yet). Use this if you want to plug the server
 *     into a non-stdio transport (HTTP, in-memory, etc.).
 *   - startStdioServer(deps) — connects the server to a StdioServerTransport
 *     and runs forever (or until the transport closes).
 *
 * Handler behaviour:
 *   - ListToolsRequestSchema     → returns the 8 chismoso_* tools as MCP Tool[]
 *   - CallToolRequestSchema      → dispatches by name, executes the handler,
 *                                  serialises the result as JSON text content.
 *                                  Tool errors are returned with `isError:true`
 *                                  (NOT thrown) so the LLM can see them.
 *   - ListResourcesRequestSchema → returns 5 static resources + 1 resource
 *                                  template (chismoso://investigations/{id}).
 *   - ReadResourceRequestSchema  → dispatches by URI, returns JSON text.
 *   - ListPromptsRequestSchema   → returns 3 prompt templates.
 *   - GetPromptRequestSchema     → renders the named prompt, returns user
 *                                  message(s).
 *
 * Transport:
 *   stdio is the default and the only one wired by `startStdioServer`.
 *   HTTP transport is out of scope here — Claude Desktop and Cursor both
 *   use stdio, and HTTP servers are typically reverse-proxied by the host
 *   app (e.g. via Caddy), which is the project's gateway pattern.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  CHISMOSO_MCP_TOOLS,
  getToolByName,
  type ChismosoMCPServerDeps,
} from './tools.js';
import {
  CHISMOSO_MCP_RESOURCES,
  readChismosoResource,
} from './resources.js';
import { CHISMOSO_MCP_PROMPTS, getPromptByName } from './prompts.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// SERVER CONSTANTS
// ---------------------------------------------------------------------------

const SERVER_NAME = 'chismoso-mcp-server';
const SERVER_VERSION = '1.3.0';

// ---------------------------------------------------------------------------
// FACTORY
// ---------------------------------------------------------------------------

/**
 * Build a CHISMOSO MCP `Server` instance with all request handlers wired.
 *
 * The returned server is NOT connected to a transport — the caller is
 * responsible for picking a transport (stdio / HTTP / in-memory) and
 * calling `await server.connect(transport)`.
 *
 * `deps` carries the collaborators each tool/resource needs to talk to
 * CHISMOSO's domain layer (DB, Repositories, ProviderRegistry, etc.).
 * The same `deps` instance is shared across all calls — safe because:
 *   - SQLite (better-sqlite3) is synchronous and single-threaded.
 *   - Repositories are stateless wrappers around the DB.
 *   - ProviderRegistry providers are stateless after construction.
 */
export function createChismosoMCPServer(deps: ChismosoMCPServerDeps): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      },
      instructions:
        'CHISMOSO MCP server — exposes intelligence capabilities (investigate, ' +
        'semantic search, anomalies, opportunities, etc.) to LLM clients. All ' +
        'tools return JSON. chismoso_investigate is the only non-idempotent ' +
        'tool — it creates new investigation records.',
    },
  );

  // -------------------------------------------------------------------------
  // TOOLS
  // -------------------------------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: CHISMOSO_MCP_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    const tool = getToolByName(name);

    if (!tool) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `unknown_tool`,
              message: `No MCP tool named "${name}" is registered on the CHISMOSO server.`,
              availableTools: CHISMOSO_MCP_TOOLS.map((t) => t.name),
            }),
          },
        ],
      };
    }

    try {
      const result = await tool.execute(args, deps);
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return {
        content: [{ type: 'text' as const, text }],
      };
    } catch (e: any) {
      logger.warn('MCP tool execution failed', { tool: name, err: e?.message ?? String(e) });
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'tool_execution_failed',
              tool: name,
              message: e?.message ?? String(e),
            }),
          },
        ],
      };
    }
  });

  // -------------------------------------------------------------------------
  // RESOURCES
  // -------------------------------------------------------------------------

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: CHISMOSO_MCP_RESOURCES.resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      })),
    };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return {
      resourceTemplates: CHISMOSO_MCP_RESOURCES.resourceTemplates.map((t) => ({
        uriTemplate: t.uriTemplate,
        name: t.name,
        description: t.description,
        mimeType: t.mimeType,
      })),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    try {
      const data = await readChismosoResource(uri, deps);
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (e: any) {
      // MCP resource read errors are returned as JSON-RPC error responses
      // (the spec doesn't define an inline "isError" flag for resources).
      throw new Error(`Failed to read resource ${uri}: ${e?.message ?? String(e)}`);
    }
  });

  // -------------------------------------------------------------------------
  // PROMPTS
  // -------------------------------------------------------------------------

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: CHISMOSO_MCP_PROMPTS.map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments,
      })),
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, string>;
    const prompt = getPromptByName(name);
    if (!prompt) {
      throw new Error(`Unknown MCP prompt: ${name}`);
    }
    const messages = await prompt.render(args, deps);
    return {
      description: prompt.description,
      messages,
    };
  });

  return server;
}

// ---------------------------------------------------------------------------
// STDIO ENTRY POINT
// ---------------------------------------------------------------------------

/**
 * Redirect `console.log` / `console.info` / `console.warn` to STDERR.
 *
 * The MCP stdio protocol reserves STDOUT for JSON-RPC 2.0 messages — any
 * stray `console.log` line (e.g. from CHISMOSO's own logger.info calls,
 * better-sqlite3 warnings, or third-party deps) would corrupt the protocol
 * stream and cause the MCP client to disconnect.
 *
 * This redirect MUST be called before any code that might log — i.e.
 * before `new ChismosoDB(...)` and before `new Server(...)` connect.
 *
 * `console.error` already writes to STDERR and is left untouched. The
 * original `console.log` is NOT restored — once we enter MCP stdio mode,
 * we stay there until the process exits.
 *
 * Idempotent: calling it more than once is a no-op.
 */
export function redirectConsoleToStderr(): void {
  const writeLine = (args: unknown[]): void => {
    const line = args
      .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
      .join(' ');
    process.stderr.write(line + '\n');
  };
  console.log = (...args: unknown[]) => writeLine(args);
  console.info = (...args: unknown[]) => writeLine(args);
  console.warn = (...args: unknown[]) => writeLine(args);
  // console.error already targets stderr — leave it.
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Start the CHISMOSO MCP server on stdio. Blocks until the transport closes
 * (i.e. until the parent process closes stdin — usually when the MCP client
 * disconnects or the user quits the host app).
 *
 * Logging:
 *   All CHISMOSO logger output goes to STDERR — stdout is reserved for
 *   the JSON-RPC protocol itself (mixing logs into stdout would corrupt
 *   the protocol stream). This matches the MCP spec recommendation.
 *
 * IMPORTANT: callers MUST call `redirectConsoleToStderr()` BEFORE
 *   constructing the deps passed in (ChismosoDB, Repositories, etc.),
 *   because those constructors log on init. The redirect is idempotent
 *   but must run first to be effective.
 */
export async function startStdioServer(deps: ChismosoMCPServerDeps): Promise<void> {
  const server = createChismosoMCPServer(deps);
  const transport = new StdioServerTransport();

  transport.onerror = (err) => {
    logger.error('MCP stdio transport error', { err: err.message });
  };
  transport.onclose = () => {
    logger.info('MCP stdio transport closed');
  };

  logger.info('Starting CHISMOSO MCP server (stdio)', {
    server: SERVER_NAME,
    version: SERVER_VERSION,
    tools: CHISMOSO_MCP_TOOLS.length,
    resources: CHISMOSO_MCP_RESOURCES.resources.length,
    resourceTemplates: CHISMOSO_MCP_RESOURCES.resourceTemplates.length,
    prompts: CHISMOSO_MCP_PROMPTS.length,
  });

  await server.connect(transport);

  // The transport keeps the process alive on its own — but we also keep
  // this promise pending so callers awaiting `startStdioServer` don't see
  // an early return that could cause `process.exit(0)` to fire. The
  // process exits when stdin closes (handled by the transport).
  await new Promise<void>((resolve) => {
    transport.onclose = () => {
      logger.info('MCP server exiting');
      resolve();
    };
  });
}
