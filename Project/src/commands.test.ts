import assert from 'node:assert/strict';
import test from 'node:test';
import { runBotCommands } from './commands.js';
import type { BotConfig } from './config.js';

const config: BotConfig = {
  token: '123456:unit-test-token-not-real', backendOrigin: 'http://127.0.0.1:3001',
  backendSecret: 'unit-test-service-secret'.repeat(3), stateFile: '/unused',
};

test('worker discovers its username, registers and executes only supported Telegram commands', { timeout: 4000 }, async () => {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]);
  const vendorCalls: string[] = [];
  const apiCalls: { route: string; payload: Record<string, unknown>; headers: Headers }[] = [];
  const warnings: string[] = [];
  const commands = [
    { id: 'e5eb1371-48c5-4502-9169-019d51195ea2', method: 'getChatMember', payload: { chat_id: '-1001', user_id: 1234 } },
    { id: '0e6042fb-61ea-4119-99d4-d56bbbcfc207', method: 'sendMessage', payload: { chat_id: 1234, text: 'Test' } },
    { id: '12d1bec0-110c-4ef0-ba29-dd8aacfe2e6a', method: 'getUpdates', payload: {} },
  ];
  const request: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    const action = url.pathname.split('/').at(-1)!;
    if (url.origin === 'https://api.telegram.org') {
      vendorCalls.push(action);
      if (action === 'getMe') return Response.json({ ok: true, result: { id: 123456, is_bot: true, username: 'inferred_test_bot' } });
      if (action === 'getChatMember') return Response.json({ ok: true, result: { status: 'restricted', is_member: true, user: { name: 'private' } } });
      return Response.json({ ok: true, result: { text: 'private' } });
    }
    apiCalls.push({ route: action, payload: JSON.parse(String(options?.body)), headers: new Headers(options?.headers) });
    if (action === 'commands') return Response.json({ data: { commands } });
    if (apiCalls.length === 4) controller.abort();
    return new Response(null, { status: 204 });
  };
  await runBotCommands(config, signal, request, message => warnings.push(message));
  assert.deepEqual(vendorCalls, ['getMe', 'getChatMember', 'sendMessage']);
  assert.deepEqual(apiCalls[0]?.payload, { id: 123456, username: 'inferred_test_bot' });
  for (const call of apiCalls) assert.equal(call.headers.get('authorization'), `Bearer ${config.backendSecret}`);
  const results = new Map(apiCalls.slice(1).map(call => [call.payload.id, call.payload.response]));
  assert.deepEqual(results.get(commands[0]!.id), { ok: true, result: { status: 'restricted', is_member: true } });
  assert.deepEqual(results.get(commands[1]!.id), { ok: true });
  assert.deepEqual(results.get(commands[2]!.id), { ok: false });
  assert.deepEqual(warnings, []);
});
