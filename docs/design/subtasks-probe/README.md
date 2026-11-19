# Subtasks probes

The tools the 1.7.0 spec's probes, P1–P9 in
[Appendix A](../subtasks.md#appendix-a-unknowns-and-the-probes-that-settle-them),
run with. They were rebuilt on 2026-11-07 from the transcript of the session
that wrote them on 2026-10-27, after its scratchpad was cleared.

- `log-hook.js` appends one JSON line per hook event: the time, the event it
  was registered as, Claude's own environment variables (never one named like
  a token, key or secret), the payload, and what a hook could read from disk
  about the subagent at that instant. It writes to `$PROBE_LOG`, or to
  `agstatus-probe-events.jsonl` in the system's temporary folder, and prints
  nothing. `$PROBE_RUN` tags the lines of one run.
- `node register.js <settings.json>` writes a settings file that registers the
  logger for every hook event, with `*` for the events that take a matcher.

Each probe's setup is in Appendix A. Every probe spends real agent runs, which
count against the plan they run on.
