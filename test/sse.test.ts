import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import type { Express } from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { makeApp, webhookBody, sleep } from './helpers';
import type { Store } from '../src/store';
import { WIRE_SUBTASKS_MAX_BYTES } from '../src/subtasks';

// supertest does not handle long-lived streams well, so SSE tests run the app
// on a real ephemeral port and use native fetch with AbortControllers.

function listen(app: Express): Promise<{ srv: Server; base: string }> {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      resolve({ srv, base: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(srv: Server): Promise<void> {
  return new Promise((resolve) => {
    // Node >= 18.2: drop any lingering keep-alive sockets so close() completes.
    (srv as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    srv.close(() => resolve());
  });
}

async function createWorkspaceHttp(base: string): Promise<string> {
  const res = await fetch(`${base}/api/workspaces`, { method: 'POST' });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function postWebhook(base: string, token: string, body: unknown): Promise<void> {
  const res = await fetch(`${base}/w/${token}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  await res.text();
}

function connectSse(base: string, token: string, signal: AbortSignal): Promise<Response> {
  return fetch(`${base}/w/${token}/events`, {
    signal,
    headers: { accept: 'text/event-stream' },
  });
}

interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

/** Accumulate stream chunks until `needle` appears; fail fast on timeout/EOF. */
async function waitForChunk(reader: ChunkReader, needle: string, timeoutMs = 4000): Promise<string> {
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;

  while (!buf.includes(needle)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`timed out waiting for ${JSON.stringify(needle)}; received: ${JSON.stringify(buf)}`);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out waiting for ${JSON.stringify(needle)}; received: ${JSON.stringify(buf)}`)),
            remaining,
          );
        }),
      ]);
      if (result.done) {
        throw new Error(`stream ended before ${JSON.stringify(needle)}; received: ${JSON.stringify(buf)}`);
      }
      buf += decoder.decode(result.value, { stream: true });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return buf;
}

describe('SSE (/w/:token/events)', () => {
  it('sends a snapshot on connect, then session events for webhook posts', async () => {
    const { app } = makeApp();
    const { srv, base } = await listen(app);
    const ac = new AbortController();

    try {
      const token = await createWorkspaceHttp(base);
      await postWebhook(base, token, webhookBody('pre-1', { name: 'Existing' }));

      const res = await connectSse(base, token, ac.signal);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
      if (!res.body) throw new Error('SSE response has no body stream');
      const reader = res.body.getReader();

      // Initial snapshot must include the previously-posted session
      const snapshot = await waitForChunk(reader, 'event: snapshot');
      expect(snapshot).toContain('pre-1');

      // A webhook upsert while connected produces a session event
      await postWebhook(base, token, webhookBody('live-2', { status: 'testing' }));
      const sessionEvt = await waitForChunk(reader, 'event: session');
      expect(sessionEvt).toContain('live-2');
    } finally {
      ac.abort();
      await closeServer(srv);
    }
  });

  it('allows 10 concurrent connections per workspace; the 11th gets 429', async () => {
    // rateLimit: true so the test holds whether the implementation treats the
    // SSE cap as an always-on structural cap or as part of rate limiting.
    const { app } = makeApp({ rateLimit: true });
    const { srv, base } = await listen(app);
    const controllers: AbortController[] = [];

    try {
      const token = await createWorkspaceHttp(base);

      for (let i = 1; i <= 10; i++) {
        const ac = new AbortController();
        controllers.push(ac);
        const res = await connectSse(base, token, ac.signal);
        expect(res.status, `SSE connection #${i}`).toBe(200);
      }

      const ac11 = new AbortController();
      controllers.push(ac11);
      const res11 = await connectSse(base, token, ac11.signal);
      expect(res11.status).toBe(429);
      await res11.text().catch(() => '');
    } finally {
      for (const ac of controllers) ac.abort();
      await closeServer(srv);
    }
  });

  it('DELETE /w/:token ends the workspace\'s SSE streams', async () => {
    const { app } = makeApp();
    const { srv, base } = await listen(app);
    const ac = new AbortController();

    try {
      const token = await createWorkspaceHttp(base);
      const res = await connectSse(base, token, ac.signal);
      expect(res.status).toBe(200);
      if (!res.body) throw new Error('SSE response has no body stream');
      const reader = res.body.getReader();
      await waitForChunk(reader, 'event: snapshot');

      const del = await fetch(`${base}/w/${token}`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      await del.text();

      // The stream should terminate (done) shortly after workspace deletion.
      const deadline = Date.now() + 4000;
      let ended = false;
      while (Date.now() < deadline) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            // An abrupt socket teardown rejects read(); treat that as ended too.
            reader.read().catch(() => ({ done: true as const, value: undefined })),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('stream still open after workspace deletion')), deadline - Date.now());
            }),
          ]);
          if (result.done) {
            ended = true;
            break;
          }
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      expect(ended).toBe(true);
    } finally {
      ac.abort();
      await closeServer(srv);
    }
  });
});

