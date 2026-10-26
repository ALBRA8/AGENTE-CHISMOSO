/**
 * CHISMOSO V1.5 — Graceful shutdown handler (Task IMP-PROD-OBS, P0-3).
 *
 * Installs SIGINT / SIGTERM hooks that:
 *
 *   1. Stop accepting new requests (Next.js dev server does this
 *      automatically once the signal arrives; in production behind
 *      Caddy, Caddy stops routing once the upstream is unhealthy).
 *   2. Wait up to GRACEFUL_SHUTDOWN_TIMEOUT_MS (default 10s) for
 *      in-flight requests to complete.
 *   3. Close any open SQLite handles (better-sqlite3 segfaults if
 *      the process is killed mid-write — see the comment in
 *      chismoso/src/db.ts).
 *   4. Flush Sentry's buffered events (so the last error before
 *      shutdown reaches Sentry before the process dies).
 *   5. Exit cleanly with code 0 (or 1 if a second signal arrives).
 *
 * The handler is intentionally tolerant — if any step throws, we
 * still try to flush and exit so the process can't get stuck.
 *
 * Why lazy DB imports?
 * --------------------
 * We don't `import { chismosoDb }` at module load time because the
 * instrumentation hook loads this module before the chismoso DB has
 * been initialized (the DB file may not exist yet on a fresh install).
 * Opening the DB readonly at instrumentation-hook time would throw
 * `SQLITE_CANTOPEN` and abort the entire Next.js process boot.
 * Instead we `await import()` inside the shutdown handler so the DB
 * is only opened when shutdown is actually triggered — by then,
 * either (a) the DB has been opened successfully by a route handler
 * (and the singleton is cached on globalThis), or (b) it never was,
 * in which case there's nothing to close.
 */

const GRACEFUL_SHUTDOWN_TIMEOUT_MS = Number(
  process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS ?? 10_000,
);

let shuttingDown = false;
let dbsClosed = false;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) {
    // Second signal — force exit immediately.
    process.exit(1);
  }
  shuttingDown = true;

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'INFO',
    msg: 'graceful_shutdown_start',
    reason: reason,
  }));

  // Run registered shutdown hooks (kill spawned children, etc).
  // Each hook is in its own try/catch so a failure in one hook
  // doesn't prevent the others from running.
  for (const hook of shutdownHooks) {
    try {
      hook();
    } catch {
      /* swallow — keep going */
    }
  }

  // Give in-flight requests up to GRACEFUL_SHUTDOWN_TIMEOUT_MS to
  // complete. (Next.js handles this internally; we just respect the
  // budget when flushing Sentry + closing DB handles.)
  const flushDeadline = Date.now() + GRACEFUL_SHUTDOWN_TIMEOUT_MS;

  // Flush Sentry (best-effort) — the SDK's `flush()` returns once all
  // queued events have been sent to the relay. We bound the wait by
  // the deadline.
  try {
    const sentry = await import('@sentry/node').catch(() => null);
    if (sentry) {
      const remainingMs = Math.max(500, flushDeadline - Date.now());
      await (sentry as unknown as { flush: (ms?: number) => Promise<boolean> })
        .flush(remainingMs)
        .catch(() => false);
    }
  } catch {
    /* swallow */
  }

  // Close SQLite singletons. better-sqlite3's destructor can segfault
  // at exit if Node's environment has been torn down — closing here
  // while the loop is still alive avoids that. Lazy-import so a fresh
  // install (where the DB file doesn't exist yet) doesn't crash the
  // boot via the instrumentation hook.
  if (!dbsClosed) {
    dbsClosed = true;
    try {
      const { chismosoDb } = await import('./db-chismoso');
      chismosoDb.close();
    } catch {
      /* ignore — DB not opened, nothing to close */
    }
    try {
      const { chismosoWritableDb } = await import('./db-chismoso-writable');
      chismosoWritableDb.close();
    } catch {
      /* ignore */
    }
  }

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'INFO',
    msg: 'graceful_shutdown_complete',
    reason,
  }));

  // REL2-P0-1 — exit code MUST depend on the shutdown reason so systemd
  // `Restart=on-failure` triggers a restart for crash-class signals but
  // not for a graceful deploy.
  //   - SIGTERM / SIGINT received from the operator or supervisor: clean
  //     deploy / `systemctl stop`. Exit 0 so `Restart=on-failure` leaves
  //     the service down (the operator asked for it to stop).
  //   - uncaughtException: state is potentially corrupted; we MUST exit 1
  //     so systemd's `Restart=on-failure` auto-restarts the service.
  //     Exiting 0 here would silently defeat the auto-restart guarantee
  //     that REL-P0-001 (supervisor) + REL-P0-005 (uncaught handlers) were
  //     supposed to provide.
  const exitCode = reason === 'SIGTERM' || reason === 'SIGINT' ? 0 : 1;
  process.exit(exitCode);
}

