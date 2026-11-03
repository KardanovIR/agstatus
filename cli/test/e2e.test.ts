import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createApp } from '../../src/app';
import { runInit, runUninstall } from '../src/index';
import { readCodexHookConfig } from '../src/codex';
import { hookInstallPath, settingsPath } from '../src/settings';

const created = createApp({
  multiTenant: true,
  webhookSecret: '',
  publicUrl: 'http://misconfigured.example', // deliberately wrong: CLI must not trust it
  sessionTtlMs: 0,
  databaseUrl: '',
  trustProxy: false,
  rateLimit: false,
  maxWorkspaces: 10_000,
  commandTtlMs: 120_000,
  version: 'e2e',
});

let server: Server;
let base: string;
let dir: string;
let prevConfigDir: string | undefined;
const logs: string[] = [];
const log = (l: string): void => {
  logs.push(l);
};

beforeAll(async () => {
  server = created.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  created.shutdown();
});

let codexDir: string;
let prevCodexHome: string | undefined;
let prevStatusUrl: string | undefined;
let prevStatusSecret: string | undefined;
let prevAgstatusUrl: string | undefined;
let prevHome: string | undefined;

// The upgrade tests run init without a url. One that regressed to the default
// server would reach agstatus.online for real, so nothing here may leave
// this machine.
const realFetch = globalThis.fetch;
const localFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    return Promise.reject(new Error(`e2e tests must not reach ${url.origin}`));
  }
  return realFetch(input, init);
}) as typeof fetch;

beforeEach(() => {
  globalThis.fetch = localFetch;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-e2e-'));
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  // Point Codex auto-detection at a throwaway dir so tests can never touch
  // a real ~/.codex on the machine running them. (Non-existent → undetected.)
  codexDir = path.join(os.tmpdir(), `agstatus-e2e-codex-${process.pid}-${Math.random().toString(36).slice(2)}`);
  prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexDir;
  // Isolate the two config sources that are NOT under CLAUDE_CONFIG_DIR, or
  // these tests read the real machine's setup: CLAUDE_STATUS_URL is the
  // highest-precedence board (boardUrlCandidates()), and ~/.agstatus.json is
  // found through os.homedir(). Without this, a developer whose own shell has
  // a board exported gets different results from CI.
  prevStatusUrl = process.env.CLAUDE_STATUS_URL;
  delete process.env.CLAUDE_STATUS_URL;
  prevStatusSecret = process.env.CLAUDE_STATUS_SECRET;
  delete process.env.CLAUDE_STATUS_SECRET;
  // AGSTATUS_URL outranks the server this machine reports to, so one exported
  // in a developer's shell would send the upgrade tests (no `url`) elsewhere.
  prevAgstatusUrl = process.env.AGSTATUS_URL;
  delete process.env.AGSTATUS_URL;
  prevHome = process.env.HOME;
  process.env.HOME = dir;
  logs.length = 0;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevCodexHome;
  if (prevStatusUrl === undefined) delete process.env.CLAUDE_STATUS_URL;
  else process.env.CLAUDE_STATUS_URL = prevStatusUrl;
  if (prevStatusSecret === undefined) delete process.env.CLAUDE_STATUS_SECRET;
  else process.env.CLAUDE_STATUS_SECRET = prevStatusSecret;
  if (prevAgstatusUrl === undefined) delete process.env.AGSTATUS_URL;
  else process.env.AGSTATUS_URL = prevAgstatusUrl;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(codexDir, { recursive: true, force: true });
});

function readInstalledSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;
}

function installedEnv(): Record<string, unknown> {
  return (readInstalledSettings().env ?? {}) as Record<string, unknown>;
}

