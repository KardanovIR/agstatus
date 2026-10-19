import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Drives the REAL hook with Focus switched on and checks the two records it
 * keeps: the three-label `host` summary on the wire and the full local record
 * under the state dir. Same capture server as messages.test.ts.
 *
 * Two things keep these runs identical on a developer's Mac and on CI. Every
 * input host detection reads is pinned: HOME and AGSTATUS_STATE_DIR are fresh
 * temp dirs, and every env var the hook looks at is scrubbed before a test
 * sets its own. And the hook is started by a throwaway parent that exits at
 * once, so its ancestry never reaches the terminal .app vitest runs in —
 * otherwise the ppid walk would (correctly) report that terminal instead of
 * the env markers a test sets. Tests that need a stable agent pid across two
 * events pin CLAUDE_PID, exactly as Claude Code does.
 */

const HOOK = path.resolve(__dirname, '..', 'assets', 'agstatus-hook.js');

const MACHINE_ID = '6f1c2b3a-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const MACHINE = { machineId: MACHINE_ID, name: 'Studio' };

// Everything the hook's host detection reads from the environment, plus the
// variables a developer's own terminal or agent would otherwise leak in.
const SCRUBBED_ENV = [
  'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM', '__CFBundleIdentifier', 'TERMINAL_EMULATOR',
  'AGTERM_SESSION_ID', 'AGTERM_WINDOW_ID', 'AGTERM_WORKSPACE_ID', 'AGTERM_SOCKET',
  'GHOSTTY_SURFACE_ID', 'GHOSTTY_BIN_DIR',
  'KITTY_WINDOW_ID', 'KITTY_PID', 'KITTY_LISTEN_ON', 'KITTY_INSTALLATION_DIR',
  'ITERM_SESSION_ID', 'TERM_SESSION_ID',
  'WEZTERM_PANE', 'WEZTERM_UNIX_SOCKET', 'WEZTERM_EXECUTABLE',
  'ALACRITTY_WINDOW_ID', 'ALACRITTY_SOCKET', 'WARP_IS_LOCAL_SHELL_SESSION',
  'VSCODE_PID', 'VSCODE_GIT_ASKPASS_MAIN', 'CURSOR_TRACE_ID', 'ZED_TERM',
  'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_HOST_SESSION_ID',
  'TMUX', 'TMUX_PANE', 'ZELLIJ', 'ZELLIJ_SESSION_NAME', 'ZELLIJ_PANE_ID', 'STY', 'WINDOW',
  'HERDR_ENV', 'HERDR_SOCKET_PATH', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PANE_ID',
  'HERDR_SESSION', 'HERDR_CLIENT_SOCKET_PATH', 'HERDR_BIN_PATH',
  'WT_SESSION', 'WT_PROFILE_ID', 'WSL_DISTRO_NAME', 'WSL_INTEROP', 'ConEmuHWND',
  'WINDOWID', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP',
  'SWAYSOCK', 'HYPRLAND_INSTANCE_SIGNATURE',
  'KONSOLE_DBUS_SERVICE', 'KONSOLE_DBUS_SESSION', 'KONSOLE_DBUS_WINDOW', 'GNOME_TERMINAL_SERVICE',
  'SSH_CONNECTION',
  'CLAUDE_PID', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  'AGSTATUS_FOCUS', 'AGSTATUS_SOURCE', 'AGSTATUS_STATE_DIR', 'AGSTATUS_DEBUG', 'XDG_STATE_HOME',
];

// Reads the payload, hands it to the hook, and exits without waiting: the hook
// is orphaned, so its ancestry ends at init rather than at a terminal app. Its
// stderr is inherited, which is what makes execFileSync wait for the hook
// itself to finish before returning.
const LAUNCHER = `
  const { spawn } = require('child_process');
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    const hook = spawn(process.execPath, [process.argv[1]], { stdio: ['pipe', 'ignore', 'inherit'] });
    hook.stdin.end(input);
    hook.unref();
  });
`;

interface HostSummary {
  machine: { id: string; name: string };
  app: { slug: string; name: string; kind: string };
}

type Posted = Record<string, unknown> & { host?: HostSummary | null };

interface Workspace {
  home: string;
  state: string;
  env: Record<string, string>;
}

let server: ChildProcess;
let base: string;
let capturePath: string;

beforeAll(async () => {
  capturePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-host-')),
    'posted.jsonl',
  );
  fs.writeFileSync(capturePath, '');

  const script = `
    const http = require('http'), fs = require('fs');
    const out = process.argv[1];
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        if (req.url === '/webhook') fs.appendFileSync(out, b + '\\n');
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      });
    });
    srv.listen(0, '127.0.0.1', () => process.stdout.write('PORT ' + srv.address().port + '\\n'));
  `;
  server = spawn(process.execPath, ['-e', script, capturePath], { stdio: ['ignore', 'pipe', 'ignore'] });

  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('capture server did not start')), 10_000);
    server.stdout!.on('data', (chunk: Buffer) => {
      const m = /PORT (\d+)/.exec(chunk.toString());
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
  });
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.kill();
});

/**
 * Fires the hook with the given payload fields and returns what it posted.
 * `hook` points at a copy of the script when a test needs its own __dirname —
 * the sidecar config is resolved relative to the script, not to a fixed path.
 */
function fireEvent(
  payload: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
  hook: string = HOOK,
): Posted | undefined {
  fs.writeFileSync(capturePath, '');
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of SCRUBBED_ENV) delete env[key];
  execFileSync(process.execPath, ['-e', LAUNCHER, hook], {
    input: JSON.stringify({
      session_id: 'msg-test',
      cwd: '/tmp/demo-project',
      ...payload,
    }),
    // AGSTATUS_USAGE=off: never read real credentials from a test.
    env: { ...env, CLAUDE_STATUS_URL: base, AGSTATUS_USAGE: 'off', ...extraEnv },
    timeout: 8000,
  });
  // SessionEnd only issues a DELETE, which the capture server never records.
  if (payload.hook_event_name === 'SessionEnd') return undefined;
  // The hook awaits its POST before exiting, but the server still has to write.
  const deadline = Date.now() + 3000;
  for (;;) {
    const lines = fs.readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length > 0) return JSON.parse(lines[0]) as Posted;
    if (Date.now() > deadline) return undefined;
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},50)']); // brief pause
  }
}

