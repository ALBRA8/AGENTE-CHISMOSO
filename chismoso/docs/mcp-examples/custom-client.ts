/**
 * custom-client.ts — Cliente MCP programático para CHISMOSO.
 *
 * Demuestra cómo conectar tu propia aplicación TypeScript/Node.js a CHISMOSO
 * usando el SDK oficial de Model Context Protocol.
 *
 * Requisitos:
 *   - Node.js >= 20
 *   - npm install @modelcontextprotocol/sdk
 *   - CHISMOSO compilado: /path/to/chismoso/dist/cli.js debe existir
 *     (cd /path/to/chismoso && npm run build)
 *
 * Ejecutar:
 *   npx tsx custom-client.ts
 *
 * Salida esperada:
 *   Available tools: [
 *     'chismoso_investigate',
 *     'chismoso_semantic_search',
 *     'chismoso_list_investigations',
 *     'chismoso_get_investigation',
 *     'chismoso_list_anomalies',
 *     'chismoso_list_topics',
 *     'chismoso_get_topic_history',
 *     'chismoso_list_providers'
 *   ]
 *   [ { type: 'text', text: '{\n  "count": 4,\n  "providers": [...] }' } ]
 *
 * Patrones adicionales soportados por el SDK (no mostrados aquí):
 *   - client.listResources() / client.readResource({ uri })
 *   - client.listPrompts() / client.getPrompt({ name, arguments })
 *   - Manejo de errores (try/catch sobre callTool; isError en result)
 *   - Reconexión tras desconexión del transporte
 *
 * Para un ejemplo productivo con manejo de errores, listing de resources
 * y reconexión, ver el cliente interno de CHISMOSO en:
 *   /home/z/my-project/chismoso/src/mcp/client.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CHISMOSO_CLI = '/path/to/chismoso/dist/cli.js';

async function main(): Promise<void> {
  // 1. Crear el transporte stdio que spawneará CHISMOSO como subproceso.
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CHISMOSO_CLI, 'mcp', 'serve'],
  });

  // 2. Crear el client con la identidad de nuestra aplicación.
  const client = new Client(
    { name: 'my-app', version: '1.0.0' },
    { capabilities: {} },
  );

  // 3. Conectar. Esto arranca el subproceso CHISMOSO y hace el handshake
  //    JSON-RPC 2.0 (initialize -> notifications/initialized).
  await client.connect(transport);

  // 4. Listar tools disponibles (deben ser los 8 chismoso_* tools).
  const { tools } = await client.listTools();
  console.log('Available tools:', tools.map((t) => t.name));

  // 5. Invocar un tool — por ejemplo, listar providers.
  const result = await client.callTool({
    name: 'chismoso_list_providers',
    arguments: {},
  });
  console.log(result.content);

  // 6. Cerrar limpiamente (mata el subproceso CHISMOSO).
  await client.close();
}

main().catch((err) => {
  console.error('custom-client failed:', err);
  process.exit(1);
});
