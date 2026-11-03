import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import http from 'http';
import path from 'path';
import type { Express } from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { makeApp, webhookBody, TEST_PG_URL, suiteDatabaseUrl, sql } from './helpers';

// Stopping the server. In process: what endStreams() does to the event
// streams. In a child process: that the real entry point, src/server.ts run
// through tsx, exits on a signal, which no in-process test can show. A
// process without a handler dies of the signal itself (or, as a container's
// PID 1, ignores it until Docker's SIGKILL); one that shut down exits 0.

const ROOT = path.resolve(__dirname, '..');
const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
/** A Focus listener's machine: the key it holds and the id derived from it, as in commands.test.ts. */
const MAC_KEY = sha256('mac');
const MAC_ID = sha256(MAC_KEY).slice(0, 32);

function listen(app: Express): Promise<{ srv: Server; base: string }> {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      resolve({ srv, base: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(srv: Server): Promise<void> {
  return new Promise((resolve) => {
    srv.closeAllConnections();
    srv.close(() => resolve());
  });
}

/** An open event stream, read as text. */
async function openStream(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers: { accept: 'text/event-stream', ...headers } });
  expect(res.status).toBe(200);
  if (!res.body) throw new Error('SSE response has no body stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  return {
    /** Reads until `needle` has arrived. */
    async until(needle: string): Promise<void> {
      while (!text.includes(needle)) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`stream ended before ${JSON.stringify(needle)}; received: ${JSON.stringify(text)}`);
        text += decoder.decode(value, { stream: true });
      }
    },
    /** What arrives from here until the stream ends. Rejects if it breaks off instead of ending. */
    async rest(): Promise<string> {
      const from = text.length;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return text.slice(from);
        text += decoder.decode(value, { stream: true });
      }
    },
  };
}

interface Child {
  child: ChildProcess;
  base: string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Resolves once the child's stdout or stderr has printed `needle`. */
  printed(needle: string): Promise<void>;
}

/**
 * Starts src/server.ts in a child process on a port of its choosing; resolves
 * once it listens. Node with tsx's loader rather than the tsx CLI that
 * workspace-creation.test.ts runs: the CLI is a second process that relays
 * signals, and here the signal must reach the server itself.
 */
function startServer(env: Record<string, string> = {}): Promise<Child> {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'src', 'server.ts')], {
    cwd: ROOT,
    // Legacy mode, in memory unless the test says otherwise.
    env: { PATH: process.env.PATH, PORT: '0', HOST: '127.0.0.1', DATABASE_URL: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const waiting: Array<{ needle: string; resolve: () => void }> = [];
  const onOutput = (chunk: Buffer): void => {
    output += chunk.toString();
    for (const w of waiting.filter((w) => output.includes(w.needle))) {
      waiting.splice(waiting.indexOf(w), 1);
      w.resolve();
    }
  };
  child.stdout!.on('data', onOutput);
  child.stderr!.on('data', onOutput);
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const printed = (needle: string): Promise<void> =>
    output.includes(needle) ? Promise.resolve() : new Promise((resolve) => waiting.push({ needle, resolve }));
  return new Promise((resolve, reject) => {
    void exit.then(({ code, signal }) => reject(new Error(`server exited (${code ?? signal}) before listening:\n${output}`)));
    void printed('listening on http://').then(() => {
      const port = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1];
      if (!port) reject(new Error(`no port in the startup line:\n${output}`));
      else resolve({ child, base: `http://127.0.0.1:${port}`, exit, printed });
    });
  });
}

describe('endStreams()', () => {
  it('ends viewer and listener streams with no last frame, and answers a new one 503', async () => {
    const { app, endStreams } = makeApp({ multiTenant: false });
    const { srv, base } = await listen(app);
    try {
      const viewer = await openStream(`${base}/events`);
      const listener = await openStream(`${base}/events?listener=${MAC_ID}&name=Mac`, {
        authorization: `Bearer ${MAC_KEY}`,
      });
      // The listener coming online is the last frame either stream gets.
      await viewer.until('event: machine\n');
      await listener.until('event: machine\n');

      endStreams();
      // Neither the empty snapshot a deleted board gets nor the listener's
      // machine going offline: the board is still there.
      expect(await viewer.rest()).toBe('');
      expect(await listener.rest()).toBe('');

      const late = await fetch(`${base}/events`);
      expect(late.status).toBe(503);
      expect(await late.json()).toEqual({ error: 'server is shutting down' });
    } finally {
      await closeServer(srv);
    }
  });
});

describe('src/server.ts on a signal', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)(
    '%s with a viewer connected: its stream ends cleanly and the process exits 0 at once',
    async (sig) => {
      const server = await startServer();
      try {
        // Leaves an idle keep-alive connection, which close() has to shut too.
        await (await fetch(`${server.base}/healthz`)).text();
        const viewer = await openStream(`${server.base}/events`);
        await viewer.until('event: machines');

        const started = Date.now();
        server.child.kill(sig);
        expect(await viewer.rest()).toBe('');
        expect(await server.exit).toEqual({ code: 0, signal: null });
        // Well under the 2 s after which the server cuts whatever is still
        // open: nothing should need cutting.
        expect(Date.now() - started).toBeLessThan(1500);
      } finally {
        server.child.kill('SIGKILL');
      }
    },
    20_000,
  );
});

describe.skipIf(!TEST_PG_URL)('src/server.ts on a signal (PostgreSQL)', () => {
  it('a webhook still arriving at SIGTERM is answered and in Postgres when the process exits', async () => {
    const dbUrl = await suiteDatabaseUrl('shutdown');
    const server = await startServer({ DATABASE_URL: dbUrl });
    try {
      const body = JSON.stringify(webhookBody('in-flight', { name: 'Late' }));
      const req = http.request(`${server.base}/webhook`, {
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          // The server's 100 Continue says it has the request in hand, so the
          // signal lands while the request runs and the body follows it.
          expect: '100-continue',
        },
      });
      const status = new Promise<number>((resolve, reject) => {
        req.once('response', (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.once('error', reject);
      });
      await new Promise<void>((resolve) => {
        req.once('continue', resolve);
        req.flushHeaders();
      });

      server.child.kill('SIGTERM');
      await server.printed('SIGTERM: shutting down');
      req.end(body);

      expect(await status).toBe(200);
      expect(await server.exit).toEqual({ code: 0, signal: null });
      const rows = await sql(dbUrl, 'SELECT name FROM sessions WHERE id = $1 AND deleted_at IS NULL', ['in-flight']);
      expect(rows).toEqual([{ name: 'Late' }]);
    } finally {
      server.child.kill('SIGKILL');
    }
  }, 20_000);
});
