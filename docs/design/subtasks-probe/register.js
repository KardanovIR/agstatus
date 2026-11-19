#!/usr/bin/env node
// Writes a Claude Code settings file that runs log-hook.js on every hook event,
// matched to every tool where the event takes a matcher: the registration the
// 2026-10-27 probes ran with, rebuilt from that session's transcript.
//
//   node register.js <settings.json>
const fs = require('fs');
const path = require('path');

const target = process.argv[2];
if (!target) {
  console.error('usage: node register.js <settings.json>');
  process.exit(2);
}
const logger = path.join(__dirname, 'log-hook.js');
const events = ['SessionStart', 'UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse', 'PermissionRequest',
  'PermissionDenied', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Notification', 'MessageDisplay',
  'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'Stop', 'StopFailure', 'TeammateIdle',
  'InstructionsLoaded', 'ConfigChange', 'CwdChanged', 'DirectoryAdded', 'PreCompact', 'PostCompact',
  'PreModelSwitch', 'PostModelSwitch', 'Elicitation', 'ElicitationResult', 'SessionEnd', 'Setup'];
const matcherEvents = new Set(['PreToolUse', 'PermissionRequest', 'PermissionDenied', 'PostToolUse',
  'PostToolUseFailure', 'Notification', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact',
  'SessionStart', 'SessionEnd', 'ConfigChange', 'InstructionsLoaded', 'Elicitation', 'ElicitationResult',
  'StopFailure', 'UserPromptExpansion', 'MessageDisplay']);
const hooks = {};
for (const e of events) {
  const entry = { hooks: [{ type: 'command', command: `node ${JSON.stringify(logger)} ${e}` }] };
  if (matcherEvents.has(e)) entry.matcher = '*';
  hooks[e] = [entry];
}
fs.writeFileSync(target, `${JSON.stringify({ hooks }, null, 2)}\n`);
console.log(`${target}: ${events.length} events, each running ${logger}`);