/** Resolves once `test()` is true, so a test can wait on a process it drives. */
function waitFor(test: () => boolean, what: string, ms = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      if (test()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

/**
 * The hook as Codex runs it under fish or nu: a long-lived process named
 * `codex` that hands every event to a throwaway wrapper shell, so the hook's
 * parent is a fresh pid each time and never the agent's — the case the ppid
 * walk exists for. The agent is a symlink to /bin/sh because `ps` reports the
 * name a process was launched with, and a copy of the binary would not run on
 * a Mac. The wrapper's command ends in `:` so that shell cannot exec the hook
 * in its own place — that exec is what makes the hook a direct child of the
 * agent under zsh and bash, and what fish and nu leave out.
 */
function wrapperAgent(extraEnv: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-agent-'));
  const codex = path.join(dir, 'codex');
  const payloadFile = path.join(dir, 'payload.json');
  // Linux reports `comm` from the executable FILE's name, macOS from the name
  // it was invoked by — so a symlink called `codex` reads back as `sh` on a
  // Linux runner and findAgent() never sees an agent at all. A copy carries the
  // name on both. (Copying is Linux-only: on macOS a copied system binary can
  // trip the arm64 signature check, and the symlink works there anyway.)
  if (process.platform === 'linux') {
    fs.copyFileSync('/bin/sh', codex);
    fs.chmodSync(codex, 0o755);
  } else {
    fs.symlinkSync('/bin/sh', codex);
  }

  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of SCRUBBED_ENV) delete env[key];
  const agent = spawn(codex, [], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...env, CLAUDE_STATUS_URL: base, AGSTATUS_USAGE: 'off', ...extraEnv },
  });
  let out = '';
  agent.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString(); });

  return {
    pid: agent.pid!,
    /** One event through a wrapper shell of its own: what it posted, and that shell's pid. */
    async fire(payload: Record<string, unknown>): Promise<{ posted?: Posted; wrapper: number }> {
      fs.writeFileSync(capturePath, '');
      fs.writeFileSync(
        payloadFile,
        JSON.stringify({ session_id: 'msg-test', cwd: '/tmp/demo-project', ...payload }),
      );
      out = '';
      agent.stdin!.write(
        `/bin/sh -c 'echo wrapper=$$; "${process.execPath}" "${HOOK}" < "${payloadFile}"; :'\n` +
          'echo done\n',
      );
      await waitFor(() => out.includes('done\n'), 'the hook to exit');
      const wrapper = Number(/wrapper=(\d+)/.exec(out)![1]);
      // SessionEnd only issues a DELETE, which the capture server never records.
      if (payload.hook_event_name === 'SessionEnd') return { wrapper };
      await waitFor(() => fs.readFileSync(capturePath, 'utf8').trim() !== '', 'the post');
      const line = fs.readFileSync(capturePath, 'utf8').trim().split('\n')[0];
      return { posted: JSON.parse(line) as Posted, wrapper };
    },
    stop() {
      agent.stdin!.end();
      agent.kill();
    },
  };
}

/** A fresh HOME (with ~/.agstatus.json) and state dir (with machine.json). */
function workspace(
  config: Record<string, unknown> | null,
  machine: Record<string, unknown> | null = MACHINE,
): Workspace {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-home-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-state-'));
  if (config) fs.writeFileSync(path.join(home, '.agstatus.json'), JSON.stringify({ url: base, ...config }));
  if (machine) fs.writeFileSync(path.join(state, 'machine.json'), JSON.stringify(machine));
  return { home, state, env: { HOME: home, AGSTATUS_STATE_DIR: state } };
}

/** Every file under the state dir, relative, so "nothing was written" is checkable. */
function stateFiles(state: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(state, full));
    }
  };
  walk(state);
  return out.sort();
}

