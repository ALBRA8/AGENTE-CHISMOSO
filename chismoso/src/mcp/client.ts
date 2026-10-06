/**
 * CHISMOSO V1.3 — MCP Client Wrapper (Task MCP-2)
 *
 * Thin wrapper around @modelcontextprotocol/sdk that:
 *   - Creates a Client with CHISMOSO's identity.
 *   - Selects the right transport (StdioClientTransport for subprocesses,
 *     StreamableHTTPClientTransport for HTTP/SSE endpoints).
 *   - Lists tools + resources immediately after connect, so the registry
 *     can expose them without another round-trip.
 *
 * All public functions return plain objects (no Client internals leak)
 * except `ConnectedMCPServer.client`, which is needed for tool calls.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { MCPServerConfig } from '../mesh/mcp-config.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

export interface MCPToolDescriptor {
  name: string;
  description?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: any;
}

export interface MCPResourceDescriptor {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface ConnectedMCPServer {
  name: string;
  config: MCPServerConfig;
  client: Client;
  tools: MCPToolDescriptor[];
  resources: MCPResourceDescriptor[];
  connectedAt: number;
}

// ---------------------------------------------------------------------------
// CONNECT
// ---------------------------------------------------------------------------

export async function connectToMCPServer(
  name: string,
  config: MCPServerConfig,
): Promise<ConnectedMCPServer> {
  const client = new Client(
    { name: 'chismoso-mcp-client', version: '1.3.0' },
    { capabilities: {} },
  );

  let transport;
  if (config.transport === 'stdio') {
    if (!config.command) {
      throw new Error(`MCP server "${name}" (stdio) requires a non-empty command`);
    }
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
    });
  } else if (config.transport === 'http') {
    if (!config.url) {
      throw new Error(`MCP server "${name}" (http) requires a non-empty url`);
    }
    const url = new URL(config.url);
    // Heuristic: if the URL ends with /sse, use SSEClientTransport
    // (older MCP servers), otherwise use the newer StreamableHTTP transport.
    if (config.url.endsWith('/sse') || config.url.includes('/sse')) {
      transport = new SSEClientTransport(url);
    } else {
      transport = new StreamableHTTPClientTransport(url);
    }
  } else {
    throw new Error(`MCP server "${name}" has invalid transport "${(config as any).transport}"`);
  }

  await client.connect(transport);

  // List tools + resources eagerly so the registry can expose them.
  // Errors here are non-fatal — the server may simply not implement one of them.
  let tools: MCPToolDescriptor[] = [];
  let resources: MCPResourceDescriptor[] = [];
  try {
    const t = await client.listTools();
    tools = t.tools ?? [];
  } catch (e: any) {
    logger.warn('MCP listTools failed', { server: name, err: e?.message ?? String(e) });
  }
  try {
    const r = await client.listResources();
    resources = r.resources ?? [];
  } catch (e: any) {
    logger.warn('MCP listResources failed', { server: name, err: e?.message ?? String(e) });
  }

  logger.info('MCP server connected', {
    server: name,
    transport: config.transport,
    tools: tools.length,
    resources: resources.length,
  });

  return {
    name,
    config,
    client,
    tools,
    resources,
    connectedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// CALL TOOL
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function callMCPTool(
  server: ConnectedMCPServer,
  toolName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  return server.client.callTool({ name: toolName, arguments: args });
}

// ---------------------------------------------------------------------------
// READ RESOURCE
// ---------------------------------------------------------------------------

export async function readMCPResource(
  server: ConnectedMCPServer,
  uri: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  return server.client.readResource({ uri });
}

// ---------------------------------------------------------------------------
// DISCONNECT
// ---------------------------------------------------------------------------

export async function disconnectMCPServer(server: ConnectedMCPServer): Promise<void> {
  try {
    await server.client.close();
  } catch (e: any) {
    logger.warn('MCP server close failed', { server: server.name, err: e?.message ?? String(e) });
  }
}
