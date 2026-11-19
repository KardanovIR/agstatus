/*
 * The cards whose markup cards-1.6.5.html pins: every branch cardInner and
 * cardMeta take for a session without subagents. The file was written by the
 * 1.6.5 board (master 2d8fc12, the last before subagents) from exactly these
 * sessions, at PIN_TIME, with machine m1 online — so the board must still
 * draw them byte for byte, whatever 1.7.0 added beside them. It was 1.6.3's
 * until 1.7.0 was replayed onto 1.6.5, whose cards gained their stale form.
 * 1.7.0's project sections change each card's meta line and nothing else on
 * it (the agent's mark for the chip, and no "in <folder>" for a session that
 * has not moved), which subtasks-web.test.ts spells out against this file.
 */
export const PIN_TIME = Date.UTC(2026, 9, 28, 12, 0, 0);

const HOST = {
  machine: { id: 'm1', name: 'Studio' },
  app: { slug: 'agterm', name: 'agterm', kind: 'terminal' },
};

export const pinnedSessions = () => [
  {
    id: 's1', name: 'Fix the parser', status: 'coding', message: 'editing src/app.ts',
    project: 'agstatus', source: 'claude', host: HOST, tokens: 1_100_000,
    createdAt: PIN_TIME - 3_600_000, updatedAt: PIN_TIME - 2_000,
  },
  {
    id: 'host:1.2-3_4', name: 'landing', status: 'blocked', message: 'May I push to master?',
    project: 'landing', source: 'codex', host: null,
    createdAt: PIN_TIME - 3_600_000, updatedAt: PIN_TIME - 90_000,
  },
  {
    id: 's3', name: 'Release notes for 1.6.3', status: 'done', message: 'Turn finished',
    project: 'claude-status', source: 'claude', host: HOST, tokens: 220_500,
    createdAt: PIN_TIME - 7_200_000, updatedAt: PIN_TIME - 1_860_000,
  },
  {
    id: 's4', name: 'scratch', status: 'idle', message: '',
    project: '', source: 'claude', host: null,
    createdAt: PIN_TIME - 7_200_000, updatedAt: PIN_TIME - 3_000_000,
  },
  {
    id: 's5', name: 'Escape <b>"this"</b> & \'that\'', status: 'planning',
    message: 'Searching: <script>alert(1)</script>',
    project: 'a&b', source: 'codex', host: HOST,
    createdAt: PIN_TIME - 7_200_000, updatedAt: PIN_TIME - 4_000_000,
  },
  {
    id: 's6', name: 'Plan the push-token migration', status: 'testing', message: 'npm test -- store',
    project: 'acme-ios', source: 'claude', host: { machine: { id: 'm2', name: 'Mac' } }, tokens: 88_100,
    createdAt: PIN_TIME - 7_200_000, updatedAt: PIN_TIME - 5_000_000,
  },
  {
    id: 'rogue', name: 'From the future', status: 'rogue status',
    message: 'a status this client has never heard of',
    project: 'x', source: 'claude', host: null,
    createdAt: PIN_TIME - 7_200_000, updatedAt: PIN_TIME - 6_000_000,
  },
];
