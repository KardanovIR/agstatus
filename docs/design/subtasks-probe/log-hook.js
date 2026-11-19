#!/usr/bin/env node
// Appends {ts, registered_as, env-subset, payload, snap} as one JSON line. Prints nothing.
// The 1.7.0 subtasks probes' logger (docs/design/subtasks.md, Appendix A), rebuilt
// from the transcript of the session that wrote it on 2026-10-27; only the default
// log path is new, the old one being a cleared scratchpad.
// snap = what a hook could read from disk at this instant about the subagent (meta.json, first transcript line).
const fs = require('fs');
const path = require('path');
const out = process.env.PROBE_LOG || path.join(require('os').tmpdir(), 'agstatus-probe-events.jsonl');
const ev = process.argv[2] || '?';
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (buf += c));
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(buf); } catch { payload = { _raw: buf }; }
  const env = {};
  for (const k of Object.keys(process.env)) if (/^CLAUDE|^AGENT/.test(k) && !/TOKEN|KEY|SECRET/.test(k)) env[k] = process.env[k];
  let snap;
  try {
    if (payload.agent_id && payload.transcript_path && payload.session_id) {
      const dir = path.join(path.dirname(payload.transcript_path), payload.session_id, 'subagents');
      const base = path.join(dir, 'agent-' + payload.agent_id);
      snap = { dir_listing: fs.existsSync(dir) ? fs.readdirSync(dir) : null };
      
      // workflow agents live one level deeper: subagents/workflows/<runId>/
      try {
        const wdir = path.join(dir, 'workflows');
        if (fs.existsSync(wdir)) for (const run of fs.readdirSync(wdir)) {
          const rd = path.join(wdir, run);
          const m = path.join(rd, 'agent-' + payload.agent_id + '.meta.json');
          if (fs.existsSync(m)) { snap.wf_run = run; try { snap.wf_meta = JSON.parse(fs.readFileSync(m, 'utf8')); } catch (e) { snap.wf_meta_err = String(e); } }
          const j = path.join(rd, 'journal.jsonl');
          if (fs.existsSync(j)) { const hit = fs.readFileSync(j, 'utf8').split('\n').filter((x) => x.includes(payload.agent_id)); if (hit.length) { snap.wf_run = run; snap.wf_journal = hit.map((x) => { try { const o = JSON.parse(x); if (o.result !== undefined) o.result = '<omitted>'; return o; } catch { return x; } }); } }
        }
      } catch (e) { snap.wf_err = String(e); }
      try { snap.meta = JSON.parse(fs.readFileSync(base + '.meta.json', 'utf8')); } catch (e) { snap.meta_err = e.code || String(e); }
      try { const first = fs.readFileSync(base + '.jsonl', 'utf8').split('\n')[0]; const j = JSON.parse(first); snap.first_line = { type: j.type, isSidechain: j.isSidechain, agentId: j.agentId, parentUuid: j.parentUuid, promptId: j.promptId, content: typeof j.message?.content === 'string' ? j.message.content.slice(0, 200) : j.message?.content }; } catch (e) { snap.jsonl_err = e.code || String(e); }
    }
  } catch (e) { snap = { err: String(e) }; }
  const line = JSON.stringify({ ts: new Date().toISOString(), t_ms: Date.now(), ppid: process.ppid, registered_as: ev, run: process.env.PROBE_RUN || '', env, payload, snap });
  fs.appendFileSync(out, line + '\n');
  process.exit(0);
});
