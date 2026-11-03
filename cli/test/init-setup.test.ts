import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { main, runInit } from '../src/index';
import { codexConfigPath, codexHooksPath, readCodexHookConfig, writeCodexHookConfig } from '../src/codex';
import { configuredBoards, resolveSecret } from '../src/listener/config';
import { settingsPath } from '../src/settings';

// Which server `init` talks to, and what it keeps, decided from the machine's
// current setup. fetch is stubbed so every server is fake — agstatus.online
// included — and each test can say exactly which ones were contacted.
//
// Legacy servers: x.example requires a secret, y.example does not. The
// multi-tenant ones mint ags_new… boards and claim codes as ags_paired….
const SERVERS: Record<string, { mode: 'multi' | 'legacy'; requiresSecret?: boolean }> = {
  'https://agstatus.online': { mode: 'multi' },
  'https://self.example': { mode: 'multi' },
  'https://x.example': { mode: 'legacy', requiresSecret: true },
  'https://y.example': { mode: 'legacy', requiresSecret: false },
};
const NEW_TOKEN = `ags_new${'n'.repeat(29)}`;
const PAIRED_TOKEN = `ags_paired${'p'.repeat(26)}`;
const SELF_BOARD = `https://self.example/w/ags_self${'s'.repeat(27)}`;
const HOSTED_BOARD = `https://agstatus.online/w/ags_host${'h'.repeat(27)}`;

const ENV_KEYS = ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_STATUS_URL', 'CLAUDE_STATUS_SECRET', 'AGSTATUS_URL'];
let saved: Record<string, string | undefined>;
let home: string;
let calls: string[];
let lines: string[];
const log = (l: string): void => {
  lines.push(l);
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-init-setup-'));
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  process.env.CODEX_HOME = path.join(home, '.codex');
  calls = [];
  lines = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.origin}${url.pathname}`);
    const server = SERVERS[url.origin];
    if (!server) throw new TypeError('fetch failed');
    if (url.pathname === '/api/config') return json(200, { ...server, version: 'test' });
    if (url.pathname === '/api/workspaces') return json(201, { token: NEW_TOKEN });
    if (url.pathname === '/api/pair/claim') return json(200, { token: PAIRED_TOKEN });
    return json(404, {});
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function writeSettingsEnv(env: Record<string, string>): void {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify({ env }, null, 2));
}

function settingsEnv(): Record<string, unknown> {
  const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;
  return (settings.env ?? {}) as Record<string, unknown>;
}

const contacted = (): string[] => [...new Set(calls.map((c) => new URL(c.split(' ')[1]).origin))];

const CODEX_CMD = 'node "$HOME/.codex/hooks/agstatus-hook.js"';
/** A Codex registration: the current command, or a pre-sidecar one carrying its settings. */
function registerCodex(command: string): void {
  fs.mkdirSync(path.dirname(codexHooksPath()), { recursive: true });
  fs.writeFileSync(codexHooksPath(), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }));
}
const legacyCodexCmd = (url: string, secret?: string): string =>
  `CLAUDE_STATUS_URL="${url}" AGSTATUS_SOURCE=codex${secret ? ` CLAUDE_STATUS_SECRET='${secret}'` : ''} ${CODEX_CMD}`;

describe('the server an upgrade uses', () => {
  // The environment is what a Claude Code session started with, or a one-off
  // override: neither is this machine's setup.
  it('comes from the files the hooks are configured with, not from CLAUDE_STATUS_URL', async () => {
    writeSettingsEnv({ CLAUDE_STATUS_URL: SELF_BOARD });
    process.env.CLAUDE_STATUS_URL = 'https://x.example';
    process.env.CLAUDE_STATUS_SECRET = 'S_X';
    await runInit({ noQr: true, codex: false, log });
    expect(contacted()).toEqual(['https://self.example']);
    expect(settingsEnv()).toEqual(expect.objectContaining({ CLAUDE_STATUS_URL: SELF_BOARD }));
    expect(settingsEnv()).not.toHaveProperty('CLAUDE_STATUS_SECRET');
    expect(lines[0]).toBe('Connecting to https://self.example (the server this machine already reports to) ...');
  });

  // What `listener install` leaves in ~/.agstatus.json outlives `agstatus
  // uninstall` and is never updated after a move, so it names no server
  // anything reports to.
  it('is not taken from a board named only in ~/.agstatus.json', async () => {
    fs.writeFileSync(path.join(home, '.agstatus.json'), JSON.stringify({ url: SELF_BOARD, focus: false }));
    await runInit({ noQr: true, codex: false, log });
    expect(contacted()).toEqual(['https://agstatus.online']);
    expect(calls).toContain('POST https://agstatus.online/api/workspaces');
    expect(lines[0]).toBe('Connecting to https://agstatus.online ...');
    expect(lines.join('\n')).not.toContain('already reports to');
  });

  it('may still reuse that board when it is on the server the run uses, and says where it came from', async () => {
    fs.writeFileSync(path.join(home, '.agstatus.json'), JSON.stringify({ url: HOSTED_BOARD }));
    await runInit({ noQr: true, codex: false, log });
    expect(calls).not.toContain('POST https://agstatus.online/api/workspaces');
    expect(settingsEnv().CLAUDE_STATUS_URL).toBe(HOSTED_BOARD);
    expect(lines).toContain(`Using the board named in ${path.join(home, '.agstatus.json')}.`);
  });

  // The apps' "Pair your computer" command names --url for every server but
  // the default one, so a bare --code is a code from agstatus.online.
  it('is the default server for a pairing code without --url, wherever the machine reports now', async () => {
    writeSettingsEnv({ CLAUDE_STATUS_URL: SELF_BOARD });
    await runInit({ code: 'ABCD-EFGH', noQr: true, codex: false, log });
    expect(calls).toContain('POST https://agstatus.online/api/pair/claim');
    expect(contacted()).toEqual(['https://agstatus.online']);
    expect(settingsEnv().CLAUDE_STATUS_URL).toBe(`https://agstatus.online/w/${PAIRED_TOKEN}`);
    expect(lines.join('\n')).not.toContain('already reports to');
  });
});

