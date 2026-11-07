import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { runInit } from '../src/index';
import { settingsPath } from '../src/settings';

/**
 * Subagents across every layer at once (spec 8.1, the cross-layer run): the
 * real `agstatus init` into a throwaway HOME, the real compiled server
 * (dist/server.js) in a process of its own, and the hook init installed,
 * fired with the probe payloads (fixtures/subtasks) the way Claude Code runs
 * it — the file its registration names, with the env block init wrote, and
 * only for the events and tools a registration matches. After each event the
 * board is read back the way a client reads it, GET /api/sessions, and the
 * card's status, message and `subtasks` are compared whole with spec 5.
 *
 * subtasks.test.ts pins every request the hook makes against a capture
 * server, and the root suite pins what the server makes of recorded bodies.
 * This file is the seam between the two: no body here is recorded, so a field
 * the two sides spell or order differently fails here even when both of those
 * suites pass.
 *
 * Every test installs its own board, so the cards never meet. The server runs
 * multi-tenant, as the hosted board does, with its 120-posts-a-minute webhook
 * window on; no test comes near it.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER_JS = path.join(ROOT, 'dist', 'server.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'subtasks');

type Json = Record<string, any>;

// The probe sessions and subagents (see subtasks.test.ts).
const A = '5cef7152-ef68-481f-8a4f-463f66702bf9'; // run a: parallel foreground
const C = 'ce4d79fa-d133-4666-ac0b-be13150d339a'; // run c: background
const D2 = 'fdabcccc-3f36-4fed-9029-f326702a365b'; // run d2: permission prompt
const ALPHA = 'a28b0e80d3d1190c2';
const BETA = 'afbeec30e716aefa1';
const BG = 'a81211a654bc21fa3';
const TOUCH = 'a9f11cbaeca3764d9';

let server: ChildProcess | undefined;
let origin: string;
let scratch: string;
let clock: string;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Whether the server answers before it exits or `ms` pass. */
async function answers(base: string, child: ChildProcess, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok && ((await res.json()) as Json).ok === true) return child.exitCode === null;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

