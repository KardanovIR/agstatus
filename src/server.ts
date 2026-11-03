import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { configFromEnv, newWorkspaceLimitLine } from './config';
import { createApp } from './app';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
// How long a stop may take before the process exits anyway. Docker sends
// SIGKILL 10 s after SIGTERM, Fly.io 5 s after its SIGINT; a stop normally
// takes milliseconds.
const SHUTDOWN_DEADLINE_MS = 4_000;
// How long a request still running at the signal gets to finish, and a reader
// that has stopped draining its stream gets to take its last chunk, before
// their connections are cut.
const DRAIN_MS = 2_000;

const cfg = configFromEnv();
const created = createApp(cfg);
const { app, ready } = created;

/** Connection string with any password replaced, safe for logs. */
const redactedDbUrl = cfg.databaseUrl.replace(/\/\/([^:@/]+):[^@/]+@/, '//$1:***@');

// Set once the server is listening.
let server: Server | null = null;
let stopping = false;

/**
 * SIGTERM is how `docker stop`, systemd and PaaS platforms stop a process,
 * and SIGINT is Ctrl-C. Node installs no handler for either, and as a
 * container's PID 1 it ignores a signal it has no handler for: every deploy
 * that recreated the container waited out Docker's 10 s stop timeout, then
 * SIGKILLed the server along with whatever writes were still queued.
 *
 * In order: stop taking connections; end the event streams (every client
 * reconnects on its own); let requests already running finish, so their
 * writes are queued; then flush those to Postgres, close the pool and exit.
 */
function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down`);
  setTimeout(() => {
    console.error(`Shutdown did not finish within ${SHUTDOWN_DEADLINE_MS / 1000}s; exiting anyway`);
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS).unref();
  // Still loading persisted state: nothing has been served, so nothing is queued.
  if (!server) process.exit(0);
  const srv = server;
  srv.close(() => {
    void created.shutdown().then(() => process.exit(0));
  });
  // A response still running keeps its connection past close(), and
  // keep-alive would then hold that open for keepAliveTimeout (5 s) in case
  // the client sends another request. Closed once the response is out
  // instead (newer Node waits keepAliveTimeoutBuffer, 1 s, on top).
  srv.keepAliveTimeout = 1;
  created.endStreams();
  setTimeout(() => srv.closeAllConnections(), DRAIN_MS).unref();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

// Don't accept traffic until persisted state is loaded — a webhook arriving
// before the load would be overwritten by it.
ready
  .then(() => {
    const srv = app.listen(PORT, HOST, () => {
      server = srv;
      // The bound port, which is not PORT when that is 0.
      const { port } = srv.address() as AddressInfo;
      console.log(`AgStatus dashboard v${cfg.version} listening on http://${HOST}:${port}`);
      console.log(`Mode:      ${cfg.multiTenant ? 'multi-tenant (workspaces)' : 'single-tenant (legacy)'}`);
      console.log(`Dashboard: ${cfg.publicUrl}`);
      if (cfg.multiTenant) {
        console.log(`Create a workspace: POST ${cfg.publicUrl}/api/workspaces`);
        console.log(newWorkspaceLimitLine(cfg));
      } else {
        console.log(`Webhook:   ${cfg.publicUrl}/webhook`);
        if (cfg.webhookSecret) console.log('Auth:      X-Webhook-Secret header required');
      }
      if (cfg.databaseUrl) console.log(`Storage:   PostgreSQL at ${redactedDbUrl}`);
      else console.log('Storage:   in-memory (set DATABASE_URL to persist)');
    });
  })
  .catch((err: unknown) => {
    console.error(
      `Cannot reach PostgreSQL at ${redactedDbUrl}: ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  });