// Install handlers. Use `.unref()`-free listeners so they actually fire.
// (Next.js's dev server installs its own SIGINT handler — we coexist
// by also adding ours; both will run.)
//
// DEV-mode guard: Next.js dev (Turbopack) sends SIGTERM to the parent
// process to trigger HMR reloads / restarts. If we attach our production
// shutdown handler in dev, every HMR reload would call `process.exit(0)`
// and kill the dev server. Only install the handler in production — in
// dev, the chismoso CLI subprocesses + better-sqlite3 handles are reaped
// by the OS when the dev server eventually exits.
if (process.env.NODE_ENV === 'production') {
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// P0-3 (R2-IMP-OBS): on-demand heap snapshot via SIGUSR2.
//
// The runbook (docs/RUNBOOK.md incidents #3 + #5) instructs operators
// to set `CHISMOSO_HEAPDUMP_ON_SIGNAL=1` and send `SIGUSR2` when the
// process is misbehaving (slow RSS growth, suspected memory leak, OOM
// imminent). Without this handler, sending SIGUSR2 did nothing — the
// operator got a silent no-op and the logrotate config rotated a file
// that was never written. This handler closes that gap.
//
// Behavior:
//   - `CHISMOSO_HEAPDUMP_ON_SIGNAL !== '1'` → no-op (default; we
//     don't want SIGUSR2 to accidentally dump a multi-hundred-MB
//     snapshot in environments that use SIGUSR2 for something else,
//     e.g. the Node.js inspector / `node --heapsnapshot-near-heap-limit`).
//   - `= '1'` → write `v8.writeHeapSnapshot()` to
//     `/tmp/chismoso-heapdump-${Date.now()}.heapsnapshot` and log
//     the path so the operator can `scp` it off and load it into
//     Chrome DevTools / `node --inspect`.
//
// Installed in BOTH dev and prod (when the env var is set) so operators
// can debug locally too. The handler is synchronous — `writeHeapSnapshot`
// blocks the event loop for the duration of the dump (~100ms-2s for
// typical Node.js heaps) but that's acceptable for an operator-initiated
// diagnostic. The process STAYS RUNNING after the dump (SIGUSR2 is not
// a shutdown signal), so the operator can capture multiple snapshots
// over time and diff them in DevTools.
if (process.env.CHISMOSO_HEAPDUMP_ON_SIGNAL === '1') {
  process.on('SIGUSR2', () => {
    try {
      // Lazy-load v8 inside the handler so the module isn't pulled
      // into the bundle in environments where the feature is
      // disabled (the `if` guard above already short-circuits the
      // whole block when the env var isn't set, but the require()
      // is still here for defense-in-depth).
      //
      // `node:v8` is a Node built-in; this never throws at runtime.
      // The try/catch guards against any environment where v8 is
      // restricted (very rare — only locked-down sandboxes).
      //
      // We use `require` (not `await import`) because the SIGUSR2
      // handler is synchronous and `writeHeapSnapshot` is itself
      // synchronous — we WANT it to block the event loop so the
      // snapshot captures a consistent heap state (no async work
      // mutating objects mid-dump).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const v8Module = require('node:v8') as {
        writeHeapSnapshot: (filePath?: string) => string;
      };
      const filePath = `/tmp/chismoso-heapdump-${Date.now()}.heapsnapshot`;
      v8Module.writeHeapSnapshot(filePath);
      // Structured JSON log (matching the shutdown logger's format)
      // so Promtail / Loki can parse it without a regex.
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'INFO',
        msg: 'heap_snapshot_written',
        path: filePath,
        signal: 'SIGUSR2',
      }));
    } catch (e) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'ERROR',
        msg: 'heap_snapshot_failed',
        err: e instanceof Error ? {
          name: e.name,
          message: e.message,
          stack: e.stack,
        } : String(e),
      }));
    }
  });
}

// Allow other modules to register their own shutdown hooks (e.g. the
// investigate route uses this to kill its spawned child process so the
// process doesn't hang for 5 minutes waiting on a 60s investigate
// run). Hooks are called in registration order; they MUST not block
// for more than a few seconds (the graceful timeout is 10s total).
const shutdownHooks: Array<() => void> = [];

/**
 * Registers a function to be called when the process receives
 * SIGTERM / SIGINT / uncaughtException. The hook MUST be fast and
 * MUST NOT throw. Returns an unregister function — call it to remove
 * the hook (useful for cleanup when a route handler is unmounted, e.g.
 * when a child process completes naturally and the abort hook is no
 * longer needed).
 */
export function onShutdown(hook: () => void): () => void {
  shutdownHooks.push(hook);
  return () => {
    const idx = shutdownHooks.indexOf(hook);
    if (idx >= 0) shutdownHooks.splice(idx, 1);
  };
}

/**
 * True once the shutdown sequence has started. Route handlers can
 * poll this to short-circuit new work with a 503 (so the load
 * balancer stops routing traffic to us during a deploy).
 */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

// `uncaughtException` should ideally crash the process. We log to
// stderr (and let Sentry's auto-attach pick it up) so the operator
// sees the trace + can debug. We then exit with code 1 — better to
// restart cleanly than continue with corrupted state.
process.on('uncaughtException', (err) => {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'ERROR',
    msg: 'uncaught_exception',
    err: err instanceof Error ? {
      name: err.name,
      message: err.message,
      stack: err.stack,
    } : String(err),
  }));
  void shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'ERROR',
    msg: 'unhandled_rejection',
    reason: reason instanceof Error ? {
      name: reason.name,
      message: reason.message,
      stack: reason.stack,
    } : String(reason),
  }));
  // Unlike uncaughtException, an unhandledRejection doesn't
  // necessarily corrupt state — we just log + continue. If the
  // rejection is severe, the next uncaughtException will crash us.
});