// ---- subtasks on the stream ---------------------------------------------------

const sha256 = (v: string): string => crypto.createHash('sha256').update(v).digest('hex');
const agentKey = (seed: string): string => sha256(seed).slice(0, 24);

/** An open stream that keeps a running count of the bytes it has received. */
async function countedStream(url: string, headers: Record<string, string>, signal: AbortSignal) {
  const res = await fetch(url, { signal, headers: { accept: 'text/event-stream', ...headers } });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const stream = { bytes: 0, text: '' };
  void (async () => {
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (r.done) return;
      stream.bytes += r.value.byteLength;
      stream.text += decoder.decode(r.value, { stream: true });
    }
  })();
  return stream;
}

async function until(fn: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

// Text at every bound, in characters that take three bytes in UTF-8.
const MAX_TEXT = {
  name: '名'.repeat(120),
  message: '息'.repeat(300),
  project: '项'.repeat(120),
  label: '标'.repeat(64),
  activity: '动'.repeat(80),
};
// The longest slug and kind a host can have.
const MAX_HOST = {
  machine: { id: 'ab'.repeat(16), name: '机'.repeat(32) },
  app: { slug: 'windows-terminal' as const, name: '应'.repeat(32), kind: 'desktop-app' as const },
};
// The longest source and session id a post may name: ^[a-z][a-z0-9_-]{0,23}$
// and ^[A-Za-z0-9._:-]{1,128}$.
const MAX_SOURCE = 'x'.repeat(24);
const maxId = (seed: string): string => seed.padEnd(128, '.');

/**
 * What a session frame carries besides its subtasks, at most. A card with every
 * other field at its bound (the above, and homeProject as long as project)
 * frames to 2,639 bytes of it in 1.7.0, coding as here, and 2,641 planning, the
 * longest status; homeProject alone is 377 of those. A token total would add
 * 26 bytes, but only to an id of at most 64 characters, 64 bytes shorter.
 */
const CARD_BESIDES_SUBTASKS_MAX_BYTES = 2688;

/** One card as large as the caps let it be: every field at its bound, `live` running rows and 8 failed ones. */
function maximalCard(store: Store, wsId: string, id: string, live: number): void {
  const { name, message, project, label, activity } = MAX_TEXT;
  store.upsertSession(wsId, { id, status: 'coding', name, message, project, source: MAX_SOURCE, host: MAX_HOST }, Infinity);
  const at = Date.now();
  for (let i = 0; i < 8; i++) {
    const agent = agentKey(`${id} failed ${i}`);
    store.upsertSession(wsId, { id, status: 'coding', agent: { id: agent, state: 'coding', label, activity, at } }, Infinity);
    store.upsertSession(wsId, { id, status: 'coding', agent: { id: agent, state: 'failed', label, activity, at: at + 1 } }, Infinity);
  }
  for (let i = 0; i < live; i++) {
    store.upsertSession(wsId, { id, status: 'coding', agent: { id: agentKey(`${id} live ${i}`), state: 'coding', label, activity, at } }, Infinity);
  }
}

describe('SSE: subtasks', () => {
  it('a session frame carries subtasks', async () => {
    const { app } = makeApp();
    const { srv, base } = await listen(app);
    const ac = new AbortController();
    try {
      const token = await createWorkspaceHttp(base);
      await postWebhook(base, token, webhookBody('sub-frame', { status: 'coding', message: 'Working' }));
      const res = await connectSse(base, token, ac.signal);
      const reader = res.body!.getReader();
      await waitForChunk(reader, 'event: snapshot');
      const id = agentKey('frame');
      await postWebhook(base, token, { session_id: 'sub-frame', status: 'coding', agent: { id, state: 'coding', label: 'review:hook', at: Date.now() } });
      const buf = await waitForChunk(reader, '"subtasks"');
      const data = buf.slice(buf.lastIndexOf('event: session')).split('\n')[1].slice('data: '.length);
      expect(JSON.parse(data).subtasks).toEqual({
        turnEnded: false, running: 1, blocked: 0, failed: 0, done: 0,
        items: [{ id, n: 1, label: 'review:hook', state: 'coding', activity: '' }],
      });
    } finally {
      ac.abort();
      await closeServer(srv);
    }
  });

  it('a snapshot of 50 maximal cards stays under the 1,000,000-byte stream cap', async () => {
    const { app, store } = makeApp();
    const { srv, base } = await listen(app);
    const ac = new AbortController();
    try {
      const token = await createWorkspaceHttp(base);
      const wsId = store.resolveToken(token)!;
      // The board's 256 live rows spread over the cards, and 8 failed rows on each.
      for (let i = 0; i < 50; i++) maximalCard(store, wsId, maxId(`card-${i}`), i < 6 ? 6 : 5);
      const cards = store.getSessions(wsId);
      expect(cards).toHaveLength(50);
      expect(cards.reduce((n, c) => n + (c.subtasks?.running ?? 0), 0)).toBe(256);
      for (const c of cards) expect(Buffer.byteLength(JSON.stringify(c.subtasks))).toBeLessThanOrEqual(WIRE_SUBTASKS_MAX_BYTES);

      const stream = await countedStream(`${base}/w/${token}/events`, {}, ac.signal);
      await until(() => stream.text.includes('event: machines'), 'the frame after the snapshot');
      const snapshot = stream.text.slice(stream.text.indexOf('event: snapshot'), stream.text.indexOf('event: machines'));
      expect(Buffer.byteLength(snapshot)).toBeLessThan(1_000_000);
      expect(JSON.parse(snapshot.split('\n')[1].slice('data: '.length))).toHaveLength(50);
    } finally {
      ac.abort();
      await closeServer(srv);
    }
  });

  it('one agent post to a maximal card writes at most 15 × (8,192 + 2,688) bytes to 10 viewers and 5 listeners', async () => {
    const { app, store } = makeApp();
    const { srv, base } = await listen(app);
    const ac = new AbortController();
    try {
      const token = await createWorkspaceHttp(base);
      const wsId = store.resolveToken(token)!;
      const big = maxId('big');
      maximalCard(store, wsId, big, 48);
      expect(store.getSession(wsId, big)!.subtasks!.items).toHaveLength(56);

      const streams = [];
      for (let i = 0; i < 10; i++) streams.push(await countedStream(`${base}/w/${token}/events`, {}, ac.signal));
      for (let i = 0; i < 5; i++) {
        const key = sha256(`listener ${i}`);
        streams.push(await countedStream(
          `${base}/w/${token}/events?listener=${sha256(key).slice(0, 32)}&name=Mac`,
          { authorization: `Bearer ${key}` },
          ac.signal,
        ));
      }
      await until(() => streams.every((s) => s.text.includes('event: snapshot')), 'every snapshot');
      await sleep(200); // the listeners' presence frames settle
      const before = streams.map((s) => s.bytes);

      await postWebhook(base, token, {
        session_id: big, status: 'coding',
        agent: { id: agentKey(`${big} live 0`), state: 'coding', activity: 'Something new', at: Date.now() + 10 },
      });
      await until(() => streams.every((s) => s.text.lastIndexOf('event: session') > -1), 'the frame on every stream');
      await sleep(400); // and anything a trailing frame would add
      const written = streams.map((s, i) => s.bytes - before[i]);
      for (const w of written) expect(w).toBeLessThanOrEqual(WIRE_SUBTASKS_MAX_BYTES + CARD_BESIDES_SUBTASKS_MAX_BYTES);
      expect(written.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(15 * (WIRE_SUBTASKS_MAX_BYTES + CARD_BESIDES_SUBTASKS_MAX_BYTES));
      expect(written.every((w) => w > 0)).toBe(true);
      // The frame's bytes besides its subtasks, which no total above can
      // catch while this card's subtasks stay under their 8,192-byte guard.
      // Close to the bound as well, so that the bound is the one tested.
      const text = streams[0].text;
      const tail = text.slice(text.lastIndexOf('event: session'));
      const frame = tail.slice(0, tail.indexOf('\n\n') + 2);
      const { subtasks } = JSON.parse(frame.split('\n')[1].slice('data: '.length));
      const besides = Buffer.byteLength(frame) - Buffer.byteLength(JSON.stringify(subtasks));
      expect(besides).toBeLessThanOrEqual(CARD_BESIDES_SUBTASKS_MAX_BYTES);
      expect(besides).toBeGreaterThan(CARD_BESIDES_SUBTASKS_MAX_BYTES - 64);
    } finally {
      ac.abort();
      await closeServer(srv);
    }
  });
});
