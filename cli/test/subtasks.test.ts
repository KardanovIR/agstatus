import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Subagents on the parent's card (1.7.0): drives the REAL hook with the
 * payloads Claude Code and Codex actually send and checks every request it
 * makes against the golden bodies of the spec (G1-G21), then the edges around
 * them — flood control, confirmation, labels, permissions, notifications,
 * minimal mode, Codex, concurrency and the safety of the local state.
 *
 * Payloads are the probe captures (cli/test/fixtures/subtasks/*.json, built
 * from the probe runs a-e: a = two parallel foreground subagents, b = nested,
 * c = background, d2 = a permission prompt inside a subagent, e = a workflow),
 * with their paths rewritten to placeholders this file fills in per test.
 *
 * The capture server runs as a SIBLING process (same sandbox reason as
 * messages.test.ts) and records the URL, method and body of every request. It
 * answers 200 unless told otherwise: ctl.json holds a queue of actions, one
 * taken per request — a status (429), a reset connection, or a delay. Every
 * test has its own HOME, TMPDIR, AGSTATUS_STATE_DIR and CODEX_HOME, and runs
 * with AGSTATUS_USAGE=off unless it is checking the usage report itself.
 */

const HOOK = path.resolve(__dirname, '..', 'assets', 'agstatus-hook.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'subtasks');
const POSIX = process.platform !== 'win32';

type Json = Record<string, any>;

interface Captured {
  url: string;
  method: string;
  body: string;
  outcome: 'ok' | 'reset' | 'abandoned';
  status?: number;
}

interface Ws {
  root: string;
  home: string;
  tmp: string;
  state: string;
  codex: string;
  projects: string;
  cwd: string;
  env: Record<string, string>;
}

let server: ChildProcess;
let base: string;
let capturePath: string;
let ctlPath: string;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-subcap-'));
  capturePath = path.join(dir, 'captured.jsonl');
  ctlPath = path.join(dir, 'ctl.json');
  fs.writeFileSync(capturePath, '');
  fs.writeFileSync(ctlPath, '{"queue":[]}');

  const script = `
    const http = require('http'), fs = require('fs');
    const [out, ctl] = process.argv.slice(1);
    const next = () => {
      try {
        const c = JSON.parse(fs.readFileSync(ctl, 'utf8'));
        const a = Array.isArray(c.queue) && c.queue.length ? c.queue.shift() : null;
        if (a) fs.writeFileSync(ctl, JSON.stringify(c));
        return a || {};
      } catch { return {}; }
    };
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        const a = next();
        const rec = { url: req.url, method: req.method, body: b };
        if (a.reset) {
          fs.appendFileSync(out, JSON.stringify({ ...rec, outcome: 'reset' }) + '\\n');
          req.socket.destroy();
          return;
        }
        const reply = () => {
          if (req.socket.destroyed) {
            fs.appendFileSync(out, JSON.stringify({ ...rec, outcome: 'abandoned' }) + '\\n');
            return;
          }
          const status = a.status || 200;
          fs.appendFileSync(out, JSON.stringify({ ...rec, outcome: 'ok', status }) + '\\n');
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(status < 300 ? '{"ok":true}' : '{"error":"refused"}');
        };
        if (a.delay) setTimeout(reply, a.delay); else reply();
      });
    });
    srv.listen(0, '127.0.0.1', () => process.stdout.write('PORT ' + srv.address().port + '\\n'));
  `;
  server = spawn(process.execPath, ['-e', script, capturePath, ctlPath], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('capture server did not start')), 10_000);
    server.stdout!.on('data', (chunk: Buffer) => {
      const m = /PORT (\d+)/.exec(chunk.toString());
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.kill();
});

// ---- harness ------------------------------------------------------------------

function captured(): Captured[] {
  return fs
    .readFileSync(capturePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Captured);
}

/** The next requests' answers, in arrival order; anything past the queue gets 200. */
function queue(...actions: Array<{ status?: number; reset?: boolean; delay?: number }>): void {
  fs.writeFileSync(ctlPath, JSON.stringify({ queue: actions }));
}

function workspace(): Ws {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-sub-'));
  const ws = {
    root,
    home: path.join(root, 'home'),
    tmp: path.join(root, 'tmp'),
    state: path.join(root, 'state'),
    codex: path.join(root, 'codex'),
    projects: path.join(root, 'projects'),
    cwd: path.join(root, 'proj'),
  };
  for (const dir of Object.values(ws)) fs.mkdirSync(dir, { recursive: true });
  return {
    ...ws,
    env: { HOME: ws.home, TMPDIR: ws.tmp, AGSTATUS_STATE_DIR: ws.state, CODEX_HOME: ws.codex },
  };
}

// Everything the hook reads from the environment that a developer's own shell
// or agent could leak into a run.
const SCRUBBED = [
  'CLAUDE_STATUS_URL', 'CLAUDE_STATUS_SECRET', 'AGSTATUS_DETAIL', 'AGSTATUS_SOURCE',
  'AGSTATUS_FOCUS', 'AGSTATUS_DEBUG', 'AGSTATUS_STATE_DIR', 'AGSTATUS_AGENT_REFRESH_MS',
  'AGSTATUS_PROJECT_FORCE', 'AGSTATUS_USAGE', 'CODEX_HOME', 'CLAUDE_PID', 'CLAUDE_CONFIG_DIR',
  'TMPDIR', 'TMP', 'TEMP',
];

function hookEnv(ws: Ws, env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const full: Record<string, string | undefined> = { ...process.env };
  for (const key of SCRUBBED) delete full[key];
  Object.assign(full, { CLAUDE_STATUS_URL: base, AGSTATUS_USAGE: 'off' }, ws.env, env);
  for (const [k, v] of Object.entries(full)) if (v === undefined) delete full[k];
  return full as NodeJS.ProcessEnv;
}

/** Runs the hook on one payload and returns the requests it made. */
function fire(
  ws: Ws,
  payload: Json,
  env: Record<string, string | undefined> = {},
  nodeArgs: string[] = [],
): Captured[] {
  const before = captured().length;
  execFileSync(process.execPath, [...nodeArgs, HOOK], {
    input: JSON.stringify(payload),
    env: hookEnv(ws, env),
    timeout: 10_000,
  });
  return captured().slice(before);
}

/** The webhook bodies among some requests. */
const posts = (reqs: Captured[]): Json[] =>
  reqs.filter((r) => r.url === '/webhook' && r.method === 'POST').map((r) => JSON.parse(r.body));

/** Fires and returns the webhook bodies. */
const post = (ws: Ws, payload: Json, env: Record<string, string | undefined> = {}): Json[] =>
  posts(fire(ws, payload, env));

/** A probe payload with its paths pointed into this test's workspace. */
function load(ws: Ws, name: string, overrides: Json = {}): Json {
  const esc = (s: string) => JSON.stringify(s).slice(1, -1);
  const raw = fs
    .readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')
    .replaceAll('{{projects}}', esc(ws.projects))
    .replaceAll('{{cwd}}', esc(ws.cwd))
    .replaceAll('{{tmp}}', esc(ws.tmp));
  return { ...(JSON.parse(raw).payload as Json), ...overrides };
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** K(x): the agent key of raw id x for this board, source and session. */
const K = (agentId: string, session: string, source = 'claude') =>
  sha256(`${base}\n${source}\n${session}\n${agentId}`).slice(0, 24);

function stateRoot(ws: Ws, source = 'claude'): string {
  return path.join(ws.tmp, `agstatus-subtasks-${process.getuid!()}-${sha256(`${base}\n${source}`).slice(0, 12)}`);
}

const sessionDir = (ws: Ws, session: string, source = 'claude') =>
  path.join(stateRoot(ws, source), sha256(session).slice(0, 16));

/**
 * A body with `name` checked as a non-empty string and `agent.at` as a
 * positive integer, both then removed, so the rest compares exactly.
 */
function shape(body: Json): Json {
  const copy = JSON.parse(JSON.stringify(body)) as Json;
  expect(typeof copy.name).toBe('string');
  expect(copy.name.length).toBeGreaterThan(0);
  delete copy.name;
  if (copy.agent) {
    expect(Number.isInteger(copy.agent.at) && copy.agent.at > 0).toBe(true);
    delete copy.agent.at;
  }
  return copy;
}

const agentPosts = (bodies: Json[]) => bodies.filter((b) => b.agent);
const mainPosts = (bodies: Json[]) => bodies.filter((b) => !b.agent);

// The probe sessions.
const A = '5cef7152-ef68-481f-8a4f-463f66702bf9'; // run a: parallel foreground
const C = 'ce4d79fa-d133-4666-ac0b-be13150d339a'; // run c: background
const D2 = 'fdabcccc-3f36-4fed-9029-f326702a365b'; // run d2: permission prompt
const E = 'b10dc3bd-70ff-435e-a81d-bbd8e635c41e'; // run e: workflow
const ALPHA = 'a28b0e80d3d1190c2';
const BETA = 'afbeec30e716aefa1';
const BG = 'a81211a654bc21fa3';
const TOUCH = 'a9f11cbaeca3764d9';
const WF_ONE = 'aa1129b0cbabb25ea';
const WF_TWO = 'a0dab80ac0623041e';
const RUN = 'wf_63757895-43f';

function writeMeta(ws: Ws, session: string, agentId: string, meta: Json, runId = ''): void {
  const dir = runId
    ? path.join(ws.projects, session, 'subagents', 'workflows', runId)
    : path.join(ws.projects, session, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
}

/** run e's journal, as the workflow writes it before each agent's SubagentStart. */
function writeJournal(ws: Ws, entries: Json[] = [
  { type: 'launched' },
  { type: 'started', key: 'v2:3517a', agentId: WF_ONE, label: 'echo:one', phase: 'Echo' },
  { type: 'started', key: 'v2:3517b', agentId: WF_TWO, label: 'echo:two', phase: 'Echo' },
]): void {
  const dir = path.join(ws.projects, E, 'subagents', 'workflows', RUN);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

/** Moves one thread's permission markers `ageMs` into the past (the name carries the time). */
function ageMarkers(ws: Ws, session: string, who: string, ageMs: number): void {
  const dir = path.join(sessionDir(ws, session), 'perm');
  const now = Date.now();
  for (const name of fs.readdirSync(dir)) {
    const m = /^(main|[0-9a-f]{24})-(\d+)\.json$/.exec(name);
    if (!m || m[1] !== who) continue;
    const record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    record.at = now - ageMs;
    fs.writeFileSync(path.join(dir, `${who}-${record.at}.json`), JSON.stringify(record), { mode: 0o600 });
    fs.unlinkSync(path.join(dir, name));
  }
}

const notification = (session: string, ws: Ws, extra: Json): Json => ({
  session_id: session,
  transcript_path: path.join(ws.projects, `${session}.jsonl`),
  cwd: ws.cwd,
  hook_event_name: 'Notification',
  ...extra,
});

// ---- Codex fixtures -------------------------------------------------------------

const ROOT_THREAD = '01a17993-5e1d-7c22-9d2a-6f3b1c0e9a01';
const SUB_THREAD = '01a17ebe-0b7a-7d41-8f3e-2c5d4a6b8e02';
const RATE_LIMITS = () => JSON.stringify({
  timestamp: new Date().toISOString(),
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { total_token_usage: { total_tokens: 1200 } },
    rate_limits: {
      limit_id: 'codex', limit_name: null, secondary: null,
      primary: { used_percent: 17, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 900 },
    },
  },
});
const turnContext = (turnId: string, reviewer: string) =>
  JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'turn_context',
    payload: { turn_id: turnId, cwd: '/tmp', approval_policy: 'on-request', approvals_reviewer: reviewer },
  });

/** A rollout whose first line is its session_meta, the shape Codex writes. */
function codexRollout(ws: Ws, threadId: string, meta: Json, lines: string[] = []): string {
  const dir = path.join(ws.codex, 'sessions', '2026', '10', '28');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-28T10-00-00-${threadId}.jsonl`);
  const first = JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: meta });
  fs.writeFileSync(file, [first, ...lines].join('\n') + '\n');
  return file;
}

function subMeta(extra: Json = {}): Json {
  return {
    id: SUB_THREAD,
    session_id: ROOT_THREAD,
    parent_thread_id: ROOT_THREAD,
    agent_nickname: 'Feynman',
    agent_path: '/root/reset_scope_review',
    thread_source: 'subagent',
    source: {
      subagent: {
        thread_spawn: {
          parent_thread_id: ROOT_THREAD, depth: 1, agent_path: '/root/reset_scope_review',
          agent_nickname: 'Feynman', agent_role: null,
        },
      },
    },
    ...extra,
  };
}

const CODEX = { AGSTATUS_SOURCE: 'codex' };

function codexEvent(ws: Ws, event: string, transcript: string, extra: Json = {}): Json {
  return {
    hook_event_name: event,
    session_id: ROOT_THREAD,
    cwd: ws.cwd,
    transcript_path: transcript,
    turn_id: 'turn-1',
    model: 'gpt-5.5-codex',
    permission_mode: 'default',
    ...extra,
  };
}

// ---- G1-G21 -----------------------------------------------------------------------

describe('golden bodies', () => {
  /** run a up to `upTo` steps: launch, start, a Bash call, two Edits, a test run, the stop. */
  function runAlpha(ws: Ws, upTo: number): Json[][] {
    const steps = [
      load(ws, 'a_parent_pre_agent_alpha'),
      load(ws, 'a_subagent_start_alpha'),
      load(ws, 'a_pre_bash_alpha'),
      load(ws, 'a_pre_bash_alpha', { tool_name: 'Edit', tool_input: { file_path: path.join(ws.cwd, 'src', 'store.ts') } }),
      load(ws, 'a_pre_bash_alpha', { tool_name: 'Edit', tool_input: { file_path: path.join(ws.cwd, 'src', 'store.ts') } }),
      load(ws, 'a_pre_bash_alpha', { tool_input: { command: 'npm test', description: 'Run the test suite' } }),
      load(ws, 'a_subagent_stop_alpha'),
    ];
    return steps.slice(0, upTo).map((p) => post(ws, p));
  }

  it('G1: the Agent launch is a main-thread planning post, and leaves a launch record', () => {
    const ws = workspace();
    const [g1] = runAlpha(ws, 1);
    expect(g1.map(shape)).toEqual([
      { session_id: A, status: 'planning', message: 'Run echo alpha', project: 'proj', source: 'claude' },
    ]);
    const launch = path.join(sessionDir(ws, A), 'launch');
    const records = fs.readdirSync(launch).map((n) => JSON.parse(fs.readFileSync(path.join(launch, n), 'utf8')));
    expect(records).toEqual([
      { v: 1, toolUseId: 'toolu_014ut2LA8noPaPhsYzMqEUE2', by: 'main', at: expect.any(Number), desc: 'Run echo alpha' },
    ]);
  });

  it('G2: SubagentStart posts the subagent planning, labelled from the launch it claimed', () => {
    const ws = workspace();
    const [, g2] = runAlpha(ws, 2);
    expect(g2.map(shape)).toEqual([{
      session_id: A, status: 'planning', source: 'claude',
      agent: { id: K(ALPHA, A), state: 'planning', kind: 'agent', label: 'Run echo alpha' },
    }]);
  });

  it('G3: its first tool call is a class change', () => {
    const ws = workspace();
    const [, , g3] = runAlpha(ws, 3);
    expect(g3.map(shape)).toEqual([{
      session_id: A, status: 'coding', source: 'claude',
      agent: { id: K(ALPHA, A), state: 'coding', kind: 'agent', label: 'Run echo alpha', activity: 'Print alpha' },
    }]);
  });

  it('G4: two Edits post nothing (coding → coding); the test run is testing', () => {
    const ws = workspace();
    const steps = runAlpha(ws, 6);
    expect(steps[3]).toEqual([]);
    expect(steps[4]).toEqual([]);
    expect(steps[5].map(shape)).toEqual([{
      session_id: A, status: 'testing', source: 'claude',
      agent: { id: K(ALPHA, A), state: 'testing', kind: 'agent', label: 'Run echo alpha', activity: 'Run the test suite' },
    }]);
  });

  it('G5: SubagentStop posts done, with the last confirmed class as status', () => {
    const ws = workspace();
    const steps = runAlpha(ws, 7);
    expect(steps[6].map(shape)).toEqual([{
      session_id: A, status: 'testing', source: 'claude',
      agent: { id: K(ALPHA, A), state: 'done', kind: 'agent', label: 'Run echo alpha' },
    }]);
  });

  it('G6: an internal agent\'s stop, and a stop for an agent never seen starting, post nothing', () => {
    const ws = workspace();
    runAlpha(ws, 3);
    expect(fire(ws, load(ws, 'a_subagent_stop_alpha', { agent_type: '' }))).toEqual([]);
    expect(fire(ws, load(ws, 'a_subagent_stop_beta'))).toEqual([]);
  });

  it('G7: Stop with a background subagent running lists it in turn.running', () => {
    const ws = workspace();
    expect(post(ws, load(ws, 'c_stop_bg_running')).map(shape)).toEqual([{
      session_id: C, status: 'done', message: 'Turn finished', project: 'proj', source: 'claude',
      turn: { phase: 'end', running: [K(BG, C)], workflows: 0 },
    }]);
  });

  it('G8: Stop with a workflow running counts it in turn.workflows', () => {
    const ws = workspace();
    const [body] = post(ws, load(ws, 'e_stop_workflow_running'));
    expect(body.turn).toEqual({ phase: 'end', running: [], workflows: 1 });
  });

  describe('G9: a background subagent\'s <task-notification>', () => {
    const reading = { session_id: C, status: 'planning', message: 'Reading subagent results', project: 'proj', source: 'claude' };

    it('(a) after its stop was confirmed: only the fixed main-thread post', () => {
      const ws = workspace();
      for (const n of ['c_parent_pre_agent', 'c_subagent_start', 'c_pre_bash_bg', 'c_subagent_stop']) post(ws, load(ws, n));
      expect(post(ws, load(ws, 'c_task_notification')).map(shape)).toEqual([reading]);
    });

    it('(b) when its stop was lost: the main post and the done it never got', () => {
      const ws = workspace();
      for (const n of ['c_parent_pre_agent', 'c_subagent_start', 'c_pre_bash_bg']) post(ws, load(ws, n));
      const bodies = post(ws, load(ws, 'c_task_notification')).map(shape);
      expect(mainPosts(bodies)).toEqual([reading]);
      expect(agentPosts(bodies)).toEqual([{
        session_id: C, status: 'coding', source: 'claude',
        agent: { id: K(BG, C), state: 'done', kind: 'agent', label: 'bg echo' },
      }]);
    });

    it('(c) with no local state at all: the main post only', () => {
      const ws = workspace();
      expect(post(ws, load(ws, 'c_task_notification')).map(shape)).toEqual([reading]);
    });
  });

  it('G10: an ordinary prompt starts a turn', () => {
    const ws = workspace();
    const prompt = load(ws, 'a_user_prompt');
    expect(post(ws, prompt).map(shape)).toEqual([{
      session_id: A, status: 'planning', message: String(prompt.prompt).replace(/\s+/g, ' ').trim().slice(0, 120),
      project: 'proj', source: 'claude', turn: { phase: 'start' },
    }]);
  });

  it('G11: minimal mode sends no label, tool names for activity, and the folder as name', () => {
    const ws = workspace();
    const minimal = { AGSTATUS_DETAIL: 'off' };
    expect(post(ws, load(ws, 'a_parent_pre_agent_alpha'), minimal)[0].message).toBe('Agent');
    const [start] = post(ws, load(ws, 'a_subagent_start_alpha'), minimal);
    const [coding] = post(ws, load(ws, 'a_pre_bash_alpha'), minimal);
    expect(start.name).toBe('proj');
    expect(coding.name).toBe('proj');
    expect(start.agent).toEqual({ id: K(ALPHA, A), state: 'planning', kind: 'agent', at: expect.any(Number) });
    expect(coding.agent).toEqual({ id: K(ALPHA, A), state: 'coding', kind: 'agent', activity: 'Bash', at: expect.any(Number) });
  });

  it('G12: a Codex sub-agent is labelled with its nickname from its own rollout', () => {
    const ws = workspace();
    const sub = codexRollout(ws, SUB_THREAD, subMeta());
    const bodies = post(ws, codexEvent(ws, 'SubagentStart', sub, { agent_id: SUB_THREAD, agent_type: 'default' }), CODEX);
    expect(bodies.map(shape)).toEqual([{
      session_id: ROOT_THREAD, status: 'planning', source: 'codex',
      agent: { id: K(SUB_THREAD, ROOT_THREAD, 'codex'), state: 'planning', kind: 'codex', label: 'Feynman' },
    }]);
  });

  it('G13: a known Codex sub-agent asking a human is blocked, with 1.6.3\'s message', () => {
    const ws = workspace();
    const sub = codexRollout(ws, SUB_THREAD, subMeta(), [turnContext('turn-1', 'user')]);
    post(ws, codexEvent(ws, 'SubagentStart', sub, { agent_id: SUB_THREAD, agent_type: 'default' }), CODEX);
    const ask = 'May I run the migration against the scratch database?';
    const bodies = post(ws, codexEvent(ws, 'PermissionRequest', sub, {
      agent_id: SUB_THREAD, agent_type: 'default', tool_name: 'Bash',
      tool_input: { command: 'psql -f migrate.sql', description: ask },
    }), CODEX);
    expect(bodies.map(shape)).toEqual([{
      session_id: ROOT_THREAD, status: 'blocked', message: ask, source: 'codex',
      agent: { id: K(SUB_THREAD, ROOT_THREAD, 'codex'), state: 'blocked', kind: 'codex', label: 'Feynman', activity: ask },
    }]);
  });

  it('G14: a subagent\'s PermissionRequest posts nothing; the Notification after it blocks that row', () => {
    const ws = workspace();
    for (const n of ['d2_parent_pre_agent', 'd2_subagent_start', 'd2_pre_bash']) post(ws, load(ws, n));
    expect(fire(ws, load(ws, 'd2_permission_request'))).toEqual([]);
    const perm = path.join(sessionDir(ws, D2), 'perm');
    expect(fs.readdirSync(perm)).toHaveLength(1);
    // Claude Code notifies a prompt still waiting after ~6 s; the marker must be at least 2 s old.
    ageMarkers(ws, D2, K(TOUCH, D2), 2500);
    const bodies = post(ws, notification(D2, ws, {
      notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash',
    }));
    expect(bodies.map(shape)).toEqual([{
      session_id: D2, status: 'blocked', message: 'Claude needs your permission to use Bash', source: 'claude',
      agent: {
        id: K(TOUCH, D2), state: 'blocked', kind: 'agent', label: 'try touch',
        activity: 'Approve: Create empty file denied-probe.txt',
      },
    }]);
  });

  it('G15: PostToolUseFailure of a bound launch fails its subagent; an interrupt reads Stopped', () => {
    const ws = workspace();
    runAlpha(ws, 3);
    const failure = {
      session_id: A, transcript_path: path.join(ws.projects, `${A}.jsonl`), cwd: ws.cwd,
      hook_event_name: 'PostToolUseFailure', tool_name: 'Agent', tool_use_id: 'toolu_014ut2LA8noPaPhsYzMqEUE2',
      tool_input: { description: 'Run echo alpha' }, error: 'Agent type not found: nope\nAvailable: general-purpose',
      is_interrupt: false,
    };
    expect(post(ws, failure).map(shape)).toEqual([{
      session_id: A, status: 'coding', source: 'claude',
      agent: { id: K(ALPHA, A), state: 'failed', kind: 'agent', label: 'Run echo alpha', activity: 'Failed: Agent type not found: nope' },
    }]);

    const other = workspace();
    for (const n of ['a_parent_pre_agent_beta', 'a_subagent_start_beta']) post(other, load(other, n));
    const [stopped] = post(other, { ...failure, cwd: other.cwd, tool_use_id: 'toolu_019V8xc7SfdJegte62WEvJyz', is_interrupt: true });
    expect(stopped.status).toBe('planning');
    expect(stopped.agent).toMatchObject({ id: K(BETA, A), state: 'failed', activity: 'Stopped' });
  });

  it('G16: SessionStart from compaction posts nothing; a real start resets the turn', () => {
    const ws = workspace();
    expect(fire(ws, load(ws, 'e_session_start', { source: 'compact' }))).toEqual([]);
    expect(post(ws, load(ws, 'e_session_start')).map(shape)).toEqual([{
      session_id: E, status: 'idle', message: 'Session started', project: 'proj', source: 'claude',
      turn: { phase: 'reset' },
    }]);
  });

  it('G17: an Agent result never posts failed; a background launch\'s new label posts once', () => {
    const ws = workspace();
    post(ws, load(ws, 'a_parent_pre_agent_alpha'));
    const result = load(ws, 'a_parent_post_agent_alpha');
    for (const status of ['remote_launched', 'teammate_spawned', 'completed']) {
      expect(fire(ws, { ...result, tool_response: { ...result.tool_response, status } })).toEqual([]);
    }

    const bg = workspace();
    for (const n of ['c_parent_pre_agent', 'c_subagent_start']) post(bg, load(bg, n));
    const launched = load(bg, 'c_parent_post_agent_async');
    // The probe's own result repeats the description already sent: nothing to say.
    expect(fire(bg, launched)).toEqual([]);
    const renamed = { ...launched, tool_response: { ...launched.tool_response, description: 'Echo in the background' } };
    expect(post(bg, renamed).map(shape)).toEqual([{
      session_id: C, status: 'planning', source: 'claude',
      agent: { id: K(BG, C), state: 'planning', kind: 'agent', label: 'Echo in the background' },
    }]);
    expect(fire(bg, renamed)).toEqual([]);
  });

  it('G18: PostToolUse(Workflow) posts nothing and records the run', () => {
    const ws = workspace();
    expect(fire(ws, load(ws, 'e_parent_post_workflow'))).toEqual([]);
    const record = JSON.parse(fs.readFileSync(path.join(sessionDir(ws, E), 'runs', `${RUN}.json`), 'utf8'));
    expect(record).toEqual({
      v: 1, runId: RUN, dir: path.join(ws.projects, E, 'subagents', 'workflows', RUN), at: expect.any(Number),
    });
  });

  it('G19: a Codex root prompt starts a turn and never sends the prompt', () => {
    const ws = workspace();
    const root = codexRollout(ws, ROOT_THREAD, { id: ROOT_THREAD, session_id: ROOT_THREAD });
    const bodies = post(ws, codexEvent(ws, 'UserPromptSubmit', root, { prompt: 'Rotate the production keys' }), CODEX);
    expect(bodies.map(shape)).toEqual([{
      session_id: ROOT_THREAD, status: 'planning', message: 'Processing prompt', project: 'proj', source: 'codex',
      turn: { phase: 'start' },
    }]);
  });

  it('G20: an unknown subagent\'s tool call takes the 1.6.3 path, without host', () => {
    const ws = workspace();
    // Focus on, so `host` WOULD ride on a main-thread post.
    fs.writeFileSync(path.join(ws.home, '.agstatus.json'), JSON.stringify({ focus: true }));
    fs.writeFileSync(path.join(ws.state, 'machine.json'), JSON.stringify({ machineId: '6f1c2b3a-4d5e-4f60-8a9b-0c1d2e3f4a5b', name: 'Studio' }));
    const bodies = post(ws, load(ws, 'a_pre_bash_alpha', { tool_input: { command: 'echo hi', description: 'Say hi' } }));
    expect(bodies.map(shape)).toEqual([
      { session_id: A, status: 'coding', message: 'Say hi', project: 'proj', source: 'claude' },
    ]);
    expect(fs.existsSync(path.join(ws.state, 'sessions'))).toBe(false);
    // ...while the parent's own event does carry it.
    expect(post(ws, load(ws, 'a_stop'))[0].host).toBeTruthy();
  });

  it('G21: a permission prompt nobody can attribute is marked unattributed', () => {
    const ws = workspace();
    runAlpha(ws, 3);
    const bodies = post(ws, notification(A, ws, {
      notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash',
    }));
    expect(bodies.map(shape)).toEqual([{
      session_id: A, status: 'blocked', message: 'Claude needs your permission to use Bash', project: 'proj',
      source: 'claude', unattributed: true,
    }]);
  });
});

// ---- the rules around them --------------------------------------------------------

describe('flood control and confirmation', () => {
  it('posts a subagent only on start, stop and a change of status class', () => {
    const ws = workspace();
    post(ws, load(ws, 'a_parent_pre_agent_alpha'));
    const tool = (name: string, input: Json) => load(ws, 'a_pre_bash_alpha', { tool_name: name, tool_input: input });
    const sent = [
      load(ws, 'a_subagent_start_alpha'),
      tool('Bash', { command: 'ls', description: 'List files' }),
      tool('Edit', { file_path: '/x/a.ts' }),
      tool('Edit', { file_path: '/x/b.ts' }),
      tool('Bash', { command: 'npx vitest run', description: 'Run tests' }),
      tool('Edit', { file_path: '/x/c.ts' }),
    ].flatMap((p) => agentPosts(post(ws, p)));
    expect(sent.map((b) => b.agent.state)).toEqual(['planning', 'coding', 'testing', 'coding']);
  });

  it('posts a class again after the board refused it (429)', () => {
    const ws = workspace();
    post(ws, load(ws, 'a_parent_pre_agent_alpha'));
    post(ws, load(ws, 'a_subagent_start_alpha'));
    queue({ status: 429 });
    const refused = fire(ws, load(ws, 'a_pre_bash_alpha'));
    expect(refused.map((r) => r.status)).toEqual([429]);
    // Same class, but the board never confirmed it: post again.
    const again = post(ws, load(ws, 'a_pre_bash_alpha', { tool_name: 'Edit', tool_input: { file_path: '/x/a.ts' } }));
    expect(again.map((b) => b.agent.state)).toEqual(['coding']);
    // Now confirmed: the next one in the class is quiet.
    expect(post(ws, load(ws, 'a_pre_bash_alpha', { tool_name: 'Edit', tool_input: { file_path: '/x/b.ts' } }))).toEqual([]);
  });

  it('lets the task-notification post the done a refused stop never delivered', () => {
    const ws = workspace();
    for (const n of ['c_parent_pre_agent', 'c_subagent_start', 'c_pre_bash_bg']) post(ws, load(ws, n));
    queue({ status: 429 });
    expect(fire(ws, load(ws, 'c_subagent_stop')).map((r) => r.status)).toEqual([429]);
    const bodies = post(ws, load(ws, 'c_task_notification'));
    expect(agentPosts(bodies).map((b) => b.agent.state)).toEqual(['done']);
  });

  it('with AGENT_REFRESH_MS on (tests only), posts a new activity within the class', () => {
    const ws = workspace();
    const refresh = { AGSTATUS_AGENT_REFRESH_MS: '1' };
    post(ws, load(ws, 'a_parent_pre_agent_alpha'), refresh);
    post(ws, load(ws, 'a_subagent_start_alpha'), refresh);
    const edit = (file: string) => load(ws, 'a_pre_bash_alpha', { tool_name: 'Edit', tool_input: { file_path: file } });
    expect(agentPosts(post(ws, edit('/x/a.ts'), refresh)).map((b) => b.agent.activity)).toEqual(['Editing a.ts']);
    // Same class, new activity, and well over 1 ms since the last confirmed post.
    expect(agentPosts(post(ws, edit('/x/b.ts'), refresh)).map((b) => b.agent)).toEqual([
      expect.objectContaining({ state: 'coding', activity: 'Editing b.ts' }),
    ]);
    // The same activity again is not news.
    expect(post(ws, edit('/x/b.ts'), refresh)).toEqual([]);
    // Off (the default): the decided rule, nothing within a class.
    expect(post(ws, edit('/x/c.ts'))).toEqual([]);
  });
});

describe('unknown subagents and unusable ids', () => {
  it('gives an unknown subagent\'s stop and notification nothing of their own', () => {
    const ws = workspace();
    expect(fire(ws, load(ws, 'c_subagent_stop'))).toEqual([]);
    expect(agentPosts(post(ws, load(ws, 'c_task_notification')))).toEqual([]);
  });

  it('gives an unknown Codex sub-agent\'s approval request today\'s Codex blocked body', () => {
    const ws = workspace();
    const sub = codexRollout(ws, SUB_THREAD, subMeta(), [turnContext('turn-1', 'user')]);
    const bodies = post(ws, codexEvent(ws, 'PermissionRequest', sub, {
      agent_id: SUB_THREAD, agent_type: 'default', tool_name: 'Bash', tool_input: { description: 'May I?' },
    }), CODEX);
    expect(bodies.map(shape)).toEqual([
      { session_id: ROOT_THREAD, status: 'blocked', message: 'May I?', project: 'proj', source: 'codex' },
    ]);
  });

  it('drops an event whose agent_id is too long or not a string, and posts no main-thread line', () => {
    const ws = workspace();
    expect(fire(ws, load(ws, 'a_pre_bash_alpha', { agent_id: 'a'.repeat(300) }))).toEqual([]);
    expect(fire(ws, load(ws, 'a_pre_bash_alpha', { agent_id: 42 }))).toEqual([]);
  });
});

describe('labels', () => {
  it('corrects a guessed label exactly once from meta.json', () => {
    const ws = workspace();
    post(ws, load(ws, 'a_parent_pre_agent_alpha'));
    post(ws, load(ws, 'a_subagent_start_alpha'));
    writeMeta(ws, A, ALPHA, { agentType: 'general-purpose', description: 'Echo alpha twice', toolUseId: 'toolu_014ut2LA8noPaPhsYzMqEUE2' });
    const search = load(ws, 'a_pre_bash_alpha', { tool_name: 'WebSearch', tool_input: { query: 'echo' } });
    // Same class as the start (planning): a label-only post.
    expect(agentPosts(post(ws, search)).map((b) => b.agent)).toEqual([
      expect.objectContaining({ state: 'planning', label: 'Echo alpha twice', activity: 'Searching: echo' }),
    ]);
    expect(post(ws, search)).toEqual([]);
    expect(agentPosts(post(ws, load(ws, 'a_pre_bash_alpha'))).map((b) => b.agent.label)).toEqual(['Echo alpha twice']);
  });

  it('guesses oldest-first when launches overlap, then fixes a swapped pair at each first tool call', () => {
    const ws = workspace();
    post(ws, load(ws, 'a_parent_pre_agent_alpha'));
    post(ws, load(ws, 'a_parent_pre_agent_beta'));
    // beta's subagent starts first, so it takes the oldest record — alpha's.
    const [first] = agentPosts(post(ws, load(ws, 'a_subagent_start_beta')));
    const [second] = agentPosts(post(ws, load(ws, 'a_subagent_start_alpha')));
    expect(first.agent).toMatchObject({ id: K(BETA, A), label: 'Run echo alpha' });
    expect(second.agent).toMatchObject({ id: K(ALPHA, A), label: 'Run echo beta' });

    writeMeta(ws, A, ALPHA, { description: 'Run echo alpha', toolUseId: 'toolu_014ut2LA8noPaPhsYzMqEUE2' });
    writeMeta(ws, A, BETA, { description: 'Run echo beta', toolUseId: 'toolu_019V8xc7SfdJegte62WEvJyz' });
    expect(agentPosts(post(ws, load(ws, 'a_pre_bash_beta')))[0].agent).toMatchObject({ id: K(BETA, A), label: 'Run echo beta' });
    expect(agentPosts(post(ws, load(ws, 'a_pre_bash_alpha')))[0].agent).toMatchObject({ id: K(ALPHA, A), label: 'Run echo alpha' });

    // The firm binding names the right subagent when beta's launch fails.
    const [failed] = post(ws, {
      session_id: A, transcript_path: path.join(ws.projects, `${A}.jsonl`), cwd: ws.cwd,
      hook_event_name: 'PostToolUseFailure', tool_name: 'Agent', tool_use_id: 'toolu_019V8xc7SfdJegte62WEvJyz',
      error: 'boom', is_interrupt: false,
    });
    expect(failed.agent).toMatchObject({ id: K(BETA, A), state: 'failed', activity: 'Failed: boom' });
  });

  it('gives the start the description of a background result that landed first', () => {
    const ws = workspace();
    post(ws, load(ws, 'c_parent_pre_agent'));
    const launched = load(ws, 'c_parent_post_agent_async');
    expect(fire(ws, { ...launched, tool_response: { ...launched.tool_response, description: 'From the result' } })).toEqual([]);
    expect(agentPosts(post(ws, load(ws, 'c_subagent_start')))[0].agent.label).toBe('From the result');
  });

  it('claims no launch on a repeated start; the pending one survives for its own start', () => {
    const ws = workspace();
    post(ws, load(ws, 'a_parent_pre_agent_alpha'));
    post(ws, load(ws, 'a_subagent_start_alpha'));
    post(ws, load(ws, 'a_parent_pre_agent_beta'));
    // alpha resumed: a known subagent starting again.
    expect(agentPosts(post(ws, load(ws, 'a_subagent_start_alpha')))[0].agent).toMatchObject({ id: K(ALPHA, A), label: 'Run echo alpha' });
    expect(agentPosts(post(ws, load(ws, 'a_subagent_start_beta')))[0].agent).toMatchObject({ id: K(BETA, A), label: 'Run echo beta' });
  });

  it('reads a workflow agent\'s label from its run\'s journal', () => {
    const ws = workspace();
    writeJournal(ws);
    expect(fire(ws, load(ws, 'e_parent_post_workflow'))).toEqual([]);
    expect(agentPosts(post(ws, load(ws, 'e_subagent_start_one')))[0].agent).toMatchObject({
      id: K(WF_ONE, E), state: 'planning', kind: 'workflow', label: 'echo:one',
    });
  });

  it('finds the journal by a bounded scan when the run was never recorded', () => {
    const ws = workspace();
    writeJournal(ws);
    expect(agentPosts(post(ws, load(ws, 'e_subagent_start_two')))[0].agent).toMatchObject({
      id: K(WF_TWO, E), kind: 'workflow', label: 'echo:two',
    });
  });

  it('calls an agent found in a run\'s journal a workflow agent, whatever it is typed', () => {
    const ws = workspace();
    writeJournal(ws);
    fire(ws, load(ws, 'e_parent_post_workflow'));
    expect(agentPosts(post(ws, load(ws, 'e_subagent_start_two', { agent_type: 'Explore' })))[0].agent).toMatchObject({
      kind: 'workflow', label: 'echo:two',
    });
  });

  it('labels a nested subagent from the launch its parent subagent made', () => {
    const ws = workspace();
    const sid = '2f310006-25a7-4cd3-aaed-41d63f721448';
    for (const n of ['b_parent_pre_agent_outer', 'b_subagent_start_outer']) post(ws, load(ws, n));
    // Delegating is planning, as its start was: nothing to post, but the
    // launch is recorded for the nested subagent's own start.
    expect(post(ws, load(ws, 'b_outer_pre_agent_inner'))).toEqual([]);
    expect(agentPosts(post(ws, load(ws, 'b_subagent_start_inner')))[0].agent).toMatchObject({
      id: K('a39fbd03275abc4b7', sid), label: 'inner',
    });
    // Its meta.json, as the probe found it, confirms the guess: no correction.
    writeMeta(ws, sid, 'a39fbd03275abc4b7', JSON.parse(fs.readFileSync(path.join(FIXTURES, 'meta_b_inner.json'), 'utf8')).meta);
    expect(agentPosts(post(ws, load(ws, 'b_inner_pre_bash')))[0].agent).toMatchObject({
      state: 'coding', label: 'inner', activity: 'Print nested',
    });
  });
});

describe('launch results', () => {
  it('consumes the record of a remote launch, so the next start claims nothing', () => {
    const ws = workspace();
    post(ws, load(ws, 'a_parent_pre_agent_alpha'));
    const result = load(ws, 'a_parent_post_agent_alpha');
    expect(fire(ws, { ...result, tool_response: { status: 'remote_launched', taskId: 'r1' } })).toEqual([]);
    const [start] = agentPosts(post(ws, load(ws, 'a_subagent_start_beta')));
    expect(start.agent).not.toHaveProperty('label');
    expect(fs.readdirSync(path.join(sessionDir(ws, A), 'launch'))).toEqual([]);
  });
});

describe('minimal mode', () => {
  it('sends nothing that describes a subagent, and never a title as name', () => {
    const ws = workspace();
    const env = { AGSTATUS_DETAIL: 'off' };
    // A title pinned while detail was on: minimal mode must not use it.
    const names = path.join(ws.tmp, `agstatus-names-${sha256(`${base}\nclaude`).slice(0, 12)}.json`);
    fs.writeFileSync(names, JSON.stringify({ names: { [A]: { name: 'proj', title: 'Payroll export rewrite', at: Date.now() } } }));
    const all: Json[] = [];
    const run = (p: Json, e: Record<string, string> = env) => all.push(...post(ws, p, e));

    run(load(ws, 'a_parent_pre_agent_alpha'));
    run(load(ws, 'a_subagent_start_alpha'));
    run(load(ws, 'a_pre_bash_alpha'));
    writeMeta(ws, A, ALPHA, { description: 'Secret meta description', toolUseId: 'toolu_014ut2LA8noPaPhsYzMqEUE2' });
    run(load(ws, 'a_pre_bash_alpha', { tool_name: 'WebSearch', tool_input: { query: 'salary bands' } }));
    run(load(ws, 'a_pre_bash_alpha', { hook_event_name: 'PermissionRequest', tool_name: 'mcp__payroll__export', tool_input: { q: 'x' } }));
    ageMarkers(ws, A, K(ALPHA, A), 3000);
    run(notification(A, ws, { notification_type: 'permission_prompt', message: 'Claude needs your permission to use mcp__payroll__export' }));
    run({
      session_id: A, transcript_path: path.join(ws.projects, `${A}.jsonl`), cwd: ws.cwd,
      hook_event_name: 'PostToolUseFailure', tool_name: 'Agent', tool_use_id: 'toolu_014ut2LA8noPaPhsYzMqEUE2',
      error: 'Secret failure text', is_interrupt: false,
    });
    // A workflow agent whose journal names it.
    writeJournal(ws);
    run(load(ws, 'e_parent_post_workflow'));
    run(load(ws, 'e_subagent_start_one'));
    // A failed background subagent, by its notification.
    for (const n of ['c_parent_pre_agent', 'c_subagent_start']) run(load(ws, n));
    const note = load(ws, 'c_task_notification');
    run({ ...note, prompt: String(note.prompt).replace('<status>completed</status>', '<status>failed</status>')
      .replace('Agent "bg echo" finished', 'Agent "bg echo" failed: secret reason') });
    // A Codex sub-agent with a nickname.
    const sub = codexRollout(ws, SUB_THREAD, subMeta());
    run(codexEvent(ws, 'SubagentStart', sub, { agent_id: SUB_THREAD, agent_type: 'default' }), { ...env, ...CODEX });

    const wire = JSON.stringify(all);
    for (const needle of [
      'Run echo alpha', 'Print alpha', 'echo alpha', 'Secret meta description', 'salary bands', 'mcp__',
      'Secret failure text', 'echo:one', 'bg echo', 'secret reason', 'Feynman', 'reset_scope_review',
      ALPHA, BG, WF_ONE, SUB_THREAD, 'Payroll export rewrite',
    ]) {
      expect(wire, needle).not.toContain(needle);
    }
    const allowed = new Set([
      'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'Bash', 'Agent', 'Task', 'WebSearch',
      'WebFetch', 'Workflow', 'Read', 'Glob', 'Grep', 'Skill', 'Failed', 'Stopped', 'Blocked', 'Needs approval',
    ]);
    const agents = agentPosts(all);
    expect(agents.length).toBeGreaterThanOrEqual(7);
    for (const b of agents) {
      expect(b.agent).not.toHaveProperty('label');
      if ('activity' in b.agent) expect(allowed.has(b.agent.activity), b.agent.activity).toBe(true);
    }
    expect(agents.map((b) => b.agent.activity).filter(Boolean)).toEqual(
      expect.arrayContaining(['Bash', 'WebSearch', 'Needs approval', 'Failed']),
    );
    for (const b of all) expect(b.name).not.toBe('Payroll export rewrite');
  });
});

describe('permissions', () => {
  const ask = (ws: Ws, session: string, message = 'Claude needs your permission') =>
    post(ws, notification(session, ws, { notification_type: 'permission_prompt', message }));

  it('a main-thread marker gives today\'s blocked post, with no unattributed flag', () => {
    const ws = workspace();
    const request = load(ws, 'd2_permission_request');
    delete request.agent_id;
    delete request.agent_type;
    expect(fire(ws, request)).toEqual([]);
    ageMarkers(ws, D2, 'main', 3000);
    expect(ask(ws, D2).map(shape)).toEqual([{
      session_id: D2, status: 'blocked', message: 'Claude needs your permission', project: 'proj', source: 'claude',
    }]);
  });

  /** Two known subagents in d2's session, each with a marker: alpha's for Bash (older), beta's for Edit. */
  function twoAsking(ws: Ws): void {
    for (const id of [ALPHA, BETA]) post(ws, load(ws, 'd2_subagent_start', { agent_id: id }));
    fire(ws, load(ws, 'd2_permission_request', { agent_id: ALPHA }));
    fire(ws, load(ws, 'd2_permission_request', { agent_id: BETA, tool_name: 'Edit', tool_input: { file_path: '/x/y.ts' } }));
    ageMarkers(ws, D2, K(ALPHA, D2), 5000);
    ageMarkers(ws, D2, K(BETA, D2), 3000);
  }

  it('claims the oldest marker when the message names no tool', () => {
    const ws = workspace();
    twoAsking(ws);
    expect(agentPosts(ask(ws, D2)).map((b) => b.agent.id)).toEqual([K(ALPHA, D2)]);
  });

  it('claims the marker for the tool the message names', () => {
    const ws = workspace();
    twoAsking(ws);
    const [body] = agentPosts(ask(ws, D2, 'Claude needs your permission to use Edit'));
    expect(body.agent).toMatchObject({ id: K(BETA, D2), state: 'blocked', activity: 'Approve: Editing y.ts' });
  });

  it('drops a subagent\'s marker once it calls a tool again', () => {
    const ws = workspace();
    post(ws, load(ws, 'd2_subagent_start'));
    fire(ws, load(ws, 'd2_permission_request'));
    ageMarkers(ws, D2, K(TOUCH, D2), 3000);
    post(ws, load(ws, 'd2_pre_bash')); // answered: it moved on
    const bodies = ask(ws, D2);
    expect(agentPosts(bodies)).toEqual([]);
    expect(bodies[0]).toMatchObject({ status: 'blocked', unattributed: true });
  });

  it('posts nothing for a background subagent\'s auto-denied request', () => {
    const ws = workspace();
    for (const n of ['c_parent_pre_agent', 'c_subagent_start']) post(ws, load(ws, n));
    expect(fire(ws, load(ws, 'd2_permission_request', { session_id: C, agent_id: BG }))).toEqual([]);
  });

  it.skipIf(!POSIX)('never touches CODEX_HOME for a Claude PermissionRequest', () => {
    const ws = workspace();
    const trace = path.join(ws.root, 'codex-trace.txt');
    const preload = path.join(ws.root, 'trace-codex.js');
    fs.writeFileSync(preload, `
      const fs = require('fs');
      const home = process.env.CODEX_HOME, out = process.env.TRACE_FILE;
      for (const name of ['readdirSync', 'statSync', 'openSync']) {
        const real = fs[name];
        fs[name] = function (p, ...rest) {
          if (typeof p === 'string' && home && p.startsWith(home)) fs.appendFileSync(out, name + ' ' + p + '\\n');
          return real.call(this, p, ...rest);
        };
      }
    `);
    fs.writeFileSync(trace, '');
    // A Codex log under CODEX_HOME that the Codex approval check would read.
    codexRollout(ws, SUB_THREAD, subMeta(), [turnContext('turn-1', 'auto_review')]);
    post(ws, load(ws, 'd2_subagent_start'));
    fire(ws, load(ws, 'd2_permission_request'), { TRACE_FILE: trace }, ['--require', preload]);
    const main = load(ws, 'd2_permission_request');
    delete main.agent_id;
    fire(ws, main, { TRACE_FILE: trace }, ['--require', preload]);
    expect(fs.readFileSync(trace, 'utf8')).toBe('');
  });
});

describe('notification types', () => {
  it('posts nothing for the types that ask nobody anything', () => {
    const ws = workspace();
    for (const type of [
      'auth_success', 'elicitation_complete', 'elicitation_response', 'agent_completed',
      'quota_auto_resume_fired', 'quota_auto_resume_disabled', 'plugin_notification',
    ]) {
      expect(fire(ws, notification(A, ws, { notification_type: type, message: 'x' })), type).toEqual([]);
    }
  });

  it('keeps idle prompts and untyped notifications blocked', () => {
    const ws = workspace();
    for (const extra of [{ notification_type: 'idle_prompt' }, {}, { notification_type: 'something_new' }]) {
      const [body] = post(ws, notification(A, ws, { message: 'Claude is waiting for your input', ...extra }));
      expect(body).toMatchObject({ status: 'blocked', message: 'Claude is waiting for your input' });
      expect(body).not.toHaveProperty('unattributed');
    }
  });

  it('marks the elicitation types unattributed', () => {
    const ws = workspace();
    for (const type of ['elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']) {
      expect(post(ws, notification(A, ws, { notification_type: type, message: 'Answer me' }))[0]).toMatchObject({
        status: 'blocked', unattributed: true,
      });
    }
  });
});

describe('task notifications', () => {
  const block = (id: string, status: string, result = 'ok') =>
    `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>${status}</status>\n` +
    `<summary>Agent "bg echo" ${status === 'failed' ? 'failed: model refused' : 'finished'}</summary>\n` +
    `<result>${result}</result>\n</task-notification>`;
  const prompt = (ws: Ws, text: string) => load(ws, 'c_task_notification', { prompt: text });
  const reading = { status: 'planning', message: 'Reading subagent results' };

  it('reads bare and reminder-wrapped notification-only prompts the same way', () => {
    const ws = workspace();
    for (const text of [
      block(BG, 'completed'),
      `<system-reminder>\n${block(BG, 'completed')}\n</system-reminder>`,
    ]) {
      const bodies = post(ws, prompt(ws, text));
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject(reading);
      expect(bodies[0]).not.toHaveProperty('turn');
    }
  });

  it('starts a turn with only the user\'s words when they wrote some too', () => {
    const ws = workspace();
    const [body] = post(ws, prompt(ws, `Now merge the branch, please\n${block(BG, 'completed')}`));
    expect(body).toMatchObject({ status: 'planning', message: 'Now merge the branch, please', turn: { phase: 'start' } });
    // A prompt that OPENS with a block is the parent being told, whatever
    // follows it: a result may quote the close tag and leave its tail behind.
    expect(post(ws, prompt(ws, `${block(BG, 'completed')}\nNow merge the branch, please`))[0])
      .toMatchObject({ message: 'Reading subagent results' });
  });

  it('stays notification-only when a result quotes the close tag', () => {
    const ws = workspace();
    const quoted = block(BG, 'completed', 'the tag is </task-notification> and then more words');
    expect(post(ws, prompt(ws, quoted))[0]).toMatchObject(reading);
  });

  it('fails a killed subagent as Stopped, and a failed one with its reason', () => {
    const ws = workspace();
    for (const n of ['c_parent_pre_agent', 'c_subagent_start']) post(ws, load(ws, n));
    expect(agentPosts(post(ws, prompt(ws, block(BG, 'killed'))))[0].agent).toMatchObject({ state: 'failed', activity: 'Stopped' });
    const other = workspace();
    for (const n of ['c_parent_pre_agent', 'c_subagent_start']) post(other, load(other, n));
    expect(agentPosts(post(other, prompt(other, block(BG, 'failed'))))[0].agent).toMatchObject({
      state: 'failed', activity: 'Failed: model refused',
    });
  });

  it('says nothing more about a subagent already confirmed done, or about a workflow', () => {
    const ws = workspace();
    for (const n of ['c_parent_pre_agent', 'c_subagent_start', 'c_subagent_stop']) post(ws, load(ws, n));
    expect(agentPosts(post(ws, prompt(ws, block(BG, 'completed'))))).toEqual([]);
    expect(post(ws, load(ws, 'e_task_notification')).map(shape)).toEqual([
      { session_id: E, ...reading, project: 'proj', source: 'claude' },
    ]);
  });
});

describe('Stop with background work', () => {
  const stop = (ws: Ws, tasks: unknown) => {
    const payload = load(ws, 'c_stop_bg_running', { background_tasks: tasks });
    if (tasks === undefined) delete payload.background_tasks;
    return post(ws, payload)[0].turn;
  };

  it('lists running subagents and counts workflows, and nothing else', () => {
    const ws = workspace();
    expect(stop(ws, [
      { id: BG, type: 'subagent', status: 'running', description: 'bg echo' },
      { id: 'b7', type: 'shell', status: 'running', description: 'npm run dev' },
      { id: 'wxtleurg3', type: 'workflow', status: 'running', name: 'probe' },
      { id: 'tm1', type: 'teammate', status: 'running', name: 'reviewer' },
      { id: 'adone', type: 'subagent', status: 'completed' },
    ])).toEqual({ phase: 'end', running: [K(BG, C)], workflows: 1 });
  });

  it('sends no lists when the registry was unreachable, too long, or held an unusable id', () => {
    const ws = workspace();
    expect(stop(ws, undefined)).toEqual({ phase: 'end' });
    const many = Array.from({ length: 65 }, (_, i) => ({ id: `a${i}`, type: 'subagent', status: 'running' }));
    expect(stop(ws, many)).toEqual({ phase: 'end' });
    expect(stop(ws, [{ id: 7, type: 'subagent', status: 'running' }])).toEqual({ phase: 'end' });
  });
});

describe('Codex sub-agents', () => {
  it('follows a sub-agent from root prompt to follow-up, reports usage, and never touches host records', () => {
    const ws = workspace();
    // Focus on: the root's own events keep a host record.
    fs.writeFileSync(path.join(ws.home, '.agstatus.json'), JSON.stringify({ focus: true }));
    fs.writeFileSync(path.join(ws.state, 'machine.json'), JSON.stringify({ machineId: '6f1c2b3a-4d5e-4f60-8a9b-0c1d2e3f4a5b', name: 'Studio' }));
    const root = codexRollout(ws, ROOT_THREAD, { id: ROOT_THREAD, session_id: ROOT_THREAD, originator: 'codex_cli_rs' });
    const sub = codexRollout(ws, SUB_THREAD, subMeta(), [
      turnContext('turn-auto', 'auto_review'), turnContext('turn-user', 'user'), RATE_LIMITS(),
    ]);
    const key = K(SUB_THREAD, ROOT_THREAD, 'codex');
    const tagged = { agent_id: SUB_THREAD, agent_type: 'default' };

    expect(post(ws, codexEvent(ws, 'UserPromptSubmit', root, { prompt: 'Review the reset scope' }), CODEX)[0])
      .toMatchObject({ message: 'Processing prompt', turn: { phase: 'start' } });
    expect(post(ws, codexEvent(ws, 'SubagentStart', sub, tagged), CODEX)[0].agent)
      .toMatchObject({ id: key, state: 'planning', kind: 'codex', label: 'Feynman' });

    // Usage reports still run on a sub-agent's PreToolUse.
    const pre = fire(ws, codexEvent(ws, 'PreToolUse', sub, { ...tagged, tool_name: 'apply_patch', tool_input: {} }),
      { ...CODEX, AGSTATUS_USAGE: undefined });
    expect(posts(pre).map((b) => b.agent)).toEqual([
      expect.objectContaining({ id: key, state: 'coding', activity: 'Editing files', label: 'Feynman' }),
    ]);
    expect(pre.some((r) => r.url === '/usage')).toBe(true);

    expect(post(ws, codexEvent(ws, 'PermissionRequest', sub, {
      ...tagged, turn_id: 'turn-auto', tool_name: 'Bash', tool_input: { description: 'May I?' },
    }), CODEX)).toEqual([]);
    expect(post(ws, codexEvent(ws, 'PermissionRequest', sub, {
      ...tagged, turn_id: 'turn-user', tool_name: 'Bash', tool_input: { description: 'May I run it?' },
    }), CODEX)[0]).toMatchObject({ status: 'blocked', message: 'May I run it?', agent: { state: 'blocked', activity: 'May I run it?' } });

    expect(post(ws, codexEvent(ws, 'SubagentStop', root, { ...tagged, agent_transcript_path: sub, last_assistant_message: 'ok' }), CODEX)[0])
      .toMatchObject({ status: 'planning', agent: { id: key, state: 'done', kind: 'codex' } });
    // Re-tasked: its next tool call brings the row back.
    expect(post(ws, codexEvent(ws, 'PreToolUse', sub, { ...tagged, tool_name: 'Bash', tool_input: { command: ['bash', '-lc', 'cargo test'] } }), CODEX)[0].agent)
      .toMatchObject({ id: key, state: 'testing' });

    // The root's own Stop keeps the host record; nothing a sub-agent fired is in it.
    expect(post(ws, codexEvent(ws, 'Stop', root, {}), CODEX)[0]).toMatchObject({ turn: { phase: 'end' } });
    const records = path.join(ws.state, 'sessions', ROOT_THREAD);
    const files = fs.readdirSync(records);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(fs.readFileSync(path.join(records, f), 'utf8')).not.toContain(SUB_THREAD);
  });
});

describe('concurrency', () => {
  it('records twenty subagents starting and stopping at once without losing one', async () => {
    const ws = workspace();
    const ids = Array.from({ length: 20 }, (_, i) => `a${String(i).padStart(2, '0')}${'0'.repeat(14)}`);
    const burst = (event: string) =>
      Promise.all(ids.map((id) => new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [HOOK], { env: hookEnv(ws, {}), stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', reject);
        child.on('exit', () => resolve());
        child.stdin!.end(JSON.stringify(load(ws, event === 'start' ? 'a_subagent_start_alpha' : 'a_subagent_stop_alpha', { agent_id: id })));
      })));
    const before = captured().length;
    await burst('start');
    await burst('stop');
    const bodies = posts(captured().slice(before));
    const starts = bodies.filter((b) => b.agent?.state === 'planning');
    const stops = bodies.filter((b) => b.agent?.state === 'done');
    expect(new Set(starts.map((b) => b.agent.id)).size).toBe(20);
    expect(starts).toHaveLength(20);
    expect(new Set(stops.map((b) => b.agent.id)).size).toBe(20);
    expect(stops).toHaveLength(20);
  }, 30_000);
});

describe.skipIf(!POSIX)('local state safety', () => {
  it('keeps files 0600 in 0700 directories', () => {
    const ws = workspace();
    post(ws, load(ws, 'a_parent_pre_agent_alpha'));
    post(ws, load(ws, 'a_subagent_start_alpha'));
    const dir = sessionDir(ws, A);
    for (const d of [stateRoot(ws), dir, path.join(dir, 'agents'), path.join(dir, 'bind')]) {
      expect(fs.statSync(d).mode & 0o777, d).toBe(0o700);
    }
    for (const kind of ['agents', 'bind']) {
      for (const f of fs.readdirSync(path.join(dir, kind))) {
        expect(fs.statSync(path.join(dir, kind, f)).mode & 0o777).toBe(0o600);
      }
    }
  });

  /** A start posts nothing and a tool call takes the 1.6.3 path: the stateless reading. */
  function expectStateless(ws: Ws, nodeArgs: string[] = []): void {
    expect(fire(ws, load(ws, 'a_subagent_start_alpha'), {}, nodeArgs)).toEqual([]);
    const bodies = posts(fire(ws, load(ws, 'a_pre_bash_alpha'), {}, nodeArgs));
    expect(bodies.map(shape)).toEqual([
      { session_id: A, status: 'coding', message: 'Print alpha', project: 'proj', source: 'claude' },
    ]);
  }

  it('runs stateless under a root anyone can write to', () => {
    const ws = workspace();
    fs.mkdirSync(stateRoot(ws));
    fs.chmodSync(stateRoot(ws), 0o777);
    expectStateless(ws);
    expect(fs.readdirSync(stateRoot(ws))).toEqual([]);
  });

  it('runs stateless under a root another account owns', () => {
    const ws = workspace();
    // The hook is told it runs as another uid; the root it finds is then
    // owned by someone else — as a squatter's would be.
    const preload = path.join(ws.root, 'uid.js');
    fs.writeFileSync(preload, 'const uid = process.getuid(); process.getuid = () => uid + 1;\n');
    const squatted = path.join(ws.tmp, `agstatus-subtasks-${process.getuid!() + 1}-${sha256(`${base}\nclaude`).slice(0, 12)}`);
    fs.mkdirSync(squatted, { mode: 0o700 });
    expectStateless(ws, ['--require', preload]);
    expect(fs.readdirSync(squatted)).toEqual([]);
  });

  it('runs stateless under a root that is a link, and writes nothing through it', () => {
    const ws = workspace();
    const elsewhere = path.join(ws.root, 'elsewhere');
    fs.mkdirSync(elsewhere, { mode: 0o700 });
    fs.symlinkSync(elsewhere, stateRoot(ws));
    expectStateless(ws);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('never writes through a link planted at a temp name', () => {
    const ws = workspace();
    const preload = path.join(ws.root, 'random.js');
    fs.writeFileSync(preload, "require('crypto').randomBytes = (n) => Buffer.alloc(n, 0xab);\n");
    const agents = path.join(sessionDir(ws, A), 'agents');
    fs.mkdirSync(agents, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateRoot(ws), 0o700);
    const victim = path.join(ws.root, 'victim.txt');
    fs.writeFileSync(victim, 'untouched');
    fs.symlinkSync(victim, path.join(agents, `${K(ALPHA, A)}.json.abababab.tmp`));
    // The subagent cannot be recorded, so its start posts nothing...
    expect(fire(ws, load(ws, 'a_subagent_start_alpha'), {}, ['--require', preload])).toEqual([]);
    // ...and the file behind the link is as it was.
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
  });

  it('is not held up by a FIFO where an agent file belongs', () => {
    const ws = workspace();
    const agents = path.join(sessionDir(ws, A), 'agents');
    fs.mkdirSync(agents, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateRoot(ws), 0o700);
    execFileSync('mkfifo', [path.join(agents, `${K(ALPHA, A)}.json`)]);
    const started = Date.now();
    const bodies = posts(fire(ws, load(ws, 'a_pre_bash_alpha')));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(bodies.map(shape)).toEqual([
      { session_id: A, status: 'coding', message: 'Print alpha', project: 'proj', source: 'claude' },
    ]);
  });

  it('removes the session\'s directory at SessionEnd, after the DELETE goes out', () => {
    const ws = workspace();
    post(ws, load(ws, 'a_parent_pre_agent_alpha'));
    post(ws, load(ws, 'a_subagent_start_alpha'));
    expect(fs.existsSync(sessionDir(ws, A))).toBe(true);
    const reqs = fire(ws, { session_id: A, cwd: ws.cwd, hook_event_name: 'SessionEnd', reason: 'exit' });
    expect(reqs.map((r) => `${r.method} ${r.url}`)).toEqual([`DELETE /sessions/${A}`]);
    expect(fs.existsSync(sessionDir(ws, A))).toBe(false);
    expect(fs.existsSync(stateRoot(ws))).toBe(true);
  });

  it('ages entries out by kind, and quiet sessions with them', () => {
    const ws = workspace();
    post(ws, load(ws, 'a_parent_pre_agent_alpha'));
    const dir = sessionDir(ws, A);
    const min = 60 * 1000;
    const plant = (kind: string, name: string, ageMs: number) => {
      fs.mkdirSync(path.join(dir, kind), { recursive: true, mode: 0o700 });
      const file = path.join(dir, kind, name);
      fs.writeFileSync(file, '{"v":1}', { mode: 0o600 });
      const t = (Date.now() - ageMs) / 1000;
      fs.utimesSync(file, t, t);
      return file;
    };
    const gone = [
      plant('launch', 'old.json', 11 * min), plant('perm', 'main-1.json', 31 * min),
      plant('agents', 'old.json', 25 * 60 * min), plant('labels', 'old.json', 25 * 60 * min),
      plant('bind', 'old.json', 25 * 60 * min), plant('runs', 'old.json', 25 * 60 * min),
    ];
    const kept = [
      plant('launch', 'new.json', 9 * min), plant('perm', 'main-2.json', 29 * min),
      plant('agents', 'new.json', 23 * 60 * min), plant('runs', 'new.json', 23 * 60 * min),
    ];
    const quiet = path.join(stateRoot(ws), '0123456789abcdef');
    const busy = path.join(stateRoot(ws), 'fedcba9876543210');
    for (const d of [quiet, busy]) fs.mkdirSync(path.join(d, 'agents'), { recursive: true, mode: 0o700 });
    for (const d of [quiet, path.join(quiet, 'agents')]) {
      const t = (Date.now() - 25 * 60 * min) / 1000;
      fs.utimesSync(d, t, t);
    }
    post(ws, load(ws, 'e_session_start', { session_id: A }));
    for (const f of gone) expect(fs.existsSync(f), f).toBe(false);
    for (const f of kept) expect(fs.existsSync(f), f).toBe(true);
    expect(fs.existsSync(quiet)).toBe(false);
    expect(fs.existsSync(busy)).toBe(true);
  });
});

describe('several requests in one event', () => {
  it('delivers the others when one connection is reset', async () => {
    const ws = workspace();
    for (const id of [ALPHA, BETA]) {
      post(ws, load(ws, 'c_subagent_start', { agent_id: id }));
      post(ws, load(ws, 'c_pre_bash_bg', { agent_id: id }));
    }
    const note = (id: string) =>
      `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>`;
    queue({ reset: true }, { delay: 400 }, { delay: 400 });
    const before = captured().length;
    execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify(load(ws, 'c_task_notification', { prompt: `${note(ALPHA)}\n${note(BETA)}` })),
      env: hookEnv(ws, {}),
      timeout: 10_000,
    });
    // A request the hook walked away from would be recorded once its delay ran out.
    await new Promise((r) => setTimeout(r, 600));
    const reqs = captured().slice(before);
    expect(reqs).toHaveLength(3);
    expect(reqs.filter((r) => r.outcome === 'reset')).toHaveLength(1);
    expect(reqs.filter((r) => r.outcome === 'ok')).toHaveLength(2);
  });
});
