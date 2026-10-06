/**
 * CHISMOSO V1.3 — MCP Server Registry (Task MCP-2)
 *
 * In-memory registry of currently-connected MCP servers. The registry is a
 * singleton (`mcpRegistry`) so both the CLI (`mcp connect`) and the
 * Orchestrator init path (`investigate`) share the same connected pool.
 *
 * Lifecycle:
 *   - `connectAll()`      — connects to every `enabled` server in the config
 *                           file. Used by `investigate`/`watch`/`demo` before
 *                           constructing the Orchestrator.
 *   - `connect(name, c)`  — connects to a specific server and persists it
 *                           to the config file (enabled=true). Used by `mcp connect`.
 *   - `disconnect(name)`  — closes the transport and marks it disabled in
 *                           the config file. Used by `mcp disconnect`.
 *   - `disconnectAll()`   — closes every active connection. Called on
 *                           process exit.
 *
 * Tool naming convention:
 *   - The registry exposes every connected tool under a dotted name:
 *     `<serverName>.<toolName>` — e.g. `github.search_repositories`.
 *   - This guarantees uniqueness across servers (two servers can each
 *     expose a tool named `read_file` without colliding).
 */

import {
  connectToMCPServer,
  disconnectMCPServer,
  type ConnectedMCPServer,
} from './client.js';
import {
  loadMCPConfig,
  saveMCPConfig,
  type MCPServerConfig,
} from '../mesh/mcp-config.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

export interface MCPRemoteTool {
  serverName: string;
  toolName: string;
  /** `<serverName>.<toolName>` — used as the lookup key for `callTool`. */
  fullName: string;
  description?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: any;
}

export interface ConnectAllResult {
  connected: string[];
  failed: Array<{ name: string; error: string }>;
}

// ---------------------------------------------------------------------------
// REGISTRY
// ---------------------------------------------------------------------------

class MCPRegistry {
  private connected = new Map<string, ConnectedMCPServer>();

  // -------------------------------------------------------------------------
  // BULK CONNECT — used by `investigate` / `watch` / `demo` during init
  // -------------------------------------------------------------------------

  async connectAll(): Promise<ConnectAllResult> {
    const config = loadMCPConfig();
    const connected: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];

    for (const [name, serverConfig] of Object.entries(config.servers)) {
      if (!serverConfig.enabled) continue;
      try {
        // If we already have a live connection, skip — avoids double-connect
        // when `connectAll` is called repeatedly (e.g. scheduler ticks).
        if (this.connected.has(name)) {
          connected.push(name);
          continue;
        }
        const server = await connectToMCPServer(name, serverConfig);
        this.connected.set(name, server);
        connected.push(name);
      } catch (e: any) {
        const err = e?.message ?? String(e);
        failed.push({ name, error: err });
        logger.warn('MCP auto-connect failed', { server: name, err });
      }
    }
    return { connected, failed };
  }

  // -------------------------------------------------------------------------
  // SINGLE CONNECT — used by `mcp connect <name>`
  // -------------------------------------------------------------------------

  async connect(name: string, config: MCPServerConfig): Promise<ConnectedMCPServer> {
    if (this.connected.has(name)) {
      await this.disconnect(name);
    }
    const server = await connectToMCPServer(name, config);
    this.connected.set(name, server);

    // Persist to the config file as enabled=true so future `connectAll`
    // picks it up automatically.
    const cfg = loadMCPConfig();
    cfg.servers[name] = { ...config, enabled: true };
    saveMCPConfig(cfg);
    return server;
  }

  // -------------------------------------------------------------------------
  // DISCONNECT — used by `mcp disconnect <name>` and `disconnectAll`
  // -------------------------------------------------------------------------

  async disconnect(name: string): Promise<void> {
    const server = this.connected.get(name);
    if (!server) return;
    await disconnectMCPServer(server);
    this.connected.delete(name);

    // Mark as disabled in the config file (do NOT delete — user may want
    // to re-enable it later via `mcp connect <name>`).
    const cfg = loadMCPConfig();
    if (cfg.servers[name]) {
      cfg.servers[name].enabled = false;
      saveMCPConfig(cfg);
    }
  }

  // -------------------------------------------------------------------------
  // QUERIES
  // -------------------------------------------------------------------------

  listConnected(): ConnectedMCPServer[] {
    return Array.from(this.connected.values());
  }

  getServer(name: string): ConnectedMCPServer | undefined {
    return this.connected.get(name);
  }

  /**
   * Returns all tools from all connected servers, each prefixed with the
   * owning server's name (dotted convention: `serverName.toolName`).
   */
  getAllTools(): MCPRemoteTool[] {
    const out: MCPRemoteTool[] = [];
    for (const server of this.connected.values()) {
      for (const tool of server.tools) {
        out.push({
          serverName: server.name,
          toolName: tool.name,
          fullName: `${server.name}.${tool.name}`,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // CALL — `fullName` is `serverName.toolName`
  // -------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async callTool(fullName: string, args: any): Promise<any> {
    const dotIdx = fullName.indexOf('.');
    if (dotIdx < 0) {
      throw new Error(`Invalid MCP tool name "${fullName}" — expected "server.tool"`);
    }
    const serverName = fullName.slice(0, dotIdx);
    const toolName = fullName.slice(dotIdx + 1);
    const server = this.connected.get(serverName);
    if (!server) {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }
    return server.client.callTool({ name: toolName, arguments: args });
  }

  // -------------------------------------------------------------------------
  // LIFECYCLE
  // -------------------------------------------------------------------------

  async disconnectAll(): Promise<void> {
    for (const name of Array.from(this.connected.keys())) {
      await this.disconnect(name);
    }
  }

  /** Returns true if at least one server is currently connected. */
  hasConnected(): boolean {
    return this.connected.size > 0;
  }
}

// ---------------------------------------------------------------------------
// SINGLETON
// ---------------------------------------------------------------------------

export const mcpRegistry = new MCPRegistry();