/** The single record the hook wrote for a session, plus its path. */
function readRecord(state: string, session = 'msg-test'): { file: string; record: Record<string, any> } {
  const dir = path.join(state, 'sessions', session);
  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  expect(names).toHaveLength(1);
  const file = path.join(dir, names[0]);
  return { file, record: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function expectedMachineId(): string {
  // Two rounds, like the hook: the key is the listener's credential, the id is on the wire.
  const key = crypto.createHash('sha256').update(`${MACHINE_ID}\n${base}`).digest('hex');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

describe('focus host summary', () => {
  it('leaves the payload byte-identical and writes nothing when focus is not configured', () => {
    const ws = workspace({});
    const posted = fireEvent({ hook_event_name: 'SessionStart' }, ws.env);
    expect(posted).toBeDefined();
    expect(Object.keys(posted!)).toEqual(['session_id', 'name', 'status', 'message', 'project', 'source']);
    expect(stateFiles(ws.state)).toEqual(['machine.json']);
  });

  it('stays off without a machine.json, even with focus: true', () => {
    const ws = workspace({ focus: true }, null);
    const posted = fireEvent({ hook_event_name: 'SessionStart' }, ws.env);
    expect(posted).toBeDefined();
    expect(posted).not.toHaveProperty('host');
    expect(stateFiles(ws.state)).toEqual([]);
  });

  it('honors AGSTATUS_FOCUS=off over the config file', () => {
    const ws = workspace({ focus: true });
    const posted = fireEvent({ hook_event_name: 'SessionStart' }, { ...ws.env, AGSTATUS_FOCUS: 'off' });
    expect(posted).toBeDefined();
    expect(posted).not.toHaveProperty('host');
    expect(stateFiles(ws.state)).toEqual(['machine.json']);
  });

  it('sends three labels on the wire and keeps the detail in a 0600 record', () => {
    const ws = workspace({ focus: true });
    const posted = fireEvent(
      { hook_event_name: 'SessionStart' },
      {
        ...ws.env,
        TERM_PROGRAM: 'ghostty',
        TERM: 'xterm-ghostty',
        __CFBundleIdentifier: 'com.umputun.agterm',
        AGTERM_SESSION_ID: '0d8f5c1e-2b7a-4c3d-9e1f-6a5b4c3d2e1f',
        AWS_SECRET_ACCESS_KEY: 'leak',
      },
    );
    expect(posted?.host).toEqual({
      machine: { id: expectedMachineId(), name: 'Studio' },
      app: { slug: 'agterm', name: 'agterm', kind: 'terminal' },
    });
    expect(posted!.host!.machine.id).toMatch(/^[0-9a-f]{32}$/);
    const wire = JSON.stringify(posted);
    for (const needle of ['AGTERM_SESSION_ID', '0d8f5c1e', '/tmp/', 'ttys', 'AWS', 'leak', MACHINE_ID]) {
      expect(wire).not.toContain(needle);
    }

    const { file, record } = readRecord(ws.state);
    expect(path.basename(file)).toBe(`${record.agent_pid}.json`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(ws.state, 'sessions')).mode & 0o777).toBe(0o700);
    expect(record.v).toBe(1);
    expect(record.session_id).toBe('msg-test');
    expect(record.agent).toBe('claude');
    expect(typeof record.agent_pid).toBe('number');
    expect(typeof record.written_at).toBe('number');
    expect(record.ended_at).toBeNull();
    expect(record.cwd).toBe('/tmp/demo-project');
    expect(record.env.AGTERM_SESSION_ID).toBe('0d8f5c1e-2b7a-4c3d-9e1f-6a5b4c3d2e1f');
    expect(record.env.TERM_PROGRAM).toBe('ghostty');
    expect(record.env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(record.env).not.toHaveProperty('CLAUDE_STATUS_URL');
    expect(typeof record.path).toBe('string');
    expect(record.app).toEqual({ bundle: 'com.umputun.agterm', via: 'env' });
    expect(record.summary).toEqual(posted!.host);
  });

  it('never derives the app name from a bundle id the env alone named', () => {
    // No TERM_PROGRAM, an orphaned hook (the ppid walk finds no .app), and a
    // __CFBundleIdentifier outside the slug table: the label must not leak any
    // part of the bundle id, which stays in the local record as a hint.
    const ws = workspace({ focus: true });
    const posted = fireEvent({ hook_event_name: 'SessionStart' }, { ...ws.env, __CFBundleIdentifier: 'co.zeit.hyper' });
    expect(posted?.host?.app).toEqual({ slug: 'other', name: 'Unknown', kind: 'unknown' });
    const wire = JSON.stringify(posted);
    expect(wire).not.toContain('zeit');
    expect(wire).not.toContain('hyper');
    const { record } = readRecord(ws.state);
    expect(record.app).toEqual({ bundle: 'co.zeit.hyper', via: 'env' });
  });

  it('hashes the same machine.id whichever way the board URL was pasted', () => {
    const ids = [base, `${base}/`, `${base}/webhook`, `${base}/webhook/`].map((url) => {
      const ws = workspace({ focus: true });
      const posted = fireEvent({ hook_event_name: 'SessionStart' }, { ...ws.env, CLAUDE_STATUS_URL: url, TERM_PROGRAM: 'ghostty' });
      expect(posted?.host?.app.slug).toBe('ghostty');
      return posted!.host!.machine.id;
    });
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(expectedMachineId());
  });

  it('reports Herdr as the multiplexer and records its pane ids', () => {
    const ws = workspace({ focus: true });
    const posted = fireEvent(
      { hook_event_name: 'SessionStart' },
      {
        ...ws.env,
        HERDR_ENV: '1',
        HERDR_PANE_ID: 'w1:p3',
        HERDR_TAB_ID: 'w1:t1',
        HERDR_WORKSPACE_ID: 'w1',
        HERDR_SOCKET_PATH: '/tmp/x.sock',
        TERM_PROGRAM: 'ghostty',
      },
    );
    expect(posted?.host?.app).toEqual({ slug: 'herdr', name: 'Herdr', kind: 'multiplexer' });
    const { record } = readRecord(ws.state);
    expect(record.mux).toEqual({
      kind: 'herdr',
      target: 'w1:p3',
      tab: 'w1:t1',
      workspace: 'w1',
      socket: '/tmp/x.sock',
    });
    expect(JSON.stringify(posted)).not.toContain('x.sock');
  });

  it('survives tmux markers without a tmux binary, inside the budget', () => {
    const ws = workspace({ focus: true });
    const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-path-'));
    const started = Date.now();
    const posted = fireEvent(
      { hook_event_name: 'SessionStart' },
      {
        ...ws.env,
        PATH: emptyPath,
        TMUX: '/private/tmp/tmux-501/default,4242,0',
        TMUX_PANE: '%3',
        TERM_PROGRAM: 'iTerm.app',
      },
    );
    expect(Date.now() - started).toBeLessThan(3000);
    expect(posted?.host?.app).toEqual({ slug: 'tmux', name: 'tmux', kind: 'multiplexer' });
    const { record } = readRecord(ws.state);
    expect(record.mux).toEqual({ kind: 'tmux', socket: '/private/tmp/tmux-501/default' });
    expect(record.bins).toEqual({});
    expect(record.path).toBe(emptyPath);
  });

  it('posts without host when a first-time detection runs past its deadline', () => {
    const ws = workspace({ focus: true });
    // A tmux that never answers. Its own spawn timeout is 1.5s, so a run that
    // waited for it would land near the safety exit; the whole detection is
    // bounded instead and the post goes out without `host`.
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-slow-'));
    fs.writeFileSync(path.join(binDir, 'tmux'), '#!/bin/sh\nexec /bin/sleep 5\n', { mode: 0o755 });
    const started = Date.now();
    const posted = fireEvent(
      { hook_event_name: 'SessionStart' },
      {
        ...ws.env,
        PATH: binDir,
        TMUX: '/private/tmp/tmux-501/default,4242,0',
        TMUX_PANE: '%3',
        TERM_PROGRAM: 'iTerm.app',
      },
    );
    expect(Date.now() - started).toBeLessThan(2500);
    expect(posted).toBeDefined();
    expect(posted).not.toHaveProperty('host');
    expect(posted?.session_id).toBe('msg-test');
  });

  it('sends host: null and writes nothing when focus is false', () => {
    const ws = workspace({ focus: false });
    const posted = fireEvent({ hook_event_name: 'Stop' }, { ...ws.env, TERM_PROGRAM: 'ghostty' });
    expect(posted).toHaveProperty('host');
    expect(posted!.host).toBeNull();
    expect(stateFiles(ws.state)).toEqual(['machine.json']);
  });

  it('keeps a hostile cwd in the record only, verbatim, and never on the wire', () => {
    const ws = workspace({ focus: true });
    const cwd = '/tmp/x\'";$(touch pwned)/demo-project';
    const posted = fireEvent({ hook_event_name: 'SessionStart', cwd }, { ...ws.env, TERM_PROGRAM: 'ghostty' });
    expect(posted?.host?.app.slug).toBe('ghostty');
    expect(JSON.stringify(posted)).not.toContain('pwned');
    const { record } = readRecord(ws.state);
    expect(record.cwd).toBe(cwd);
    expect(fs.existsSync(path.join(process.cwd(), 'pwned'))).toBe(false);
  });

  it('stamps ended_at on SessionEnd and keeps the record', () => {
    const ws = workspace({ focus: true });
    // Claude Code always names its own pid; that is what keeps the two events
    // on one record here, since the orphaned hook's parent pid is not stable.
    const env = { ...ws.env, CLAUDE_PID: String(process.pid), TERM_PROGRAM: 'ghostty' };
    expect(fireEvent({ hook_event_name: 'SessionStart' }, env)?.host).toBeTruthy();
    const before = readRecord(ws.state);
    expect(before.record.agent_pid).toBe(process.pid);
    expect(before.record.ended_at).toBeNull();

    // SessionEnd issues a DELETE, which the capture server ignores: no post.
    expect(fireEvent({ hook_event_name: 'SessionEnd' }, env)).toBeUndefined();
    const after = readRecord(ws.state);
    expect(after.file).toBe(before.file);
    expect(typeof after.record.ended_at).toBe('number');
    expect(after.record.summary).toEqual(before.record.summary);
    expect(fs.statSync(after.file).mode & 0o777).toBe(0o600);
  });

  it('reuses the record on later events instead of detecting again', () => {
    const ws = workspace({ focus: true });
    const env = { ...ws.env, CLAUDE_PID: String(process.pid), TERM_PROGRAM: 'ghostty' };
    const first = fireEvent({ hook_event_name: 'SessionStart' }, env);
    const { record: fresh } = readRecord(ws.state);
    // A changed environment would classify differently if detection re-ran.
    const second = fireEvent(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { ...env, TERM_PROGRAM: 'iTerm.app' },
    );
    expect(second?.host).toEqual(first?.host);
    const { record: reused } = readRecord(ws.state);
    expect(reused.env.TERM_PROGRAM).toBe('ghostty');
    expect(reused.written_at).toBeGreaterThanOrEqual(fresh.written_at);
    expect(reused.summary).toEqual(fresh.summary);
  });

  it('reuses the record when the hook runs under a wrapper shell, not the agent', async () => {
    // The fish/nu shape: the hook's parent is a wrapper whose pid is new every
    // event, so the record — filed under the pid the walk resolved — can only
    // be found again by reading the session's directory.
    const ws = workspace({ focus: true });
    const agent = wrapperAgent({ ...ws.env, AGSTATUS_SOURCE: 'codex', TERM_PROGRAM: 'ghostty' });
    try {
      const first = await agent.fire({ hook_event_name: 'SessionStart' });
      expect(first.posted?.host).toBeTruthy();
      const before = readRecord(ws.state);
      expect(before.record.agent_comm).toBe('codex');
      expect(before.record.agent_pid).toBe(agent.pid);
      expect(path.basename(before.file)).toBe(`${agent.pid}.json`);
      expect(first.wrapper).not.toBe(agent.pid);

      // An app no environment here could produce: it can only come off disk.
      const sentinel = { slug: 'alacritty', name: 'Alacritty', kind: 'terminal' };
      before.record.summary.app = sentinel;
      fs.writeFileSync(before.file, JSON.stringify(before.record));

      const second = await agent.fire({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });
      expect(second.wrapper).not.toBe(first.wrapper);
      expect(second.posted?.host?.app).toEqual(sentinel);
      const reused = readRecord(ws.state);
      expect(reused.file).toBe(before.file);
      expect(reused.record.written_at).toBeGreaterThanOrEqual(before.record.written_at);

      // And SessionEnd stamps that record, not the wrapper's missing one.
      await agent.fire({ hook_event_name: 'SessionEnd' });
      const ended = readRecord(ws.state);
      expect(ended.file).toBe(before.file);
      expect(typeof ended.record.ended_at).toBe('number');
      expect(ended.record.summary.app).toEqual(sentinel);
    } finally {
      agent.stop();
    }
  });

  it('reads Codex session_meta for the entrypoint, and lets terminal markers win for the app', () => {
    const transcript = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-codex-')), 'rollout.jsonl');
    fs.writeFileSync(
      transcript,
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 't-sub',
          session_id: 't-root',
          parent_thread_id: 't-root',
          originator: 'Codex Desktop',
          source: 'vscode',
          cwd: '/tmp/demo',
        },
      }) + '\n{"type":"turn_context","payload":{}}\n',
    );
    const payload = { hook_event_name: 'SessionStart', transcript_path: transcript };

    const desktop = workspace({ focus: true });
    const posted = fireEvent(payload, { ...desktop.env, AGSTATUS_SOURCE: 'codex' });
    expect(posted?.host?.app).toEqual({ slug: 'codex-desktop', name: 'Codex', kind: 'desktop-app' });
    const { record } = readRecord(desktop.state);
    expect(record.agent).toBe('codex');
    expect(record.entrypoint).toBe('codex-desktop');
    expect(record.transcript_path).toBe(transcript);
    expect(record.codex).toEqual({
      thread_id: 't-sub',
      root_thread_id: 't-root',
      parent_thread_id: 't-root',
      originator: 'Codex Desktop',
      source: 'vscode',
    });
    expect(JSON.stringify(posted)).not.toContain('t-sub');

    const terminal = workspace({ focus: true });
    const inKitty = fireEvent(payload, { ...terminal.env, AGSTATUS_SOURCE: 'codex', TERM_PROGRAM: 'kitty' });
    expect(inKitty?.host?.app).toEqual({ slug: 'kitty', name: 'kitty', kind: 'terminal' });
    expect(readRecord(terminal.state).record.entrypoint).toBe('codex-desktop');
  });

  it('writes nothing for a session id that is not a safe path segment, and still posts', () => {
    const ws = workspace({ focus: true });
    const posted = fireEvent(
      { hook_event_name: 'SessionStart', session_id: '../evil' },
      { ...ws.env, TERM_PROGRAM: 'ghostty' },
    );
    expect(posted?.session_id).toBe('../evil');
    expect(posted).not.toHaveProperty('host');
    expect(stateFiles(ws.state)).toEqual(['machine.json']);
    expect(fs.existsSync(path.join(ws.state, 'evil'))).toBe(false);
  });
});

