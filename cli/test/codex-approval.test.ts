import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Codex's `PermissionRequest` does NOT mean a human is waiting.
 *
 * It fires whenever the model asks to escalate, whoever answers — and on the
 * machine this was diagnosed on, 1418 of 2097 turns answered themselves
 * (`approvals_reviewer: "auto_review"`). The hook used to map the event
 * straight to `blocked`, which fires a push, so roughly two notifications in
 * three were for nothing. It was caught live in a project called `perf-ads`:
 * Codex requested an escalation, the card went red and pushed, and Codex
 * carried on to `testing` on its own. Nobody was ever asked.
 *
 * The discriminator is `approvals_reviewer` in the rollout log's
 * `turn_context`. It is NOT `approval_policy`, which is the obvious wrong
 * guess and is covered by its own case below.
 *
 * These drive the REAL hook script against a fake CODEX_HOME, with the capture
 * server as a SIBLING child process (same sandbox reason as messages.test.ts).
 */

const HOOK = path.resolve(__dirname, '..', 'assets', 'agstatus-hook.js');

interface Post { url: string; body: string }
interface Card { status: string; message: string; session_id: string }

let server: ChildProcess;
let base: string;
let capturePath: string;
let home: string;

beforeAll(async () => {
  capturePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-ap-')), 'posted.jsonl');
  fs.writeFileSync(capturePath, '');
  const script = `
    const http = require('http'), fs = require('fs');
    const out = process.argv[1];
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        fs.appendFileSync(out, JSON.stringify({ url: req.url, body: b }) + '\\n');
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

afterAll(() => { server?.kill(); });

beforeEach(() => {
  fs.writeFileSync(capturePath, '');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-codexhome-'));
});

/** One `turn_context` rollout line — written by Codex at the START of a turn. */
const turnContext = (turnId: string, reviewer: string, approvalPolicy = 'on-request') =>
  JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'turn_context',
    payload: {
      turn_id: turnId,
      cwd: '/tmp/demo-project',
      approval_policy: approvalPolicy,
      approvals_reviewer: reviewer,
      sandbox_policy: { type: 'read-only' },
    },
  });

/** Filler, so turn_context is not trivially the last line of the file. */
const filler = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'reasoning', id: `r${i}`, text: 'x'.repeat(400) } }));

/**
 * Writes a rollout log. `fileId` is what NAMES the file, which in real logs is
 * the thread id and usually is NOT the payload's session_id — that mismatch is
 * the whole reason `transcript_path` exists on the payload.
 */
function writeRollout(fileId: string, lines: string[], stamp = '2026-10-05T01-44-16') {
  const dir = path.join(home, 'sessions', '2026', '10', '05');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${stamp}-${fileId}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

/** Fires the hook as Codex and returns everything it POSTed. */
function fire(payload: Record<string, unknown>, extraEnv: Record<string, string> = {}): Post[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-tmp-'));
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: '/tmp/demo-project', ...payload }),
    env: {
      ...process.env,
      CLAUDE_STATUS_URL: base, AGSTATUS_SOURCE: 'codex', CODEX_HOME: home,
      TMPDIR: tmp, AGSTATUS_STATE_DIR: tmp, ...extraEnv,
    },
    timeout: 10_000,
  });
  // The hook awaits every post before it exits, and the capture server appends
  // before it responds — so by the time execFileSync returns, what was sent is
  // on disk. A missing /webhook therefore means the hook chose not to send one.
  return fs.readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as Post);
}

const card = (posts: Post[]): Card | undefined => {
  const p = posts.find((x) => x.url === '/webhook');
  return p ? (JSON.parse(p.body) as Card) : undefined;
};

describe('Codex PermissionRequest: only a human reviewer means blocked', () => {
  it('says nothing at all when Codex approves its own escalation', () => {
    const file = writeRollout('01a108dc-dcce-7000-aaaa-000000000001', [
      turnContext('turn-1', 'auto_review'),
      ...filler(20),
    ]);
    const posts = fire({
      hook_event_name: 'PermissionRequest',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      transcript_path: file,
      tool_input: { description: 'May I run the readiness tests?' },
    });
    // Not "blocked with a quieter message" — no status post at all. The card
    // keeps whatever it was already showing, because nothing about the session
    // changed.
    expect(card(posts)).toBeUndefined();
  });

  it('still reports blocked when a human is the reviewer', () => {
    const file = writeRollout('01a108dc-dcce-7000-aaaa-000000000002', [
      turnContext('turn-1', 'user'),
      ...filler(20),
    ]);
    const posts = fire({
      hook_event_name: 'PermissionRequest',
      session_id: 'sess-2',
      turn_id: 'turn-1',
      transcript_path: file,
      tool_input: { description: 'May I run the readiness tests?' },
    });
    expect(card(posts)?.status).toBe('blocked');
  });

  // The 433-row case from the cross-tab: gating on approval_policy would have
  // silenced every one of these.
  it('reports blocked on approval_policy "never" when the reviewer is a human', () => {
    const file = writeRollout('01a108dc-dcce-7000-aaaa-000000000003', [
      turnContext('turn-1', 'user', 'never'),
      ...filler(20),
    ]);
    const posts = fire({
      hook_event_name: 'PermissionRequest', session_id: 'sess-3', turn_id: 'turn-1',
      transcript_path: file,
    });
    expect(card(posts)?.status).toBe('blocked');
  });

  // ...and the 441-row case: on-request does not mean a human either.
  it('stays quiet on approval_policy "on-request" when the reviewer is automatic', () => {
    const file = writeRollout('01a108dc-dcce-7000-aaaa-000000000004', [
      turnContext('turn-1', 'auto_review', 'on-request'),
      ...filler(20),
    ]);
    const posts = fire({
      hook_event_name: 'PermissionRequest', session_id: 'sess-4', turn_id: 'turn-1',
      transcript_path: file,
    });
    expect(card(posts)).toBeUndefined();
  });

  it('matches the turn, rather than taking the last context in the file', () => {
    // The turn under request is `turn-A` (a human). `turn-B` started later and
    // is automatic — reading the end of the file would answer for the wrong
    // turn and swallow a request someone is actually waiting on.
    const file = writeRollout('01a108dc-dcce-7000-aaaa-000000000005', [
      turnContext('turn-A', 'user'),
      ...filler(10),
      turnContext('turn-B', 'auto_review'),
      ...filler(10),
    ]);
    const posts = fire({
      hook_event_name: 'PermissionRequest', session_id: 'sess-5', turn_id: 'turn-A',
      transcript_path: file,
    });
    expect(card(posts)?.status).toBe('blocked');
  });

  it('finds the log by transcript_path when the filename does not carry the session id', () => {
    // Real rollouts are named by thread id: 181 of the 226 on the diagnosis
    // machine had a filename that did not match their own session_id. Searching
    // by session_id alone would never find this file.
    const file = writeRollout('01a108dc-dcce-7000-ffff-999999999999', [
      turnContext('turn-1', 'auto_review'),
      ...filler(20),
    ]);
    expect(path.basename(file)).not.toContain('sess-6');
    const posts = fire({
      hook_event_name: 'PermissionRequest', session_id: 'sess-6', turn_id: 'turn-1',
      transcript_path: file,
    });
    expect(card(posts)).toBeUndefined();
  });

  it('reports blocked when the reviewer cannot be determined', () => {
    // No rollout log at all. Unknown must fail towards telling you: a missed
    // notification defeats the product, an extra one is the noise we had.
    const posts = fire({
      hook_event_name: 'PermissionRequest', session_id: 'sess-7', turn_id: 'turn-1',
    });
    expect(card(posts)?.status).toBe('blocked');
  });

  it('never answers from another session\'s log', () => {
    // A sibling rollout says auto_review, but it belongs to a different
    // conversation and cannot speak for this one. Unattributable is unknown.
    writeRollout('01a108dc-dcce-7000-bbbb-000000000008', [
      turnContext('turn-1', 'auto_review'),
      ...filler(20),
    ]);
    const posts = fire({
      hook_event_name: 'PermissionRequest', session_id: 'sess-8', turn_id: 'turn-1',
    });
    expect(card(posts)?.status).toBe('blocked');
  });

  it('shows the question the model actually asked, and hides it in minimal mode', () => {
    const lines = [turnContext('turn-1', 'user'), ...filler(20)];
    const q = 'May I run the readiness tests in a fresh disposable PostgreSQL cluster?';

    const file9 = writeRollout('01a108dc-dcce-7000-cccc-000000000009', lines);
    const open = fire({
      hook_event_name: 'PermissionRequest', session_id: 'sess-9', turn_id: 'turn-1',
      transcript_path: file9, tool_input: { description: q },
      message: 'Needs approval to run a command',
    });
    // tool_input.description beats payload.message: it is the written-out
    // question rather than a generic label.
    expect(card(open)?.message).toBe(q);

    fs.writeFileSync(capturePath, '');
    const quiet = fire(
      {
        hook_event_name: 'PermissionRequest', session_id: 'sess-9', turn_id: 'turn-1',
        transcript_path: file9, tool_input: { description: q },
      },
      { AGSTATUS_DETAIL: 'off' },
    );
    expect(card(quiet)?.message).toBe('Needs approval');
    expect(card(quiet)?.message).not.toContain('PostgreSQL');
  });

  it('keeps reporting plan usage on an escalation it stays quiet about', () => {
    // The event is still a fine moment to refresh the bars; it just is not a
    // state change. Suppressing the card must not suppress the usage report.
    const file = writeRollout('01a108dc-dcce-7000-dddd-000000000010', [
      turnContext('turn-1', 'auto_review'),
      JSON.stringify({
        timestamp: new Date().toISOString(), type: 'event_msg',
        payload: {
          type: 'token_count', info: { total_token_usage: { total_tokens: 100 } },
          rate_limits: {
            limit_id: 'codex', limit_name: null, secondary: null,
            primary: { used_percent: 42, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 600 },
          },
        },
      }),
    ]);
    const posts = fire({
      hook_event_name: 'PermissionRequest', session_id: 'sess-10', turn_id: 'turn-1',
      transcript_path: file,
    });
    expect(card(posts)).toBeUndefined();
    expect(posts.some((p) => p.url === '/usage')).toBe(true);
  });
});

describe('a session with no project folder gets a readable name', () => {
  // A GUI-launched agent has no working directory: macOS starts it in `/`, and
  // basename('/') is ''. That empty name reached the server, whose last-resort
  // fallback is the session id — so Codex Desktop sessions arrived on the board
  // titled `01a10b09-b1ee-7501-95b4-d0ebf7acad5e`.
  it('names a card after the agent when cwd has no basename', () => {
    const posts = fire({ hook_event_name: 'SessionStart', session_id: 'gui-1', cwd: '/' });
    const c = card(posts)!;
    expect(c.name).toBe('Codex');
    expect(c.name).not.toBe('gui-1');
  });

  it('does the same when the folder is a bare UUID', () => {
    // Codex writes scratch workspaces under .codex/visualizations/<date>/<uuid>.
    const posts = fire({
      hook_event_name: 'SessionStart', session_id: 'gui-2',
      cwd: '/Users/x/.codex/visualizations/2026/10/02/01a0fd9d-47fd-7602-82b0-31491467be57',
    });
    expect(card(posts)!.name).toBe('Codex');
  });

  it('still lets a real folder claim the card afterwards', () => {
    // The placeholder is not pinned, so the first event that does know where it
    // is gets to name the session. The rename pinning prevents is between two
    // real directories, not from a stand-in to the real thing.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-pin-'));
    const env = { TMPDIR: tmp, AGSTATUS_STATE_DIR: tmp };
    expect(card(fire({ hook_event_name: 'SessionStart', session_id: 'gui-3', cwd: '/' }, env))!.name)
      .toBe('Codex');
    fs.writeFileSync(capturePath, '');
    expect(card(fire({ hook_event_name: 'Stop', session_id: 'gui-3', cwd: '/Users/x/my-repo' }, env))!.name)
      .toBe('my-repo');
  });

  it('leaves a real folder name alone', () => {
    const posts = fire({ hook_event_name: 'SessionStart', session_id: 'ok-1', cwd: '/Users/x/perf-ads' });
    expect(card(posts)!.name).toBe('perf-ads');
  });
});

describe('Claude Code Notification is unaffected', () => {
  it('still means blocked, with no rollout log anywhere', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-tmp-'));
    execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        hook_event_name: 'Notification', session_id: 'cc-1', cwd: '/tmp/demo-project',
        message: 'Claude needs your permission to use Bash',
      }),
      env: { ...process.env, CLAUDE_STATUS_URL: base, AGSTATUS_SOURCE: 'claude', TMPDIR: tmp, AGSTATUS_STATE_DIR: tmp, AGSTATUS_USAGE: 'off' },
      timeout: 10_000,
    });
    const posts = fs.readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as Post);
    expect(card(posts)?.status).toBe('blocked');
    expect(card(posts)?.message).toBe('Claude needs your permission to use Bash');
  });
});

/**
 * Codex Desktop starts ephemeral threads of its own all day. These include its
 * suggestion runs (a pass in the project folder, then a safety pass in `/`)
 * and commit and PR messages. Each one used to post as a card named after the
 * project, left at DONE beside the real session. Codex keeps no rollout for
 * them, so their payloads carry transcript_path as an explicit null.
 *
 * Two kinds of thread with no rollout stay on the board:
 *   - side conversations, which fork a session and say so at SessionStart;
 *   - any thread that asks a person for approval.
 */
describe('Codex threads with no rollout: helper runs stay off the board', () => {
  const RUN = '019a4c2e-5a5a-7000-8000-00000000a001';
  const ephemeral = (event: string, extra: Record<string, unknown> = {}) => ({
    hook_event_name: event,
    session_id: RUN,
    transcript_path: null,
    cwd: '/Users/x/jobsearch-saas',
    model: 'gpt-5.6-terra',
    ...extra,
  });
  const bash = { turn_id: 'turn-1', tool_name: 'Bash', tool_input: { command: ['bash', '-lc', 'rg TODO'] } };
  const ask = { turn_id: 'turn-1', tool_input: { description: 'May I run it?' } };

  /** One TMPDIR and state dir per test, with Focus on, so every file the hook could write lands in it. */
  function machine(): { dir: string; env: Record<string, string> } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-eph-'));
    const homeDir = path.join(dir, 'home');
    fs.mkdirSync(homeDir);
    fs.writeFileSync(path.join(homeDir, '.agstatus.json'), JSON.stringify({ focus: true }));
    fs.writeFileSync(path.join(dir, 'machine.json'),
      JSON.stringify({ machineId: '6f1c2b3a-4d5e-4f60-8a9b-0c1d2e3f4a5b', name: 'Test' }));
    return { dir, env: { HOME: homeDir, TMPDIR: dir, AGSTATUS_STATE_DIR: dir } };
  }
  /** What the hook left behind: the names map, scan state, and sessions/ host records. */
  const written = (dir: string) => fs.readdirSync(dir).filter((n) => n !== 'home' && n !== 'machine.json').sort();
  const fresh = (payload: Record<string, unknown>, env: Record<string, string>) => {
    fs.writeFileSync(capturePath, '');
    return fire(payload, env);
  };

  it('posts nothing and writes nothing, for every event a helper run fires', () => {
    const m = machine();
    const events = [
      ephemeral('SessionStart', { source: 'startup' }),
      ephemeral('PreToolUse', bash),
      ephemeral('PreToolUse', { turn_id: 'turn-1', tool_name: 'apply_patch', tool_input: {} }),
      ephemeral('Stop', { turn_id: 'turn-1', stop_hook_active: false }),
      // The safety pass that follows starts in `/`.
      ephemeral('SessionStart', { source: 'startup', cwd: '/', model: 'gpt-5.6-luna' }),
    ];
    for (const p of events) expect(fresh(p, m.env), p.hook_event_name).toEqual([]);
    expect(written(m.dir)).toEqual([]);
  });

  it('keeps only a SessionStart that says fork: every other source stays off', () => {
    // Codex also reports compact, clear and resume. None of them means a person
    // forked a conversation, so none of them keeps a thread with no rollout.
    const m = machine();
    for (const source of ['compact', 'clear', 'resume', undefined]) {
      const p = ephemeral('SessionStart', source === undefined ? {} : { source });
      expect(fresh(p, m.env), String(source)).toEqual([]);
      expect(fresh(ephemeral('PreToolUse', bash), m.env), `after ${source}`).toEqual([]);
    }
    expect(written(m.dir)).toEqual([]);
  });

  it("drops a helper run's sub-agent too, which brings along the run's session_id", () => {
    const m = machine();
    const sub = ephemeral('PreToolUse', { ...bash, agent_id: '019a4c2e-0000-7000-8000-00000000c009', agent_type: 'default' });
    expect(fresh(sub, m.env)).toEqual([]);
    expect(written(m.dir)).toEqual([]);
  });

  it('keeps a side conversation, which forks a session, for all of its events', () => {
    const m = machine();
    const SIDE = '019a4c2e-5a5a-7000-8000-00000000d001';
    const side = (event: string, extra: Record<string, unknown> = {}) =>
      ephemeral(event, { session_id: SIDE, model: 'gpt-6-astra', ...extra });
    expect(card(fresh(side('SessionStart', { source: 'fork' }), m.env))).toMatchObject({ session_id: SIDE, status: 'idle' });
    expect(card(fresh(side('PreToolUse', bash), m.env))?.status).toBe('coding');
    expect(card(fresh(side('PermissionRequest', ask), m.env)))
      .toMatchObject({ status: 'blocked', message: 'May I run it?' });
    // Its sub-agents land on its card, as a saved session's do.
    expect(card(fresh(side('PreToolUse', { ...bash, agent_id: '019a4c2e-0000-7000-8000-00000000c010' }), m.env)))
      .toMatchObject({ session_id: SIDE, status: 'coding' });
    expect(card(fresh(side('Stop', { turn_id: 'turn-1' }), m.env))?.status).toBe('done');
    // The mark belongs to that session alone: a helper run beside it still posts nothing.
    expect(fresh(ephemeral('PreToolUse', bash), m.env)).toEqual([]);
  });

  it('keeps a side conversation that started in `/`, with no folder to pin', () => {
    // A Desktop conversation can sit in `/`, where the name map pins no
    // folder; the mark has to hold on its own.
    const m = machine();
    const SIDE = '019a4c2e-5a5a-7000-8000-00000000d002';
    const side = (event: string, extra: Record<string, unknown> = {}) =>
      ephemeral(event, { session_id: SIDE, cwd: '/', model: 'gpt-6-astra', ...extra });
    expect(card(fresh(side('SessionStart', { source: 'fork' }), m.env))?.status).toBe('idle');
    expect(card(fresh(side('PermissionRequest', ask), m.env))?.status).toBe('blocked');
    expect(card(fresh(side('PreToolUse', bash), m.env))?.status).toBe('coding');
    expect(card(fresh(side('Stop', { turn_id: 'turn-1' }), m.env))?.status).toBe('done');
  });

  it('always posts a request for approval, and keeps that thread from then on', () => {
    // Not seen starting as a fork: an older Codex that says "startup" for one,
    // or the hook installed partway through. Its approval prompt must still
    // reach the board, and the rest of the thread with it.
    const m = machine();
    const LATE = '019a4c2e-5a5a-7000-8000-00000000e001';
    const late = (event: string, extra: Record<string, unknown> = {}) => ephemeral(event, { session_id: LATE, ...extra });
    expect(fresh(late('PreToolUse', bash), m.env)).toEqual([]);
    expect(card(fresh(late('PermissionRequest', ask), m.env)))
      .toMatchObject({ session_id: LATE, status: 'blocked', message: 'May I run it?' });
    expect(card(fresh(late('PreToolUse', bash), m.env))?.status).toBe('coding');
    expect(card(fresh(late('Stop', { turn_id: 'turn-1' }), m.env))?.status).toBe('done');
    expect(fresh(ephemeral('PreToolUse', bash), m.env)).toEqual([]);
  });

  it('still posts a root thread whose payload names its rollout, and writes its records', () => {
    const m = machine();
    const file = writeRollout('019a4c2e-0000-7000-8000-00000000b001', [turnContext('turn-1', 'user')]);
    const root = (event: string, extra: Record<string, unknown> = {}) =>
      ephemeral(event, { session_id: 'root-1', transcript_path: file, model: 'gpt-6-astra', ...extra });
    expect(card(fresh(root('SessionStart', { source: 'startup' }), m.env))?.status).toBe('idle');
    expect(card(fresh(root('PermissionRequest', { turn_id: 'turn-1' }), m.env))?.status).toBe('blocked');
    expect(written(m.dir)).toEqual(expect.arrayContaining(['sessions']));
    expect(written(m.dir).some((n) => n.startsWith('agstatus-names-'))).toBe(true);
  });

  it("leaves a saved session's sub-agent on its root's card", () => {
    // A sub-agent of a saved session names its own rollout, never null.
    const own = writeRollout('019a4c2e-0000-7000-8000-00000000c001', [turnContext('turn-1', 'user')]);
    const posts = fire(ephemeral('PreToolUse', {
      ...bash, session_id: 'root-2', transcript_path: own,
      agent_id: '019a4c2e-0000-7000-8000-00000000c001', agent_type: 'default',
    }));
    expect(card(posts)).toMatchObject({ session_id: 'root-2', status: 'coding' });
  });

  it('still posts a payload with no transcript_path at all, or an empty one', () => {
    // Only an explicit null means no rollout; a key that is missing or empty is
    // some other sender's payload, and it is posted as before.
    const p = { hook_event_name: 'SessionStart', session_id: 'old-1', cwd: '/Users/x/old-proj' };
    expect(card(fire(p))?.status).toBe('idle');
    fs.writeFileSync(capturePath, '');
    expect(card(fire({ ...p, hook_event_name: 'Stop', transcript_path: '' }))?.status).toBe('done');
  });

  it('never filters a Claude Code payload', () => {
    const posts = fire(
      { hook_event_name: 'SessionStart', session_id: 'cc-1', transcript_path: null },
      { AGSTATUS_SOURCE: 'claude', AGSTATUS_USAGE: 'off' },
    );
    expect(card(posts)?.status).toBe('idle');
  });
});