describe('the secret an upgrade keeps', () => {
  // init writes one secret into both Claude Code's settings and the Codex
  // sidecar, so it must be the one configured beside the board it keeps.
  it('is never one configured beside another server', async () => {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    await runInit({ url: 'https://x.example', secret: 'S_X', noQr: true, codex: true, log });
    expect(readCodexHookConfig()?.secret).toBe('S_X');
    // Claude Code moves to y.example; Codex is left where it was, with X's secret.
    await runInit({ url: 'https://y.example', noQr: true, codex: false, log });
    expect(readCodexHookConfig()).toEqual(expect.objectContaining({ url: 'https://x.example', secret: 'S_X' }));

    lines = [];
    await runInit({ noQr: true, codex: true, log });
    expect(settingsEnv()).toEqual(expect.objectContaining({ CLAUDE_STATUS_URL: 'https://y.example' }));
    expect(settingsEnv()).not.toHaveProperty('CLAUDE_STATUS_SECRET');
    expect(readCodexHookConfig()).toEqual({ url: 'https://y.example', source: 'codex' });
    expect(lines.join('\n')).not.toContain("Keeping this machine's webhook secret");

    await runInit({ url: 'https://y.example', noQr: true, codex: true, log });
    expect(settingsEnv()).not.toHaveProperty('CLAUDE_STATUS_SECRET');
    expect(readCodexHookConfig()?.secret).toBeUndefined();
  });

  it('is never one that only the environment holds', async () => {
    writeSettingsEnv({ CLAUDE_STATUS_URL: 'https://y.example' });
    process.env.CLAUDE_STATUS_SECRET = 'S_ENV';
    await runInit({ noQr: true, codex: false, log });
    expect(settingsEnv()).toEqual({ CLAUDE_STATUS_URL: 'https://y.example' });
  });

  // A pre-sidecar registration names its board in the command; the sidecar
  // beside it can be for another server, from a rewrite that never finished.
  it('is never a sidecar secret for another server than the command names', async () => {
    registerCodex(legacyCodexCmd('https://y.example'));
    writeCodexHookConfig(codexConfigPath(), { url: 'https://x.example', source: 'codex', secret: 'S_X' });
    expect(configuredBoards()).toEqual([{ url: 'https://y.example', source: 'codex' }]);

    await runInit({ noQr: true, codex: true, log });
    expect(contacted()).toEqual(['https://y.example']);
    expect(settingsEnv()).not.toHaveProperty('CLAUDE_STATUS_SECRET');
    expect(readCodexHookConfig()).toEqual({ url: 'https://y.example', source: 'codex' });
  });

  it('is never kept for a board, which carries its auth in the URL', async () => {
    writeSettingsEnv({ CLAUDE_STATUS_URL: SELF_BOARD, CLAUDE_STATUS_SECRET: 'stray' });
    await runInit({ noQr: true, codex: false, log });
    expect(settingsEnv().CLAUDE_STATUS_URL).toBe(SELF_BOARD);
    expect(settingsEnv()).not.toHaveProperty('CLAUDE_STATUS_SECRET');
  });
});