/**
 * The sidecar config the installer writes next to the hook script
 * (cli/src/codex.ts). This is the only channel a Windows install has — the
 * env-var prefix the Codex command used to carry is a POSIX shell construct
 * that cmd.exe cannot parse — so the hook is driven here exactly as Codex
 * will drive it there: `node "<script>"` and nothing else, no env, no shell.
 * The delivery is identical on every platform, which is what makes a POSIX
 * run real coverage of the Windows one.
 */
describe('sidecar hook config', () => {
  /** A private copy of the hook, so its __dirname holds only this test's config. */
  function installedHook(config: Record<string, unknown> | null): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-hookdir-'));
    const hook = path.join(dir, 'agstatus-hook.js');
    fs.copyFileSync(HOOK, hook);
    if (config) {
      fs.writeFileSync(path.join(dir, 'agstatus-hook.json'), JSON.stringify(config, null, 2) + '\n');
    }
    return hook;
  }

  // '' rather than an absent key: fireEvent always sets CLAUDE_STATUS_URL, and
  // an empty value is what "nothing in the environment" looks like to the hook.
  const NO_ENV_URL = { CLAUDE_STATUS_URL: '' };

  it('takes the board URL and the source tag from the file beside the script', () => {
    const ws = workspace(null, null);
    const hook = installedHook({ url: base, source: 'codex' });
    const posted = fireEvent(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf ./dist' } },
      { ...ws.env, ...NO_ENV_URL },
      hook,
    );
    expect(posted?.source).toBe('codex');
    expect(posted?.status).toBe('coding');
    expect(posted?.message).toBe('rm -rf ./dist');
  });

  it('honors "detail":"off" from the file, with no AGSTATUS_DETAIL anywhere', () => {
    const ws = workspace(null, null);
    const hook = installedHook({ url: base, source: 'codex', detail: 'off' });
    const posted = fireEvent(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf ./dist' } },
      { ...ws.env, ...NO_ENV_URL },
      hook,
    );
    expect(posted?.message).toBe('Bash');
    expect(JSON.stringify(posted)).not.toContain('rm -rf');
    // PermissionRequest text is the other thing the switch has to suppress.
    const blocked = fireEvent(
      { hook_event_name: 'PermissionRequest', message: 'Codex wants to run rm -rf ./dist' },
      { ...ws.env, ...NO_ENV_URL },
      hook,
    );
    expect(blocked?.message).toBe('Needs approval');
  });

  it('lets the environment override the file, key by key', () => {
    const ws = workspace(null, null);
    const hook = installedHook({ url: base, source: 'codex', detail: 'off' });
    const posted = fireEvent(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } },
      { ...ws.env, ...NO_ENV_URL, AGSTATUS_SOURCE: 'claude', AGSTATUS_DETAIL: 'on' },
      hook,
    );
    // AGSTATUS_DETAIL is set but not 'off' — an explicit override, not a miss.
    expect(posted?.source).toBe('claude');
    expect(posted?.status).toBe('testing');
    expect(posted?.message).toBe('npm test');
  });

  it('never takes "source" from ~/.agstatus.json — both agents share that file', () => {
    // A machine runs one board and one ~/.agstatus.json, but two hook copies.
    // Honoring `source` there would tag every Claude Code session as Codex.
    const ws = workspace({ source: 'codex' }, null);
    const posted = fireEvent({ hook_event_name: 'Stop' }, { ...ws.env, ...NO_ENV_URL }, installedHook(null));
    expect(posted?.source).toBe('claude');
    expect(posted?.status).toBe('done');
  });

  it('falls through to ~/.agstatus.json for url and secret when there is no sidecar', () => {
    // The plugin install path: no sidecar at all, config in the home dotfile.
    const ws = workspace({});
    const posted = fireEvent({ hook_event_name: 'Stop' }, { ...ws.env, ...NO_ENV_URL }, installedHook(null));
    expect(posted?.session_id).toBe('msg-test');
    expect(posted?.status).toBe('done');
  });

  it('stays silent when a malformed sidecar is the only configuration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-hookdir-'));
    const hook = path.join(dir, 'agstatus-hook.js');
    fs.copyFileSync(HOOK, hook);
    fs.writeFileSync(path.join(dir, 'agstatus-hook.json'), '{ nope');
    const ws = workspace(null, null);
    // Unreadable config is "not configured", never a crash and never a post.
    expect(fireEvent({ hook_event_name: 'Stop' }, { ...ws.env, ...NO_ENV_URL }, hook)).toBeUndefined();
  });
});

