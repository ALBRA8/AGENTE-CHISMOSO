/**
 * LANZADOR SILENCIOSO - AGENTE CHISMOSO
 * Arranca el servidor Next.js en segundo plano (oculto, sin terminales abiertas)
 * y abre el navegador automáticamente tan pronto como el servidor esté listo.
 */

const http = require('http');
const { spawn, exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const URL = `http://localhost:${PORT}`;
const ROOT_DIR = path.resolve(__dirname, '..');
const LOG_FILE = path.join(ROOT_DIR, 'server.log');

function isServerAlive() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}`, (res) => {
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1200, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function openBrowser() {
  const cmd = process.platform === 'win32'
    ? `start "" "${URL}"`
    : process.platform === 'darwin'
    ? `open "${URL}"`
    : `xdg-open "${URL}"`;
  exec(cmd);
}

function hasBun() {
  try {
    execSync('where bun', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // 1. Si el servidor ya está activo, abrir directamente el navegador
  const alreadyRunning = await isServerAlive();
  if (alreadyRunning) {
    openBrowser();
    process.exit(0);
  }

  // 2. Preparar el archivo de log para capturar salidas
  const outLog = fs.openSync(LOG_FILE, 'a');
  const timestamp = new Date().toISOString();
  fs.writeSync(outLog, `\n\n=== CHISMOSO iniciado silenciosamente: ${timestamp} ===\n`);

  // 3. Determinar el comando de arranque
  const useBun = hasBun();
  const runnerCmd = 'cmd.exe';
  const runnerArgs = useBun
    ? ['/c', 'bun', 'run', 'dev']
    : ['/c', 'npx', 'next', 'dev', '-p', String(PORT)];

  // 4. Lanzar proceso completamente desacoplado y oculto
  const child = spawn(runnerCmd, runnerArgs, {
    cwd: ROOT_DIR,
    detached: true,
    stdio: ['ignore', outLog, outLog],
    windowsHide: true,
  });

  child.unref();

  // 5. Esperar a que responda HTTP en localhost:3000 (máximo 45 segundos)
  const maxSeconds = 45;
  const start = Date.now();

  while ((Date.now() - start) < maxSeconds * 1000) {
    await new Promise((r) => setTimeout(r, 800));
    const ready = await isServerAlive();
    if (ready) {
      openBrowser();
      process.exit(0);
    }
  }

  // Si se cumplió el tiempo límite, intentar abrir el navegador de todos modos
  openBrowser();
  process.exit(0);
}

main().catch((err) => {
  try {
    fs.appendFileSync(LOG_FILE, `\n[ERROR LANZADOR] ${err.stack || err}\n`);
  } catch {}
  process.exit(1);
});