// The listener and `agstatus focus` send the secret on every request to the
// board they resolve, so the same rule holds there.
describe('the secret the listener sends', () => {
  it('is none for Claude Code\'s board when only Codex, on another server, has one', () => {
    writeSettingsEnv({ CLAUDE_STATUS_URL: HOSTED_BOARD });
    registerCodex(CODEX_CMD);
    writeCodexHookConfig(codexConfigPath(), { url: 'https://x.example', source: 'codex', secret: 'S_X' });
    expect(resolveSecret()).toBeNull();
    expect(resolveSecret('https://x.example')).toEqual({ secret: 'S_X', source: 'codex' });
  });

  it('is none when a stale pre-sidecar command holds another server\'s secret', () => {
    writeSettingsEnv({ CLAUDE_STATUS_URL: HOSTED_BOARD });
    registerCodex(legacyCodexCmd('https://x.example', 'S_X'));
    writeCodexHookConfig(codexConfigPath(), { url: HOSTED_BOARD, source: 'codex' });
    expect(resolveSecret()).toBeNull();
  });

  it('follows a --url to its own server, and is none for a server with no secret', () => {
    writeSettingsEnv({ CLAUDE_STATUS_URL: 'https://x.example', CLAUDE_STATUS_SECRET: 'S_X' });
    expect(resolveSecret()).toEqual({ secret: 'S_X', source: 'settings' });
    expect(resolveSecret('https://x.example/webhook')).toEqual({ secret: 'S_X', source: 'settings' });
    expect(resolveSecret('https://y.example')).toBeNull();
  });
});

describe('--minimal on an upgrade', () => {
  it('is kept even when no board URL is configured', async () => {
    writeSettingsEnv({ AGSTATUS_DETAIL: 'off' });
    await runInit({ url: 'https://self.example', noQr: true, codex: false, log });
    expect(settingsEnv().AGSTATUS_DETAIL).toBe('off');
    expect(lines.join('\n')).toContain("Keeping --minimal from this machine's setup");
  });

  // Before the sidecar, the switch was AGSTATUS_DETAIL=off in the registered
  // command, which is the hook's own environment and wins over a sidecar.
  it('is read from a pre-sidecar Codex registration ahead of a sidecar beside it', async () => {
    fs.mkdirSync(path.dirname(codexHooksPath()), { recursive: true });
    const legacy = `CLAUDE_STATUS_URL="${SELF_BOARD}" AGSTATUS_SOURCE=codex AGSTATUS_DETAIL=off node "$HOME/.codex/hooks/agstatus-hook.js"`;
    fs.writeFileSync(codexHooksPath(), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: legacy }] }] } }));
    writeCodexHookConfig(codexConfigPath(), { url: SELF_BOARD, source: 'codex' });

    await runInit({ noQr: true, codex: true, log });
    expect(contacted()).toEqual(['https://self.example']);
    expect(settingsEnv()).toEqual(expect.objectContaining({ CLAUDE_STATUS_URL: SELF_BOARD, AGSTATUS_DETAIL: 'off' }));
    expect(readCodexHookConfig()?.detail).toBe('off');
  });
});

// The installers run `agstatus init` through main(), so the flags are
// checked there: a bare run keeps, the --no- flags turn off.
describe('agstatus init, as the installers run it', () => {
  it('keeps --minimal on a bare run and drops it with --no-minimal', async () => {
    expect(await main(['init', '--url', 'https://self.example', '--minimal', '--no-qr'])).toBe(0);
    expect(settingsEnv().AGSTATUS_DETAIL).toBe('off');
    expect(await main(['init', '--no-qr'])).toBe(0);
    expect(settingsEnv().AGSTATUS_DETAIL).toBe('off');
    expect(await main(['init', '--no-minimal', '--no-qr'])).toBe(0);
    expect(settingsEnv()).not.toHaveProperty('AGSTATUS_DETAIL');
  });

  it('keeps the secret on a bare run and drops it with --no-secret', async () => {
    expect(await main(['init', '--url', 'https://x.example', '--secret', 'S_X', '--no-qr'])).toBe(0);
    expect(settingsEnv().CLAUDE_STATUS_SECRET).toBe('S_X');
    expect(await main(['init', '--no-qr'])).toBe(0);
    expect(settingsEnv()).toEqual(expect.objectContaining({ CLAUDE_STATUS_URL: 'https://x.example', CLAUDE_STATUS_SECRET: 'S_X' }));
    expect(await main(['init', '--no-secret', '--no-qr'])).toBe(0);
    expect(settingsEnv()).not.toHaveProperty('CLAUDE_STATUS_SECRET');
  });
});
