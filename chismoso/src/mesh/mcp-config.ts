/**
 * CHISMOSO V1.3 — MCP Server Config (Task MCP-2)
 *
 * Mirrors Claude Desktop's `claude_desktop_config.json` schema. Each entry
 * describes how to spawn/connect to an MCP server: a stdio subprocess
 * (npx -y @modelcontextprotocol/server-github) or an HTTP/SSE endpoint.
 *
 * Config file path resolution order:
 *   1. $CHISMOSO_MCP_CONFIG   (explicit override)
 *   2. /home/z/my-project/chismoso/data/mcp-servers.json   (default repo path)
 *
 * If the file does not exist, `loadMCPConfig` returns DEFAULT_CONFIG
 * (empty servers map). `writeDefaultConfig` will materialize it on disk
 * so users have a template to edit.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

export type MCPTransport = 'stdio' | 'http';

export interface MCPServerConfig {
  /** Spawn command, e.g. "npx" or "node" or "uvx" (stdio transport). */
  command: string;
  /** Spawn args, e.g. ["-y", "@modelcontextprotocol/server-github"]. */
  args: string[];
  /** Environment variables passed to the subprocess (merged with process.env). */
  env?: Record<string, string>;
  /** Transport: stdio (subprocess) or http (remote URL). */
  transport: MCPTransport;
  /** Required when transport === 'http'. e.g. "https://mcp.example.com/sse". */
  url?: string;
  /** If false, this server is skipped during auto-connect. */
  enabled: boolean;
}

export interface MCPConfig {
  servers: Record<string, MCPServerConfig>;
}

// ---------------------------------------------------------------------------
// DEFAULT CONFIG (shipped empty — MCP servers are explicitly opt-in)
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG_PATH = '/home/z/my-project/chismoso/data/mcp-servers.json';

export const DEFAULT_CONFIG: MCPConfig = {
  servers: {
    // Example servers — disabled by default. Uncomment + provide tokens to use.
    //
    // 'github': {
    //   command: 'npx',
    //   args: ['-y', '@modelcontextprotocol/server-github'],
    //   env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_...' },
    //   transport: 'stdio',
    //   enabled: false,
    // },
    // 'filesystem': {
    //   command: 'npx',
    //   args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    //   transport: 'stdio',
    //   enabled: false,
    // },
    // 'remote-example': {
    //   command: '',
    //   args: [],
    //   transport: 'http',
    //   url: 'https://mcp.example.com/sse',
    //   enabled: false,
    // },
  },
};

// ---------------------------------------------------------------------------
// PATH RESOLUTION
// ---------------------------------------------------------------------------

export function resolveConfigPath(): string {
  return process.env.CHISMOSO_MCP_CONFIG ?? DEFAULT_CONFIG_PATH;
}

// ---------------------------------------------------------------------------
// PERSISTENCE
// ---------------------------------------------------------------------------

export function loadMCPConfig(): MCPConfig {
  const configPath = resolveConfigPath();
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as MCPConfig;
    // Light validation — must have a `servers` object.
    if (!parsed || typeof parsed !== 'object' || typeof parsed.servers !== 'object') {
      return { servers: {} };
    }
    return parsed;
  } catch {
    return { servers: {} };
  }
}

export function saveMCPConfig(config: MCPConfig): void {
  const configPath = resolveConfigPath();
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * Writes DEFAULT_CONFIG to disk IF the config file does not already exist.
 * Called by `chismoso mcp list-servers` so users get a template to edit.
 */
export function writeDefaultConfig(): void {
  const configPath = resolveConfigPath();
  if (existsSync(configPath)) return;
  saveMCPConfig(DEFAULT_CONFIG);
}

// ---------------------------------------------------------------------------
// MUTATORS (used by CLI `mcp add` / `mcp remove`)
// ---------------------------------------------------------------------------

export function addServer(name: string, config: MCPServerConfig): MCPConfig {
  const cfg = loadMCPConfig();
  cfg.servers[name] = { ...config, enabled: config.enabled ?? false };
  saveMCPConfig(cfg);
  return cfg;
}

export function removeServer(name: string): { removed: boolean; config: MCPConfig } {
  const cfg = loadMCPConfig();
  if (!cfg.servers[name]) {
    return { removed: false, config: cfg };
  }
  delete cfg.servers[name];
  saveMCPConfig(cfg);
  return { removed: true, config: cfg };
}