beforeAll(async () => {
  if (!fs.existsSync(SERVER_JS)) {
    throw new Error('dist/server.js missing — run `npm run build` at the repo root first');
  }
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-sube2e-'));
  // A permission prompt is notified only once it has waited 2 s; this moves
  // the hook's clock forward instead of making the test wait.
  clock = path.join(scratch, 'clock.js');
  fs.writeFileSync(
    clock,
    'const shift = Number(process.env.CLOCK_SHIFT_MS) || 0;\nconst now = Date.now;\nDate.now = () => now() + shift;\n',
  );
  // A sibling process, as in e2e.test.ts: some sandboxes stop a subprocess
  // from reaching a port the vitest worker owns. Its environment is spelled
  // out, so a developer's DATABASE_URL or APNs keys never reach it. A port
  // taken between the probe and the bind makes the server exit: try another.
  for (let attempt = 1; ; attempt += 1) {
    const port = await freePort();
    const child = spawn(process.execPath, [SERVER_JS], {
      env: {
        PATH: process.env.PATH ?? '',
        PORT: String(port),
        HOST: '127.0.0.1',
        MULTI_TENANT: 'true',
        PUBLIC_URL: `http://127.0.0.1:${port}`,
        SESSION_TTL_MS: '0',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    if (await answers(`http://127.0.0.1:${port}`, child)) {
      server = child;
      origin = `http://127.0.0.1:${port}`;
      return;
    }
    child.kill();
    if (attempt === 3) throw new Error(`dist/server.js did not come up: ${stderr.trim() || 'no output'}`);
  }
});

afterAll(() => {
  server?.kill();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

// ---- one machine, set up by init --------------------------------------------------

interface Hooks {
  [event: string]: Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
}

interface Board {
  /** The board init chose, as the hook sees it: <origin>/w/<token>. */
  url: string;
  /** The env block init wrote into settings.json. */
  env: Record<string, string>;
  hooks: Hooks;
  home: string;
  tmp: string;
  state: string;
  codex: string;
  projects: string;
  cwd: string;
}

/**
 * Runs the real `agstatus init` (`--minimal` when asked) into a HOME of its
 * own: no ~/.claude, ~/.codex or ~/.agstatus of the machine running the tests
 * is read or written. CLAUDE_CONFIG_DIR is unset for it, so the hook lands
 * where every install puts it and is registered as `node "$HOME/…"`.
 */
async function install(opts: { minimal?: boolean } = {}): Promise<Board> {
  const root = fs.mkdtempSync(path.join(scratch, 'machine-'));
  const dirs = {
    home: path.join(root, 'home'),
    tmp: path.join(root, 'tmp'),
    state: path.join(root, 'state'),
    projects: path.join(root, 'projects'),
    cwd: path.join(root, 'proj'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  // Never created: init finds no Codex to set up, and the hook nothing there.
  const codex = path.join(root, 'codex');

  const keys = ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_STATUS_URL'] as const;
  const saved = keys.map((k) => process.env[k]);
  let settings: Json;
  try {
    process.env.HOME = dirs.home;
    process.env.CODEX_HOME = codex;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_STATUS_URL;
    await runInit({ url: origin, noQr: true, minimal: opts.minimal, log: () => undefined });
    settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Json;
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
  const env = settings.env as Record<string, string>;
  expect(env.CLAUDE_STATUS_URL).toMatch(new RegExp(`^${origin}/w/ags_[A-Za-z0-9_-]{32}$`));
  return { url: env.CLAUDE_STATUS_URL, env, hooks: settings.hooks as Hooks, codex, ...dirs };
}

/**
 * The hook's process environment under Claude Code: the session's own, plus
 * settings.json's env block. Whatever a developer's shell or agent exports
 * for AgStatus, Claude or Codex is dropped first. The usage report stays off
 * (it would read real credentials and call Anthropic), and the Focus state
 * directory points into the test's machine.
 */
function hookEnv(b: Board, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(AGSTATUS_|CLAUDE_|CODEX_)/.test(k) || ['HOME', 'TMPDIR', 'TMP', 'TEMP'].includes(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: b.home,
    TMPDIR: b.tmp,
    CODEX_HOME: b.codex,
    AGSTATUS_STATE_DIR: b.state,
    AGSTATUS_USAGE: 'off',
    ...b.env,
    ...extra,
  };
}

/**
 * Runs the installed hook on one event, as Claude Code would: the script its
 * registration names, only when that event is registered and its matcher
 * takes the tool. A payload Claude Code would never hand the hook fails the
 * test rather than passing it through. `clockMs` moves the hook's clock
 * forward by that much.
 */
function fire(b: Board, payload: Json, opts: { env?: Record<string, string>; clockMs?: number } = {}): void {
  const event = String(payload.hook_event_name);
  const entry = (b.hooks[event] ?? []).find((e) => e.hooks.some((h) => h.command.includes('agstatus-hook')));
  expect(entry, `${event} is not registered`).toBeDefined();
  if (entry!.matcher !== undefined) {
    const takes = new RegExp(`^(?:${entry!.matcher})$`).test(String(payload.tool_name));
    expect(takes, `${event} is registered for ${entry!.matcher}, not ${payload.tool_name}`).toBe(true);
  }
  const command = entry!.hooks.find((h) => h.command.includes('agstatus-hook'))!.command;
  const script = /^node "(.+)"$/.exec(command)?.[1].replace(/^\$HOME(?=\/)/, b.home);
  expect(script && fs.existsSync(script), command).toBe(true);
  const env: Record<string, string> = { ...opts.env };
  const nodeArgs: string[] = [];
  if (opts.clockMs) {
    env.CLOCK_SHIFT_MS = String(opts.clockMs);
    nodeArgs.push('--require', clock);
  }
  execFileSync(process.execPath, [...nodeArgs, script!], {
    input: JSON.stringify(payload),
    env: hookEnv(b, env),
    timeout: 10_000,
  });
}

/** A probe payload with its paths pointed into this test's machine. */
function load(b: Board, name: string, overrides: Json = {}): Json {
  const esc = (s: string) => JSON.stringify(s).slice(1, -1);
  const raw = fs
    .readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')
    .replaceAll('{{projects}}', esc(b.projects))
    .replaceAll('{{cwd}}', esc(b.cwd))
    .replaceAll('{{tmp}}', esc(b.tmp));
  return { ...(JSON.parse(raw).payload as Json), ...overrides };
}

/** A Notification about a permission prompt still waiting (it carries no agent_id). */
const prompted = (b: Board, session: string, message: string): Json => ({
  session_id: session,
  transcript_path: path.join(b.projects, `${session}.jsonl`),
  cwd: b.cwd,
  hook_event_name: 'Notification',
  notification_type: 'permission_prompt',
  message,
});

/** K(x): the agent key the hook sends for raw id x, on this board. */
const K = (b: Board, session: string, agentId: string) =>
  crypto.createHash('sha256').update(`${b.url}\nclaude\n${session}\n${agentId}`).digest('hex').slice(0, 24);

// ---- the board, read back -----------------------------------------------------------

const SESSION_KEYS = ['id', 'name', 'status', 'message', 'project', 'source', 'host', 'createdAt', 'updatedAt'];
const SUBTASKS_KEYS = ['turnEnded', 'running', 'blocked', 'failed', 'done', 'items'];
const ITEM_KEYS = ['id', 'n', 'label', 'state', 'activity'];

async function cards(b: Board): Promise<Json[]> {
  const res = await fetch(`${b.url}/api/sessions`);
  expect(res.status).toBe(200);
  return (await res.json()) as Json[];
}

/** The session's card exactly as served, its keys checked against spec 5's layout. */
async function card(b: Board, id: string): Promise<Json> {
  const found = (await cards(b)).find((s) => s.id === id);
  expect(found, `no card for ${id}`).toBeDefined();
  const c = found!;
  expect(Object.keys(c)).toEqual('subtasks' in c ? [...SESSION_KEYS, 'subtasks'] : SESSION_KEYS);
  if ('subtasks' in c) {
    expect(Object.keys(c.subtasks)).toEqual(SUBTASKS_KEYS);
    for (const item of c.subtasks.items) expect(Object.keys(item)).toEqual(ITEM_KEYS);
  }
  return c;
}

/** What a card reads: its status and message, and `subtasks` when it carries any. */
const readingOf = (c: Json): Json => ({ status: c.status, message: c.message, ...('subtasks' in c ? { subtasks: c.subtasks } : {}) });
const reading = async (b: Board, id: string): Promise<Json> => readingOf(await card(b, id));

/** Fires an event that should post nothing, and checks the card did not move at all. */
async function quiet(b: Board, id: string, payload: Json, opts: Parameters<typeof fire>[2] = {}): Promise<void> {
  const before = await card(b, id);
  fire(b, payload, opts);
  expect(await card(b, id)).toStrictEqual(before);
}

/** The session's timeline as [status, message] pairs, newest first. */
async function timeline(b: Board, id: string): Promise<string[][]> {
  const res = await fetch(`${b.url}/api/sessions/${id}/history`);
  expect(res.status).toBe(200);
  return ((await res.json()) as Json[]).map((e) => [e.status, e.message]);
}

// ---- the runs -----------------------------------------------------------------------

describe('subagents from the hook to the board, through the real init and server', () => {
  it('follows a foreground subagent from its launch to the quiet end of the turn (G1, G2, G3, a refresh, G5, Stop)', async () => {
    const b = await install();
    const alpha = K(b, A, ALPHA);

    fire(b, load(b, 'a_session_start'));
    expect(await reading(b, A)).toStrictEqual({ status: 'idle', message: 'Session started' });
    const prompt = load(b, 'a_user_prompt');
    fire(b, prompt);
    expect(await reading(b, A)).toStrictEqual({
      status: 'planning',
      message: String(prompt.prompt).replace(/\s+/g, ' ').trim().slice(0, 120),
    });

    // G1: the launch is the parent's own line, and nothing more.
    fire(b, load(b, 'a_parent_pre_agent_alpha'));
    expect(await reading(b, A)).toStrictEqual({ status: 'planning', message: 'Run echo alpha' });

    // G2: a row, labelled with what it was asked to do; the parent's line stays.
    fire(b, load(b, 'a_subagent_start_alpha'));
    expect(await reading(b, A)).toStrictEqual({
      status: 'planning',
      message: 'Run echo alpha',
      subtasks: {
        turnEnded: false, running: 1, blocked: 0, failed: 0, done: 0,
        items: [{ id: alpha, n: 1, label: 'Run echo alpha', state: 'planning', activity: '' }],
      },
    });

    // G3: its first tool call is a class change.
    fire(b, load(b, 'a_pre_bash_alpha'));
    expect(await reading(b, A)).toStrictEqual({
      status: 'planning',
      message: 'Run echo alpha',
      subtasks: {
        turnEnded: false, running: 1, blocked: 0, failed: 0, done: 0,
        items: [{ id: alpha, n: 1, label: 'Run echo alpha', state: 'coding', activity: 'Print alpha' }],
      },
    });

    // Within the class and within the minute: no post at all.
    const edit = (file: string) => load(b, 'a_pre_bash_alpha', { tool_name: 'Edit', tool_input: { file_path: path.join(b.cwd, file) } });
    await quiet(b, A, edit('store.ts'));
    // The same class once the refresh window has passed (shortened here from a
    // minute): the row says what the subagent is doing now.
    fire(b, edit('app.ts'), { env: { AGSTATUS_AGENT_REFRESH_MS: '1' } });
    expect(await reading(b, A)).toStrictEqual({
      status: 'planning',
      message: 'Run echo alpha',
      subtasks: {
        turnEnded: false, running: 1, blocked: 0, failed: 0, done: 0,
        items: [{ id: alpha, n: 1, label: 'Run echo alpha', state: 'coding', activity: 'Editing app.ts' }],
      },
    });

    // G5: the row goes and is counted; its launch's result then says nothing.
    fire(b, load(b, 'a_subagent_stop_alpha'));
    const counted = {
      status: 'planning',
      message: 'Run echo alpha',
      subtasks: { turnEnded: false, running: 0, blocked: 0, failed: 0, done: 1, items: [] },
    };
    expect(await reading(b, A)).toStrictEqual(counted);
    await quiet(b, A, load(b, 'a_parent_post_agent_alpha'));

    // The parent's Stop with nothing in the background: the turn is fully
    // over, and the count goes with it.
    fire(b, load(b, 'a_stop'));
    expect(await reading(b, A)).toStrictEqual({ status: 'done', message: 'Turn finished' });
    // The subagent changed rows, never the card's reading, so the timeline is
    // the parent's alone.
    expect(await timeline(b, A)).toEqual([
      ['done', 'Turn finished'],
      ['planning', 'Run echo alpha'],
      ['planning', String(prompt.prompt).replace(/\s+/g, ' ').trim().slice(0, 120)],
      ['idle', 'Session started'],
    ]);
  });

  /** Run c up to its parent's Stop (G7), which leaves the subagent running in the background. */
  async function background(): Promise<{ b: Board; bg: string }> {
    const b = await install();
    const bg = K(b, C, BG);
    fire(b, load(b, 'c_parent_pre_agent'));
    fire(b, load(b, 'c_subagent_start'));
    expect(await reading(b, C)).toStrictEqual({
      status: 'planning',
      message: 'bg echo',
      subtasks: {
        turnEnded: false, running: 1, blocked: 0, failed: 0, done: 0,
        items: [{ id: bg, n: 1, label: 'bg echo', state: 'planning', activity: '' }],
      },
    });
    // The launch result repeats the label already sent.
    await quiet(b, C, load(b, 'c_parent_post_agent_async'));
    fire(b, load(b, 'c_pre_bash_bg'));
    const row = { id: bg, n: 1, label: 'bg echo', state: 'coding', activity: 'echo bg' };
    expect(await reading(b, C)).toStrictEqual({
      status: 'planning',
      message: 'bg echo',
      subtasks: { turnEnded: false, running: 1, blocked: 0, failed: 0, done: 0, items: [row] },
    });

    // G7: the parent's turn is over and the subagent is not. The card reads
    // its class and how many still run, and turnEnded is what draws WORKING.
    fire(b, load(b, 'c_stop_bg_running'));
    expect(await reading(b, C)).toStrictEqual({
      status: 'coding',
      message: '1 subagent still running',
      subtasks: { turnEnded: true, running: 1, blocked: 0, failed: 0, done: 0, items: [row] },
    });
    return { b, bg };
  }

  /** Between the last background finish and the report turn: the hold, with the count. */
  const holding = {
    status: 'planning',
    message: 'Reading subagent results',
    subtasks: { turnEnded: false, running: 0, blocked: 0, failed: 0, done: 1, items: [] },
  };

  it('keeps a background subagent on the card after Stop, holds for its report, and ends with the report turn', async () => {
    const { b } = await background();

    // Its SubagentStop: nothing runs any more, and the report turn has not
    // begun. The server says so itself, rather than done.
    fire(b, load(b, 'c_subagent_stop'));
    expect(await reading(b, C)).toStrictEqual(holding);

    // G9a: the <task-notification> prompt is the parent being told, not the
    // user speaking. The hook posts the same line, so nothing flickers.
    fire(b, load(b, 'c_task_notification'));
    expect(await reading(b, C)).toStrictEqual(holding);

    // The report turn's Stop, with nothing left in the background.
    fire(b, load(b, 'c_stop_report'));
    expect(await reading(b, C)).toStrictEqual({ status: 'done', message: 'Turn finished' });
    // One done, at the very end: never at the first Stop or the finish.
    expect(await timeline(b, C)).toEqual([
      ['done', 'Turn finished'],
      ['planning', 'Reading subagent results'],
      ['coding', '1 subagent still running'],
      ['planning', 'bg echo'],
    ]);
  });

  it('lets the task-notification close the row of a background subagent whose stop never arrived', async () => {
    const { b } = await background();
    // G9b: the SubagentStop hook never ran, so the notification carries the
    // finish as well; its two posts land in either order with the same result.
    fire(b, load(b, 'c_task_notification'));
    expect(await reading(b, C)).toStrictEqual(holding);
    fire(b, load(b, 'c_stop_report'));
    expect(await reading(b, C)).toStrictEqual({ status: 'done', message: 'Turn finished' });
  });

  it('blocks the card on a subagent\'s permission prompt, names the subagent, and gives the parent\'s line back after approval', async () => {
    const b = await install();
    const touch = K(b, D2, TOUCH);
    const row = (state: string, activity: string) => ({ id: touch, n: 1, label: 'try touch', state, activity });

    fire(b, load(b, 'd2_parent_pre_agent'));
    fire(b, load(b, 'd2_subagent_start'));
    fire(b, load(b, 'd2_pre_bash'));
    expect(await reading(b, D2)).toStrictEqual({
      status: 'planning',
      message: 'try touch',
      subtasks: {
        turnEnded: false, running: 1, blocked: 0, failed: 0, done: 0,
        items: [row('coding', 'Create empty file denied-probe.txt')],
      },
    });

    // PermissionRequest only leaves a marker: a prompt answered at once, or
    // one nobody sees, must not block a card or push.
    await quiet(b, D2, load(b, 'd2_permission_request'));

    // Claude Code notifies the prompt still waiting seconds later, without an
    // agent_id; the marker says whose it is. The hook's post carries 1.6.3's
    // message for older servers; this one names the subagent instead.
    const later = { clockMs: 3000 };
    fire(b, prompted(b, D2, 'Claude needs your permission to use Bash'), later);
    expect(await reading(b, D2)).toStrictEqual({
      status: 'blocked',
      message: 'Needs approval: try touch',
      subtasks: {
        turnEnded: false, running: 0, blocked: 1, failed: 0, done: 0,
        items: [row('blocked', 'Approve: Create empty file denied-probe.txt')],
      },
    });

    // Approved: its next tool call is a class change, and the card reads the
    // parent's own line again.
    fire(b, load(b, 'd2_pre_bash', { tool_input: { command: 'ls', description: 'List the files' } }), later);
    expect(await reading(b, D2)).toStrictEqual({
      status: 'planning',
      message: 'try touch',
      subtasks: { turnEnded: false, running: 1, blocked: 0, failed: 0, done: 0, items: [row('coding', 'List the files')] },
    });

    fire(b, load(b, 'd2_subagent_stop'), later);
    expect(await reading(b, D2)).toStrictEqual({
      status: 'planning',
      message: 'try touch',
      subtasks: { turnEnded: false, running: 0, blocked: 0, failed: 0, done: 1, items: [] },
    });
    expect(await timeline(b, D2)).toEqual([
      ['planning', 'try touch'],
      ['blocked', 'Needs approval: try touch'],
      ['planning', 'try touch'],
    ]);
  });

  it('in minimal mode, numbers the subagents and lets nothing they were told or did reach the board', async () => {
    const b = await install({ minimal: true });
    expect(b.env.AGSTATUS_DETAIL).toBe('off');
    const [alpha, beta] = [K(b, A, ALPHA), K(b, A, BETA)];
    // A titled session: in detail mode the title would name the card.
    fs.writeFileSync(
      path.join(b.projects, `${A}.jsonl`),
      JSON.stringify({ type: 'custom-title', customTitle: 'Rotate the payroll keys', sessionId: A }) + '\n',
    );
    const prompt = load(b, 'a_user_prompt');
    // The title, the user's prompt, what each subagent was asked (its label
    // and its prompt), what it ran, the notification's text, the raw ids.
    const secrets = [
      'Rotate the payroll keys', String(prompt.prompt).slice(0, 24), 'Run echo alpha', 'Run echo beta',
      'Use the Bash tool', 'echo alpha', 'echo beta', 'Print alpha', 'Print beta', 'Claude needs your permission',
      ALPHA, BETA,
    ];
    /** Fires one event, then reads the card and checks everything served about it: the board and the timeline. */
    const step = async (payload: Json, expected: Json, opts: Parameters<typeof fire>[2] = {}): Promise<void> => {
      fire(b, payload, opts);
      const c = await card(b, A);
      expect(c.name).toBe('proj');
      expect(readingOf(c)).toStrictEqual(expected);
      const served = JSON.stringify(await cards(b)) + JSON.stringify(await timeline(b, A));
      for (const secret of secrets) expect(served, secret).not.toContain(secret);
    };
    const live = (items: Json[], counts: Json = {}) => ({
      status: 'planning',
      message: 'Agent',
      subtasks: { turnEnded: false, running: items.length, blocked: 0, failed: 0, done: 0, ...counts, items },
    });
    const sub = (id: string, n: number, state: string, activity: string) => ({ id, n, label: `Subagent ${n}`, state, activity });

    // Run a in the order Claude Code sent it: two subagents launched in parallel.
    await step(load(b, 'a_session_start'), { status: 'idle', message: 'Session started' });
    await step(prompt, { status: 'planning', message: 'Processing prompt' });
    await step(load(b, 'a_parent_pre_agent_alpha'), { status: 'planning', message: 'Agent' });
    await step(load(b, 'a_subagent_start_alpha'), live([sub(alpha, 1, 'planning', '')]));
    await step(load(b, 'a_parent_pre_agent_beta'), live([sub(alpha, 1, 'planning', '')]));
    await step(load(b, 'a_subagent_start_beta'), live([sub(alpha, 1, 'planning', ''), sub(beta, 2, 'planning', '')]));
    await step(load(b, 'a_pre_bash_alpha'), live([sub(alpha, 1, 'coding', 'Bash'), sub(beta, 2, 'planning', '')]));
    await step(load(b, 'a_pre_bash_beta'), live([sub(alpha, 1, 'coding', 'Bash'), sub(beta, 2, 'coding', 'Bash')]));

    // Beta asks for approval (a PermissionRequest carries its PreToolUse's tool
    // and input), and the prompt is still waiting when Claude Code notifies it.
    const ask = load(b, 'a_pre_bash_beta', { hook_event_name: 'PermissionRequest' });
    delete ask.tool_use_id;
    await step(ask, live([sub(alpha, 1, 'coding', 'Bash'), sub(beta, 2, 'coding', 'Bash')]));
    const later = { clockMs: 3000 };
    const blocked = (items: Json[], counts: Json) => ({
      status: 'blocked',
      message: 'Needs approval: Subagent 2',
      subtasks: { turnEnded: false, running: 0, blocked: 1, failed: 0, done: 0, ...counts, items },
    });
    await step(
      prompted(b, A, 'Claude needs your permission to use Bash'),
      blocked([sub(alpha, 1, 'coding', 'Bash'), sub(beta, 2, 'blocked', 'Bash')], { running: 1 }),
      later,
    );

    await step(load(b, 'a_subagent_stop_alpha'), blocked([sub(beta, 2, 'blocked', 'Bash')], { done: 1 }), later);
    await step(load(b, 'a_parent_post_agent_alpha'), blocked([sub(beta, 2, 'blocked', 'Bash')], { done: 1 }), later);
    await step(load(b, 'a_subagent_stop_beta'), live([], { done: 2 }), later);
    await step(load(b, 'a_parent_post_agent_beta'), live([], { done: 2 }), later);
    await step(load(b, 'a_stop'), { status: 'done', message: 'Turn finished' }, later);
    expect(await timeline(b, A)).toEqual([
      ['done', 'Turn finished'],
      ['planning', 'Agent'],
      ['blocked', 'Needs approval: Subagent 2'],
      ['planning', 'Agent'],
      ['planning', 'Processing prompt'],
      ['idle', 'Session started'],
    ]);
  });
});