/**
 * The two things a card carries between events: the status a finished turn
 * reports, and the name it keeps while the session moves around the disk.
 *
 * The pin lives in one small JSON file in the system temp dir (the hook's
 * sessionNameFile), so every test here gets a TMPDIR of its own — os.tmpdir()
 * reads TMPDIR on POSIX, and without that a session id would carry its pinned
 * name from one test into the next, exactly as it is meant to inside one
 * machine's real temp dir.
 */
describe('finished turns and pinned names', () => {
  /** A private temp dir, so one test's name map never reaches another. */
  function isolated(): Record<string, string> {
    return { TMPDIR: fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-names-')) };
  }

  /** The hook's name map, by shape rather than by recomputing its hashed path. */
  function nameFiles(tmp: string): string[] {
    return fs.readdirSync(tmp).filter((n) => n.startsWith('agstatus-names-')).sort();
  }

  it('reports a finished turn as done, not idle', () => {
    const ws = workspace(null, null);
    const posted = fireEvent(
      { hook_event_name: 'Stop', session_id: 'turn-1' },
      { ...ws.env, ...isolated() },
    );
    expect(posted?.status).toBe('done');
    expect(posted?.message).toBe('Turn finished');
  });

  it('keeps idle for a session that has not been asked for anything yet', () => {
    const ws = workspace(null, null);
    const posted = fireEvent(
      { hook_event_name: 'SessionStart', session_id: 'turn-2' },
      { ...ws.env, ...isolated() },
    );
    // SessionStart is the only idle left, which is what makes done meaningful.
    expect(posted?.status).toBe('idle');
    expect(posted?.message).toBe('Session started');
  });

  it('keeps the name it was given at SessionStart after the session moves', () => {
    const ws = workspace(null, null);
    const env = { ...ws.env, ...isolated() };

    const started = fireEvent(
      { hook_event_name: 'SessionStart', session_id: 'pin-1', cwd: '/tmp/backend' },
      env,
    );
    expect(started?.name).toBe('backend');
    expect(started?.project).toBe('backend');

    // The agent cd's into a sibling checkout mid-turn. The card is the same
    // card: same name, and `project` follows the session's feet.
    const moved = fireEvent(
      { hook_event_name: 'PreToolUse', session_id: 'pin-1', cwd: '/tmp/docs',
        tool_name: 'Edit', tool_input: { file_path: '/tmp/docs/readme.md' } },
      env,
    );
    expect(moved?.name).toBe('backend');
    expect(moved?.project).toBe('docs');

    const finished = fireEvent(
      { hook_event_name: 'Stop', session_id: 'pin-1', cwd: '/tmp/docs' },
      env,
    );
    expect(finished?.name).toBe('backend');
    expect(finished?.status).toBe('done');

    // /compact fires a second SessionStart under the same id, from wherever
    // the session is standing now. The card is not renamed by it.
    const compacted = fireEvent(
      { hook_event_name: 'SessionStart', session_id: 'pin-1', cwd: '/tmp/docs', source: 'compact' },
      env,
    );
    expect(compacted?.name).toBe('backend');

    // A different session in the same map is named from its own directory —
    // the pin is per session, not per board.
    const other = fireEvent(
      { hook_event_name: 'SessionStart', session_id: 'pin-2', cwd: '/tmp/docs' },
      env,
    );
    expect(other?.name).toBe('docs');

    // And pin-1 still holds after pin-2 rewrote the file around it.
    const again = fireEvent(
      { hook_event_name: 'Stop', session_id: 'pin-1', cwd: '/tmp/elsewhere' },
      env,
    );
    expect(again?.name).toBe('backend');
  });

  it('forgets the pin when the session ends', () => {
    const ws = workspace(null, null);
    const env = { ...ws.env, ...isolated() };
    fireEvent({ hook_event_name: 'SessionStart', session_id: 'gone-1', cwd: '/tmp/backend' }, env);
    fireEvent({ hook_event_name: 'SessionEnd', session_id: 'gone-1', cwd: '/tmp/backend' }, env);

    // The card was deleted, so a session id reused later starts fresh rather
    // than inheriting a name from a session that no longer exists.
    const reused = fireEvent(
      { hook_event_name: 'Stop', session_id: 'gone-1', cwd: '/tmp/docs' },
      env,
    );
    expect(reused?.name).toBe('docs');
  });

  it('falls back to the working directory when SessionStart was never seen', () => {
    const ws = workspace(null, null);
    const env = { ...ws.env, ...isolated() };

    // Installed mid-session: the first event this hook ever sees is a Stop.
    const late = fireEvent(
      { hook_event_name: 'Stop', session_id: 'late-1', cwd: '/tmp/late-install' },
      env,
    );
    expect(late?.name).toBe('late-install');
    expect(late?.project).toBe('late-install');

    // Having adopted that name, it holds it like any other pin.
    const after = fireEvent(
      { hook_event_name: 'Stop', session_id: 'late-1', cwd: '/tmp/somewhere-else' },
      env,
    );
    expect(after?.name).toBe('late-install');
    expect(after?.project).toBe('somewhere-else');
  });

  it('survives a corrupt name map, and repairs it', () => {
    const ws = workspace(null, null);
    const tmp = isolated();
    const env = { ...ws.env, ...tmp };
    fireEvent({ hook_event_name: 'SessionStart', session_id: 'bad-1', cwd: '/tmp/backend' }, env);

    const [file] = nameFiles(tmp.TMPDIR);
    expect(file).toBeDefined();
    const full = path.join(tmp.TMPDIR, file);

    // Half a write, a stray editor, a truncated disk — unparseable either way.
    fs.writeFileSync(full, '{"names": {"bad-1": ');
    const corrupt = fireEvent(
      { hook_event_name: 'Stop', session_id: 'bad-1', cwd: '/tmp/docs' },
      env,
    );
    // The event still goes out; only the pin was lost, so the name degrades to
    // the live directory — what the hook sent before pinning existed.
    expect(corrupt?.status).toBe('done');
    expect(corrupt?.name).toBe('docs');
    // And the file is a usable map again, with the name it just re-pinned.
    expect(JSON.parse(fs.readFileSync(full, 'utf8')).names['bad-1'].name).toBe('docs');

    // Entries that survive parsing but are the wrong shape are dropped one by
    // one, without taking the rest of the map with them.
    fs.writeFileSync(full, JSON.stringify({
      names: { 'bad-1': 'not-an-object', 'bad-2': { name: 'kept', at: Date.now() } },
    }));
    expect(fireEvent({ hook_event_name: 'Stop', session_id: 'bad-1', cwd: '/tmp/x' }, env)?.name)
      .toBe('x');
    expect(fireEvent({ hook_event_name: 'Stop', session_id: 'bad-2', cwd: '/tmp/y' }, env)?.name)
      .toBe('kept');

    // A map too big to be ours is read as empty rather than parsed.
    fs.writeFileSync(full, JSON.stringify({ names: { 'bad-2': { name: 'kept', at: Date.now() } } })
      + ' '.repeat(64 * 1024));
    expect(fireEvent({ hook_event_name: 'Stop', session_id: 'bad-2', cwd: '/tmp/z' }, env)?.name)
      .toBe('z');
  });

  it('posts as usual when the name map cannot be read or written at all', () => {
    const ws = workspace(null, null);
    const tmp = isolated();
    const env = { ...ws.env, ...tmp };
    fireEvent({ hook_event_name: 'SessionStart', session_id: 'stuck-1', cwd: '/tmp/backend' }, env);

    const [file] = nameFiles(tmp.TMPDIR);
    const full = path.join(tmp.TMPDIR, file);
    // A directory where the file belongs: every read throws EISDIR and every
    // rename onto it fails too, so neither path can fall back on the other.
    fs.rmSync(full);
    fs.mkdirSync(full);

    const posted = fireEvent(
      { hook_event_name: 'Stop', session_id: 'stuck-1', cwd: '/tmp/docs' },
      env,
    );
    expect(posted?.status).toBe('done');
    expect(posted?.name).toBe('docs');
    expect(fs.statSync(full).isDirectory()).toBe(true);
  });
});

/**
 * A card named after the session's TITLE when Claude Code has one, and a
 * worktree root's `project` named after its repo — the two changes that take
 * the desktop app's made-up worktree names ("zealous-jennings-84637b") off
 * the board.
 *
 * The transcripts are the shape Claude Code writes: JSONL, with the desktop
 * app's (and `/rename`'s) `custom-title` record re-appended among the
 * conversation records and stamped with the session id the hook payload
 * carries. The hook reads only the last 256 KiB of a transcript
 * (TITLE_TAIL_BYTES), so "scrolled out of the window" below means tool-result
 * records of a realistic size appended until the title sits further back than
 * that. Like the pinned-name tests above, every test has a TMPDIR of its own.
 */
describe('session titles and worktree projects', () => {
  const SESSION = '5b3e8f2a-1c4d-4e6f-8a9b-0c1d2e3f4a5b';
  const OTHER = '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a';
  const TAIL = 256 * 1024;
  const WORKTREE = '/Users/x/claude-status/.claude/worktrees/zealous-jennings-84637b';

  function isolated(): Record<string, string> {
    return { TMPDIR: fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-titles-')) };
  }

  function env(): Record<string, string> {
    return { ...workspace(null, null).env, ...isolated() };
  }

  const title = (customTitle: unknown, sessionId: unknown = SESSION) =>
    JSON.stringify({ type: 'custom-title', customTitle, sessionId });

  const prompt = (text: string) =>
    JSON.stringify({ type: 'user', sessionId: SESSION, message: { role: 'user', content: text } });

  /** Tool-result records adding up to at least `bytes`: what a transcript is mostly made of. */
  function filler(bytes: number): string[] {
    const line = JSON.stringify({
      type: 'user', sessionId: SESSION,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(8 * 1024) }] },
    });
    return Array.from({ length: Math.ceil(bytes / (line.length + 1)) }, () => line);
  }

  function transcript(lines: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-transcript-'));
    const file = path.join(dir, `${SESSION}.jsonl`);
    fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
    return file;
  }

  const append = (file: string, lines: string[]) =>
    fs.appendFileSync(file, lines.map((l) => `${l}\n`).join(''));

  /** One event of the session, standing in `cwd`, with `file` as its transcript. */
  function fire(
    event: string,
    cwd: string,
    file: string,
    e: Record<string, string>,
    session = SESSION,
  ): Posted | undefined {
    const tool = event === 'PreToolUse'
      ? { tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'store.ts') } }
      : {};
    return fireEvent(
      { hook_event_name: event, session_id: session, cwd, transcript_path: file, ...tool },
      e,
    );
  }

  /** The hook's name map, read back by shape rather than by its hashed path. */
  function nameMap(tmp: string): { path: string; raw: string } {
    const [file] = fs.readdirSync(tmp).filter((n) => n.startsWith('agstatus-names-'));
    const full = path.join(tmp, file);
    return { path: full, raw: fs.readFileSync(full, 'utf8') };
  }

  it('names the card after the title in the transcript tail', () => {
    const file = transcript([
      prompt('Organize the board by agent'),
      title('Session organization by agent'),
      ...filler(24 * 1024),
    ]);
    const posted = fire('SessionStart', WORKTREE, file, env());
    expect(posted?.name).toBe('Session organization by agent');
    // And the worktree's made-up folder is not put straight back as the project.
    expect(posted?.project).toBe('claude-status');
  });

  it('cleans and caps a title the way the server would, and never clears one', () => {
    const e = env();
    const messy = transcript([title('\n\t  Fix   the\u0007 login\r\nbug  ')]);
    expect(fire('Stop', '/tmp/repo', messy, e)?.name).toBe('Fix the login bug');

    // NAME_MAX is 120 UTF-16 units, the server's own cut.
    const long = transcript([title('y'.repeat(300))]);
    expect(fire('Stop', '/tmp/repo', long, e)?.name).toBe('y'.repeat(120));

    // An emoji straddling the cut is dropped whole, not halved into a lone
    // surrogate the server would then store.
    const emoji = transcript([title(`${'a'.repeat(119)}\u{1F600}tail`)]);
    expect(fire('Stop', '/tmp/repo', emoji, e)?.name).toBe('a'.repeat(119));

    // A title that cleans to nothing is no title — and does not wipe the one
    // already pinned.
    const blank = transcript([title(' \n\t ')]);
    expect(fire('Stop', '/tmp/repo', blank, e)?.name).toBe('a'.repeat(119));
  });

  // The title read runs on every event, before the status post, and a plain
  // blocking open of a FIFO waits for a writer with the event loop stalled —
  // so the 4 s safety exit never fires, and every PreToolUse would hold the
  // agent until Claude Code's own hook timeout killed the run. Claude Code
  // never hands the hook a FIFO; this pins that a path which is not a regular
  // file costs the title and nothing else.
  it.skipIf(process.platform === 'win32')(
    'never blocks on a transcript path that is a FIFO or a directory, and still posts',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-fifo-'));
      const fifo = path.join(dir, `${SESSION}.jsonl`);
      execFileSync('mkfifo', [fifo]);
      try {
        const started = Date.now();
        const posted = fire('PreToolUse', '/tmp/fifo-repo', fifo, env());
        expect(posted?.name).toBe('fifo-repo');
        expect(posted?.status).toBe('coding');
        // Well inside the safety exit: a hook that waited on the FIFO would have
        // been killed by fireEvent's own 8 s timeout instead of posting at all.
        expect(Date.now() - started).toBeLessThan(4000);

        const posted2 = fire('PreToolUse', '/tmp/dir-repo', dir, env());
        expect(posted2?.name).toBe('dir-repo');
      } finally {
        // Should a regression leave a hook blocked in that open, a writer
        // releases it rather than leaving it orphaned for the rest of the run.
        try {
          fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
        } catch {
          /* ENXIO: no reader is waiting, which is the point */
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('takes the last title in the transcript, so a rename renames the card once more', () => {
    const e = env();
    const file = transcript([
      title('First name'), ...filler(16 * 1024),
      title('First name'), ...filler(16 * 1024),
      title('Renamed'), ...filler(16 * 1024),
    ]);
    expect(fire('Stop', '/tmp/repo', file, e)?.name).toBe('Renamed');

    append(file, [prompt('rename it again'), title('Renamed again')]);
    expect(fire('PreToolUse', '/tmp/repo', file, e)?.name).toBe('Renamed again');
  });

  it('keeps a title that has scrolled out of the window since an earlier event saw it', () => {
    const e = env();
    const file = transcript([title('Session organization by agent'), ...filler(4 * 1024)]);
    expect(fire('Stop', '/tmp/repo', file, e)?.name).toBe('Session organization by agent');

    // A screenshot's worth of tool output later, the record is out of reach —
    // and the session has wandered off, too. The card holds still.
    append(file, filler(TAIL + 64 * 1024));
    const later = fire('PreToolUse', '/tmp/elsewhere', file, e);
    expect(later?.name).toBe('Session organization by agent');
    expect(later?.project).toBe('elsewhere');
  });

  it('reads only the tail: a title further back than the window is never found', () => {
    // The same title, once just inside the window and once just outside it.
    const inside = transcript([title('Within reach'), ...filler(TAIL - 16 * 1024)]);
    expect(fs.statSync(inside).size).toBeLessThan(TAIL);
    expect(fire('Stop', '/tmp/repo', inside, env())?.name).toBe('Within reach');

    const outside = transcript([title('Out of reach'), ...filler(TAIL + 1024)]);
    const posted = fire('Stop', '/tmp/repo', outside, env());
    // Never seen, so the card keeps exactly what it had before titles: its folder.
    expect(posted?.name).toBe('repo');
    expect(posted?.status).toBe('done');
  });

  it('reads a record that starts exactly at the window edge, and never a fragment of one', () => {
    // Filler records adding up to EXACTLY `bytes`, newlines included, so a
    // record can be placed on a known byte of the window. All ASCII: one
    // character is one byte.
    function exactly(bytes: number): string[] {
      const record = (n: number) => JSON.stringify({ type: 'user', sessionId: SESSION, content: 'x'.repeat(n) });
      const overhead = record(0).length + 1;
      const out: string[] = [];
      let left = bytes;
      while (left > 2 * (8 * 1024 + overhead)) {
        out.push(record(8 * 1024));
        left -= 8 * 1024 + overhead;
      }
      out.push(record(left - overhead));
      return out;
    }
    const edge = title('At the edge');
    // From the record's first byte to the end of the file is exactly the window.
    const after = TAIL - edge.length - 1;

    const whole = transcript([prompt('before'), edge, ...exactly(after)]);
    expect(fs.statSync(whole).size - fs.readFileSync(whole, 'latin1').lastIndexOf(edge)).toBe(TAIL);
    // The byte before the window is the newline that ends `before`: whole.
    expect(fire('Stop', '/tmp/repo', whole, env())?.name).toBe('At the edge');

    // One byte further back and the record began before the window.
    const early = transcript([prompt('before'), edge, ...exactly(after + 1)]);
    expect(fire('Stop', '/tmp/repo', early, env())?.name).toBe('repo');

    // A mangled line whose tail, from the window's first byte on, happens to
    // be a complete title record: a fragment all the same, so never parsed.
    const fragment = transcript([`garbage-${title('Fragment')}`, ...exactly(TAIL - title('Fragment').length - 1)]);
    expect(fire('Stop', '/tmp/repo', fragment, env())?.name).toBe('repo');
  });

  it('ignores a title recorded for another session', () => {
    const mine = transcript([title('Mine'), ...filler(8 * 1024), title('Someone else', OTHER)]);
    expect(fire('Stop', '/tmp/repo', mine, env())?.name).toBe('Mine');

    const theirs = transcript([title('Someone else', OTHER)]);
    expect(fire('Stop', '/tmp/repo', theirs, env())?.name).toBe('repo');

    // A record with no id at all is taken to be this transcript's own.
    const unstamped = transcript([JSON.stringify({ type: 'custom-title', customTitle: 'Unstamped' })]);
    expect(fire('Stop', '/tmp/repo', unstamped, env())?.name).toBe('Unstamped');
  });

  it('skips title lines that do not parse, and records that only mention a title', () => {
    const file = transcript([
      title('Good title'),
      title(42),
      // A tool call whose input happens to be shaped like a title record: the
      // line is an assistant record, whatever it carries.
      JSON.stringify({
        type: 'assistant', sessionId: SESSION,
        message: { content: [{ type: 'tool_use', name: 'Write',
          input: { type: 'custom-title', customTitle: 'Impostor', sessionId: SESSION } }] },
      }),
      // A tool result quoting a title record as text.
      JSON.stringify({ type: 'user', sessionId: SESSION, message: { content: [{ type: 'tool_result', content: title('Quoted') }] } }),
      '{"type":"custom-title","customTitle":"Mangled", "sessionId": ',
    ]);
    // And a record Claude Code is halfway through appending: no newline yet.
    fs.appendFileSync(file, `{"type":"custom-title","customTitle":"Half writ`);
    expect(fire('Stop', '/tmp/repo', file, env())?.name).toBe('Good title');
  });

  it('keeps folder names in minimal mode, even for a session it has already titled', () => {
    const e = env();
    const minimal = { ...e, AGSTATUS_DETAIL: 'off' };
    const file = transcript([title('Payroll export for the board meeting'), ...filler(4 * 1024)]);

    const first = fire('SessionStart', WORKTREE, file, minimal);
    // The worktree folder, not the repo: several worktrees of one repo must
    // stay apart, and in minimal mode there is nothing else to tell them by.
    expect(first?.name).toBe('zealous-jennings-84637b');
    expect(first?.project).toBe('claude-status');
    // Withheld, not merely unsent: minimal mode never reads it into the map.
    expect(nameMap(e.TMPDIR).raw).not.toContain('Payroll');

    expect(fire('Stop', WORKTREE, file, e)?.name).toBe('Payroll export for the board meeting');

    // Minimal switched on mid-session, after the session moved: back to the
    // folder it started in — not the title, and not where it stands now.
    expect(fire('Stop', '/tmp/elsewhere', file, minimal)?.name).toBe('zealous-jennings-84637b');
  });

  it('holds a title for a session with no folder, and leaves the placeholder unpinned without one', () => {
    // A GUI-launched agent stands at `/`, and basename('/') is ''. Without a
    // title that is master's placeholder exactly — the agent's name, never
    // pinned, so the first real folder still claims the card. WITH a title the
    // title has to be pinned all the same, or the next event's tail read (which
    // will most likely miss the record) would drop the card back to "Claude".
    const e = env();
    const names = () => fs.readdirSync(e.TMPDIR).filter((n) => n.startsWith('agstatus-names-'));
    const file = transcript([prompt('hello'), ...filler(4 * 1024)]);

    expect(fire('SessionStart', '/', file, e)?.name).toBe('Claude');
    expect(names()).toEqual([]); // the placeholder is not written down

    append(file, [title('Desktop session with no folder')]);
    expect(fire('Stop', '/', file, e)?.name).toBe('Desktop session with no folder');
    // Stored with an empty folder beside it: the title is what has to hold.
    expect(JSON.parse(nameMap(e.TMPDIR).raw).names[SESSION]).toMatchObject({
      name: '', title: 'Desktop session with no folder',
    });

    // Out of reach of the tail read, and still standing at `/`: the pin holds.
    append(file, filler(TAIL + 64 * 1024));
    expect(fire('PreToolUse', '/', file, e)?.name).toBe('Desktop session with no folder');

    // A bare-UUID folder is no folder either, so it is not adopted…
    const scratch = '/Users/x/.codex/visualizations/2026/10/02/01a0fd9d-47fd-7602-82b0-31491467be57';
    expect(fire('Stop', scratch, file, e)?.name).toBe('Desktop session with no folder');
    expect(JSON.parse(nameMap(e.TMPDIR).raw).names[SESSION].name).toBe('');

    // …and the first real one is: the title still wins, and the folder is
    // what minimal mode falls back to — the one the placeholder would have
    // handed the card to.
    expect(fire('Stop', '/tmp/my-repo', file, e)?.name).toBe('Desktop session with no folder');
    expect(fire('Stop', '/tmp/elsewhere', file, { ...e, AGSTATUS_DETAIL: 'off' })?.name).toBe('my-repo');

    // A titled session that never found a folder, read with titles off, has
    // nothing but the placeholder to show.
    const other = transcript([title('Another folderless one', OTHER)]);
    expect(fire('Stop', '/', other, e, OTHER)?.name).toBe('Another folderless one');
    expect(fire('Stop', '/', other, { ...e, AGSTATUS_DETAIL: 'off' }, OTHER)?.name).toBe('Claude');
  });

  it('never takes a title for a Codex session', () => {
    const file = transcript([title('A record Codex never writes')]);
    const posted = fire('Stop', '/tmp/codex-repo', file, { ...env(), AGSTATUS_SOURCE: 'codex' });
    expect(posted?.source).toBe('codex');
    expect(posted?.name).toBe('codex-repo');
  });

  it('falls back to the folder when the transcript cannot be read', () => {
    const e = env();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-transcript-'));
    for (const file of [path.join(dir, 'missing.jsonl'), dir, 'relative/session.jsonl']) {
      const posted = fire('Stop', '/tmp/repo', file, e);
      expect(posted?.status).toBe('done');
      expect(posted?.name).toBe('repo');
    }
  });

  it('keeps the name map private once it holds a title', () => {
    if (process.platform === 'win32') return;
    const e = env();
    fire('Stop', '/tmp/repo', transcript([title('Private words')]), e);
    const map = nameMap(e.TMPDIR);
    expect(JSON.parse(map.raw).names[SESSION]).toMatchObject({ name: 'repo', title: 'Private words' });
    expect(fs.statSync(map.path).mode & 0o777).toBe(0o600);
  });

  it('names a worktree root after its repo, and nothing else', () => {
    const e = env();
    // [cwd, name, project]. With no title, the name is always the folder.
    const cases: Array<[string, string, string]> = [
      [WORKTREE, 'zealous-jennings-84637b', 'claude-status'],
      [`${WORKTREE}/`, 'zealous-jennings-84637b', 'claude-status'],
      ['/Users/x/claude-status/.claude/worktrees/brave-curie-1a2b3c', 'brave-curie-1a2b3c', 'claude-status'],
      // Inside a worktree: a subdirectory, like a cd'd session in any checkout.
      [`${WORKTREE}/cli`, 'cli', 'cli'],
      [`${WORKTREE}/.claude/settings`, 'settings', 'settings'],
      // A normal checkout, and the paths around a worktree that are not one.
      ['/Users/x/claude-status', 'claude-status', 'claude-status'],
      ['/Users/x/claude-status/.claude/worktrees', 'worktrees', 'worktrees'],
      ['/Users/x/claude-status/.claude', '.claude', '.claude'],
      ['/Users/x/claude-status/build/worktrees/nightly', 'nightly', 'nightly'],
      ['/Users/x/claude-status/claude/worktrees/nightly', 'nightly', 'nightly'],
      // A worktree cut from inside another names the repo at the bottom.
      [`${WORKTREE}/.claude/worktrees/inner-name`, 'inner-name', 'claude-status'],
      // Hung off the filesystem root, there is no repo name to give.
      ['/.claude/worktrees/rootless', 'rootless', 'rootless'],
    ];
    cases.forEach(([cwd, name, project], i) => {
      const posted = fireEvent({ hook_event_name: 'SessionStart', session_id: `wt-${i}`, cwd }, e);
      expect({ cwd, name: posted?.name, project: posted?.project }).toEqual({ cwd, name, project });
    });
  });
});