async function waitForServer(baseUrl: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server at ${baseUrl} did not come up within ${timeoutMs}ms`);
}

describe('agstatus init against a real multi-tenant server', () => {
  it('creates a board, installs the hook, and the hook actually reports a session', async () => {
    // The hook runs as a subprocess, and in some sandboxed environments a
    // subprocess cannot connect to a port owned by the vitest worker itself —
    // so this test runs the server as a sibling child process (which also
    // exercises the real compiled dist/server.js).
    const root = path.resolve(__dirname, '..', '..');
    const serverJs = path.join(root, 'dist', 'server.js');
    if (!fs.existsSync(serverJs)) {
      throw new Error('dist/server.js missing — run `npm run build` at the repo root first');
    }
    const port = 3400 + Math.floor(Math.random() * 500);
    const child = spawn(process.execPath, [serverJs], {
      env: {
        ...process.env,
        PORT: String(port),
        MULTI_TENANT: 'true',
        PUBLIC_URL: 'http://misconfigured.example', // CLI must not trust it
        DB_PATH: '',
        SESSION_TTL_MS: '0',
      },
      stdio: 'ignore',
    });
    const childBase = `http://127.0.0.1:${port}`;
    try {
      await waitForServer(childBase);
      await runInit({ url: childBase, noQr: true, log });

      // Hook file installed and executable.
      const hookFile = hookInstallPath();
      expect(fs.existsSync(hookFile)).toBe(true);
      expect(fs.statSync(hookFile).mode & 0o111).not.toBe(0);

      // settings.json points at a board on the origin WE reached, not PUBLIC_URL.
      const settings = readInstalledSettings();
      const env = settings.env as Record<string, string>;
      expect(env.CLAUDE_STATUS_URL).toMatch(
        new RegExp(`^${childBase}/w/ags_[A-Za-z0-9_-]{32}$`)
      );
      expect(env.CLAUDE_STATUS_URL).not.toContain('misconfigured.example');
      expect(Object.keys(settings.hooks as object).sort()).toEqual(
        ['Notification', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort()
      );

      // Fire the REAL installed hook with a SessionStart payload.
      const payload = JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'e2e-hook-1',
        cwd: '/tmp/demo-project',
      });
      execFileSync(process.execPath, [hookFile], {
        input: payload,
        // AGSTATUS_USAGE=off: the usage path would read the developer's real
        // Claude credentials and call Anthropic — never from a test.
        env: {
          ...process.env,
          CLAUDE_STATUS_URL: env.CLAUDE_STATUS_URL,
          AGSTATUS_USAGE: 'off',
          // Keep the Focus record out of the developer's own state directory.
          AGSTATUS_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-e2e-state-')),
        },
        timeout: 8000,
      });

      const sessions = (await (
        await fetch(`${env.CLAUDE_STATUS_URL}/api/sessions`)
      ).json()) as Array<{ id: string; status: string; project: string }>;
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('e2e-hook-1');
      expect(sessions[0].status).toBe('idle');
      expect(sessions[0].project).toBe('demo-project');
    } finally {
      child.kill();
    }
  });

  it('init --code claims the pairing code and reuses the existing board', async () => {
    // Simulate the mobile app: it owns a board and creates a pairing code.
    const board = (await (await fetch(`${base}/api/workspaces`, { method: 'POST' })).json()) as {
      token: string;
    };
    const pair = (await (
      await fetch(`${base}/w/${board.token}/pair`, { method: 'POST' })
    ).json()) as { code: string };
    expect(pair.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    await runInit({ url: base, code: pair.code, noQr: true, log });

    const env = readInstalledSettings().env as Record<string, string>;
    expect(env.CLAUDE_STATUS_URL).toBe(`${base}/w/${board.token}`);

    // Code is single-use.
    const second = await fetch(`${base}/api/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pair.code }),
    });
    expect(second.status).toBe(404);
  });

  it('re-running init is idempotent; uninstall removes everything it added', async () => {
    await runInit({ url: base, noQr: true, log });
    await runInit({ url: base, noQr: true, log });
    const hooks = readInstalledSettings().hooks as Record<string, unknown[]>;
    for (const entries of Object.values(hooks)) expect(entries).toHaveLength(1);

    await runUninstall(log);
    const after = readInstalledSettings();
    expect(after).not.toHaveProperty('hooks');
    expect(after).not.toHaveProperty('env');
    expect(fs.existsSync(hookInstallPath())).toBe(false);
    expect(fs.existsSync(`${settingsPath()}.agstatus-backup`)).toBe(true);
  });

  // The installer runs `init` on every re-run, so this IS the upgrade path for
  // every existing user. Minting a second board here would leave their sessions,
  // their history and their phone pairing on the first one, silently.
  it('re-running init keeps the board this machine already reports to', async () => {
    const lines: string[] = [];
    await runInit({ url: base, noQr: true, log });
    const first = String((readInstalledSettings().env as Record<string, unknown>).CLAUDE_STATUS_URL);
    expect(first).toMatch(/\/w\//);

    await runInit({ url: base, noQr: true, log: (l) => lines.push(l) });
    const second = String((readInstalledSettings().env as Record<string, unknown>).CLAUDE_STATUS_URL);
    expect(second).toBe(first);
    expect(lines.join('\n')).toContain('Using the board this machine already reports to.');
    expect(lines.join('\n')).not.toContain('Created a new private board.');
  });

  it('--new-board mints a second one on purpose', async () => {
    await runInit({ url: base, noQr: true, log });
    const first = String((readInstalledSettings().env as Record<string, unknown>).CLAUDE_STATUS_URL);

    const lines: string[] = [];
    await runInit({ url: base, noQr: true, newBoard: true, log: (l) => lines.push(l) });
    const second = String((readInstalledSettings().env as Record<string, unknown>).CLAUDE_STATUS_URL);
    expect(second).not.toBe(first);
    expect(lines.join('\n')).toContain('Created a new private board.');
  });

  // An upgrade is `init` with only the flags given this time, so everything
  // chosen before has to survive one: above all the server, since a bare
  // upgrade used to take a self-hosted machine to a new board on
  // agstatus.online.
  it('an upgrade without --url stays on the server and board this machine reports to', async () => {
    await runInit({ url: base, noQr: true, log });
    const first = installedEnv().CLAUDE_STATUS_URL;

    const lines: string[] = [];
    await runInit({ noQr: true, log: (l) => lines.push(l) });
    expect(installedEnv().CLAUDE_STATUS_URL).toBe(first);
    expect(lines[0]).toBe(`Connecting to ${base} (the server this machine already reports to) ...`);
    expect(lines.join('\n')).toContain('Using the board this machine already reports to.');
  });

  it('keeps --minimal through an upgrade that does not repeat it, and --no-minimal turns it off', async () => {
    await runInit({ url: base, noQr: true, minimal: true, log });
    expect(installedEnv().AGSTATUS_DETAIL).toBe('off');

    const lines: string[] = [];
    await runInit({ noQr: true, log: (l) => lines.push(l) });
    expect(installedEnv().AGSTATUS_DETAIL).toBe('off');
    expect(lines.join('\n')).toContain("Keeping --minimal from this machine's setup");
    expect(lines.join('\n')).not.toContain('Status messages include truncated command text');

    await runInit({ noQr: true, minimal: false, log });
    expect(installedEnv()).not.toHaveProperty('AGSTATUS_DETAIL');
  });

  it('reads --minimal from the Codex hook config as well, and writes it back to both', async () => {
    fs.mkdirSync(codexDir, { recursive: true });
    await runInit({ url: base, noQr: true, minimal: true, codex: true, log });
    // Claude Code's side has lost the switch (a hand edit, say); Codex's has not.
    const settings = readInstalledSettings();
    delete (settings.env as Record<string, unknown>).AGSTATUS_DETAIL;
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));

    await runInit({ noQr: true, codex: true, log });
    expect(installedEnv().AGSTATUS_DETAIL).toBe('off');
    expect(readCodexHookConfig()?.detail).toBe('off');
  });

  it('AGSTATUS_URL and --url still choose the server over the one this machine reports to', async () => {
    await runInit({ url: base, noQr: true, log });
    process.env.AGSTATUS_URL = 'http://127.0.0.1:9';
    await expect(runInit({ noQr: true, log })).rejects.toThrow(
      /^Could not reach http:\/\/127\.0\.0\.1:9 — check the URL/
    );
    delete process.env.AGSTATUS_URL;
    await expect(runInit({ url: 'http://127.0.0.1:9', noQr: true, log })).rejects.toThrow(
      /^Could not reach http:\/\/127\.0\.0\.1:9 — check the URL/
    );
    expect(installedEnv().CLAUDE_STATUS_URL).toMatch(/\/w\//);
  });

  it('says so when the server this machine reports to is the one that is down', async () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({ env: { CLAUDE_STATUS_URL: 'http://127.0.0.1:9/w/ags_gone' } }));
    await expect(runInit({ noQr: true, log })).rejects.toThrow(
      'Could not reach http://127.0.0.1:9, the server this machine already reports to'
    );
  });

  // Unreadable is not the same as absent: guessing the server, or minting a
  // board, from a setup that could not be seen is how a machine moves boards
  // without anyone deciding it. Thrown before the network is touched, which
  // the unreachable URL proves.
  it('stops before reaching any server when ~/.agstatus.json cannot be read', async () => {
    fs.writeFileSync(path.join(dir, '.agstatus.json'), '{ not json');
    await expect(runInit({ url: 'http://127.0.0.1:9', noQr: true, log })).rejects.toThrow(
      /\.agstatus\.json exists but is not valid JSON/
    );
    expect(fs.existsSync(settingsPath())).toBe(false);
  });

  it('aborts without touching an invalid settings.json', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(settingsPath(), '{ definitely not json');
    // Unreachable on purpose: the error is the JSON one, so nothing reached a
    // server, and no board was made for a setup that could not be read.
    await expect(runInit({ url: 'http://127.0.0.1:9', noQr: true, log })).rejects.toThrow(/not valid JSON/);
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe('{ definitely not json');
  });

  it('fails with a clear error when the server is unreachable', async () => {
    await expect(runInit({ url: 'http://127.0.0.1:9', noQr: true, log })).rejects.toThrow(
      /Could not reach/
    );
    expect(fs.existsSync(settingsPath())).toBe(false);
  });
});

describe('agstatus init against a real single-tenant server with a webhook secret', () => {
  const singleTenant = (webhookSecret: string): ReturnType<typeof createApp> =>
    createApp({
      multiTenant: false,
      webhookSecret,
      publicUrl: 'http://misconfigured.example',
      sessionTtlMs: 0,
      databaseUrl: '',
      trustProxy: false,
      rateLimit: false,
      maxWorkspaces: 10_000,
      commandTtlMs: 120_000,
      version: 'e2e',
    });
  const legacy = singleTenant('s3cr3t');
  const other = singleTenant('another-secret');
  let legacyServer: Server;
  let otherServer: Server;
  let legacyBase: string;
  let otherBase: string;

  beforeAll(async () => {
    legacyServer = legacy.app.listen(0);
    otherServer = other.app.listen(0);
    await Promise.all([legacyServer, otherServer].map((s) => new Promise((resolve) => s.once('listening', resolve))));
    legacyBase = `http://127.0.0.1:${(legacyServer.address() as AddressInfo).port}`;
    otherBase = `http://127.0.0.1:${(otherServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await Promise.all([legacyServer, otherServer].map((s) => new Promise((resolve) => s.close(resolve))));
    await Promise.all([legacy.shutdown(), other.shutdown()]);
  });

  it('an upgrade keeps the secret for the same server, and --no-secret drops it', async () => {
    await runInit({ url: legacyBase, secret: 's3cr3t', noQr: true, log });
    expect(installedEnv()).toMatchObject({ CLAUDE_STATUS_URL: legacyBase, CLAUDE_STATUS_SECRET: 's3cr3t' });

    const kept: string[] = [];
    await runInit({ noQr: true, log: (l) => kept.push(l) });
    expect(installedEnv()).toMatchObject({ CLAUDE_STATUS_URL: legacyBase, CLAUDE_STATUS_SECRET: 's3cr3t' });
    expect(kept.join('\n')).toContain("Keeping this machine's webhook secret");
    expect(kept.join('\n')).not.toContain('requires a webhook secret');

    const dropped: string[] = [];
    await runInit({ noQr: true, noSecret: true, log: (l) => dropped.push(l) });
    expect(installedEnv()).not.toHaveProperty('CLAUDE_STATUS_SECRET');
    expect(dropped.join('\n')).toContain('This server requires a webhook secret');
  });

  // A secret belongs to its server: carried to another one, it would be sent
  // there with every update.
  it('a move to another single-tenant server leaves the secret behind', async () => {
    await runInit({ url: legacyBase, secret: 's3cr3t', noQr: true, log });

    const lines: string[] = [];
    await runInit({ url: otherBase, noQr: true, log: (l) => lines.push(l) });
    expect(installedEnv().CLAUDE_STATUS_URL).toBe(otherBase);
    expect(installedEnv()).not.toHaveProperty('CLAUDE_STATUS_SECRET');
    expect(lines.join('\n')).not.toContain("Keeping this machine's webhook secret");
    expect(lines.join('\n')).toContain('This server requires a webhook secret');
  });

  // --minimal belongs to the machine, whichever server it reports to.
  it('a move to a multi-tenant server leaves the secret behind and keeps --minimal', async () => {
    await runInit({ url: legacyBase, secret: 's3cr3t', minimal: true, noQr: true, log });

    await runInit({ url: base, noQr: true, log });
    const env = installedEnv();
    expect(String(env.CLAUDE_STATUS_URL)).toMatch(new RegExp(`^${base}/w/`));
    expect(env).not.toHaveProperty('CLAUDE_STATUS_SECRET');
    expect(env.AGSTATUS_DETAIL).toBe('off');
  });
});
