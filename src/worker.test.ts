import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorker } from './worker.js';
import { readConfig, type BotConfig } from './config.js';
import { fileOffsetStore } from './state.js';

const config: BotConfig = { token: '123456:unit-test-token-not-real', backendOrigin: 'http://127.0.0.1:3001', backendSecret: 'unit-test-service-secret'.repeat(3), stateFile: '/unused' };

test('failed API delivery is retried and offset advances only after acknowledgement', async () => {
  const controller = new AbortController();
  const offsets: number[] = []; const delivered: number[] = []; const warnings: string[] = [];
  let saved = 10; let failures = 1;
  const worker = createWorker(config, { load: async () => saved, save: async next => { saved = next; if (next === 12) controller.abort(); } }, {
    wait: async () => undefined, warn: message => warnings.push(message),
    fetch: (async (input, options) => {
      const payload = JSON.parse(String(options?.body));
      if (String(input).includes('/getUpdates')) {
        offsets.push(payload.offset);
        return Response.json({ ok: true, result: [{ update_id: 10 }, { update_id: 11 }].filter(update => update.update_id >= payload.offset) });
      }
      assert.equal(String(input), `${config.backendOrigin}/internal/telegram/updates`);
      assert.equal((options?.headers as Record<string, string>).authorization, `Bearer ${config.backendSecret}`);
      assert.equal(options?.redirect, 'error');
      delivered.push(payload.update_id);
      if (failures-- > 0) throw new Error(`secret vendor error ${config.token}`);
      return Response.json({ data: { accepted: true } });
    }) as typeof fetch,
  });
  await worker.run(controller.signal);
  assert.deepEqual(offsets, [10, 10]);
  assert.deepEqual(delivered, [10, 10, 11]);
  assert.equal(saved, 12);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings.join('').includes(config.token));
});

test('an update remains pending if acknowledgement or state persistence fails', async () => {
  const controller = new AbortController(); let count = 0; let saved = 0; const polled: number[] = [];
  const worker = createWorker(config, { load: async () => 0, save: async offset => { if (++count === 1) throw new Error('disk unavailable'); saved = offset; controller.abort(); } }, {
    wait: async () => undefined, warn: () => undefined,
    fetch: (async (input, options) => {
      if (String(input).includes('/getUpdates')) { polled.push(JSON.parse(String(options?.body)).offset); return Response.json({ ok: true, result: [{ update_id: 7 }] }); }
      return Response.json({ data: { accepted: true } });
    }) as typeof fetch,
  });
  await worker.run(controller.signal);
  assert.deepEqual(polled, [0, 0]); assert.equal(saved, 8);
});

test('polling shutdown aborts cleanly without advancing the offset', async () => {
  const controller = new AbortController(); let saved = false;
  const worker = createWorker(config, { load: async () => 0, save: async () => { saved = true; } }, {
    warn: () => assert.fail('shutdown is not an outage'),
    fetch: (async () => { controller.abort(); throw new Error('abort'); }) as typeof fetch,
  });
  await worker.run(controller.signal); assert.equal(saved, false);
});

test('offset persists across instances and corrupt state is not silently reset', async t => {
  const directory = await mkdtemp(join(process.env.KLAN_TEST_TMPDIR || tmpdir(), 'klan-bot-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'offset.json'); const store = fileOffsetStore(file);
  assert.equal(await store.load(), 0); await store.save(42);
  assert.equal(await fileOffsetStore(file).load(), 42);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { offset: 42 });
  await writeFile(file, '{invalid'); await assert.rejects(store.load(), /invalid/);
});

test('configuration requires credentials and persistent state without exposing supplied values', () => {
  const env = { TELEGRAM_BOT_TOKEN: config.token, BOT_BACKEND_URL: config.backendOrigin, BOT_BACKEND_SECRET: config.backendSecret, BOT_STATE_FILE: '.local/offset.json' };
  assert.equal(readConfig(env).backendOrigin, config.backendOrigin);
  assert.throws(() => readConfig({ ...env, TELEGRAM_BOT_TOKEN: 'private-invalid-token' }), /^Error: TELEGRAM_BOT_TOKEN is missing or invalid\.$/);
  assert.throws(() => readConfig({ ...env, BOT_BACKEND_SECRET: 'short' }), /BOT_BACKEND_SECRET/);
  assert.throws(() => readConfig({ ...env, BOT_STATE_FILE: '' }), /BOT_STATE_FILE/);
  assert.throws(() => readConfig({ ...env, BOT_BACKEND_URL: 'https://example.org/path' }), /BOT_BACKEND_URL/);
});
