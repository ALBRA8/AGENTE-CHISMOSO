/** Ambient declarations for optional deps (not always installed). */
declare module 'mammoth' {
  export function extractRawText(opts: { path: string }): Promise<{ value: string }>;
}
declare module 'xlsx' {
  export function readFile(path: string): { SheetNames: string[]; Sheets: Record<string, any> };
  export const utils: { sheet_to_csv: (sheet: any) => string };
}
declare module 'officeparser' {
  export function parseOffice(path: string): Promise<any>;
}
declare module 'tesseract.js' {
  export function recognize(image: string, lang: string, opts?: any): Promise<{ data: { text: string } }>;
  const _default: { recognize: typeof recognize };
  export default _default;
}
declare module 'marked' {
  const _marked: { parse: (src: string) => string; lexer: { lex: (src: string) => any[] } };
  export default _marked;
}
declare module '@modelcontextprotocol/sdk/types.js' {
  export const ListToolsRequestSchema: any;
  export const CallToolRequestSchema: any;
  export const ListResourcesRequestSchema: any;
  export const ListResourceTemplatesRequestSchema: any;
  export const ReadResourceRequestSchema: any;
  export const ListPromptsRequestSchema: any;
  export const GetPromptRequestSchema: any;
  export type Tool = any;
}
declare module '@modelcontextprotocol/sdk/server/index.js' {
  export class Server {
    constructor(info: any, caps: any);
    setRequestHandler(schema: any, handler: (req: any) => Promise<any>): void;
    connect(transport: any): Promise<void>;
  }
}
declare module '@modelcontextprotocol/sdk/server/stdio.js' {
  export class StdioServerTransport {
  onclose?: any;
  onerror?: (err: any) => void;
    constructor();
  }
}
declare module '@modelcontextprotocol/sdk/client/index.js' {
  export class Client {
    constructor(info: any, caps: any);
    connect(transport: any): Promise<void>;
    listTools(): Promise<{ tools: any[] }>;
    listResources(): Promise<{ resources: any[] }>;
    callTool(req: any): Promise<any>;
    readResource(req: any): Promise<any>;
    close(): Promise<void>;
  }
}
declare module '@modelcontextprotocol/sdk/client/stdio.js' {
  export class StdioClientTransport {
    constructor(opts: any);
  }
}
declare module '@modelcontextprotocol/sdk/client/streamableHttp.js' {
  export class StreamableHTTPClientTransport {
    constructor(url: any);
  }
}
declare module '@modelcontextprotocol/sdk/client/sse.js' {
  export class SSEClientTransport {
    constructor(url: any);
  }
}

// Ambient declarations for chismoso/dist modules (runtime imports from Next.js)
declare module '../../chismoso/dist/audit-log.js' {
  export class AuditLog {
    constructor(db: any);
    append(entry: any): any;
    query(filter: any): any[];
  }
}
declare module '../../chismoso/dist/db.js' {
  export class ChismosoDB {
    constructor(opts: any);
    prepare(sql: string): any;
    exec(sql: string): void;
    transaction(fn: () => any): any;
    close(): void;
  }
}
