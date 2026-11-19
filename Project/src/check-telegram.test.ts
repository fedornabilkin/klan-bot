import assert from 'node:assert/strict';
import test from 'node:test';
import { checkTelegramProduction, type TelegramReadClient } from './check-telegram.js';

const token = '123:synthetic-token-for-tests';
const groups = ['-1001'];
function client(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const results: Record<string, unknown> = { getMe: { id: 123, is_bot: true, username: 'klan_test_bot' }, getWebhookInfo: { url: '' }, getChat: { type: 'supergroup' }, getChatMember: { status: 'administrator' }, ...overrides };
  const request: TelegramReadClient = async <T>(method: string) => { calls.push(method); if (!(method in results)) throw new Error('Unexpected method'); return results[method] as T; };
  return { calls, request };
}

test('Production preflight performs only read-only bot/group checks', async () => {
  const fake = client();
  const result = await checkTelegramProduction(token, groups, fake.request);
  assert.ok(result.every(check => check.ok));
  assert.deepEqual(fake.calls, ['getMe', 'getWebhookInfo', 'getChat', 'getChatMember']);
});

test('Account-only preflight checks the bot and polling without querying any group', async () => {
  const fake = client();
  const result = await checkTelegramProduction(token, [], fake.request);
  assert.ok(result.every(check => check.ok));
  assert.deepEqual(fake.calls, ['getMe', 'getWebhookInfo']);
});

test('Preflight rejects invalid tokens, mismatched identities, webhook and missing bot admin rights', async () => {
  const fake = client();
  assert.ok((await checkTelegramProduction('invalid', groups, fake.request)).some(check => !check.ok));
  assert.equal(fake.calls.length, 0);
  for (const overrides of [
    { getMe: { id: 321, is_bot: true, username: 'other_bot' } },
    { getWebhookInfo: { url: 'https://private.example/secret-webhook' } },
    { getChatMember: { status: 'member' } },
    { getChat: { type: 'channel' } },
  ]) {
    const result = await checkTelegramProduction(token, groups, client(overrides).request);
    assert.ok(result.some(check => !check.ok));
    assert.ok(!JSON.stringify(result).includes('secret-webhook'));
  }
});

test('Preflight never returns raw network errors that can contain credentials', async () => {
  const result = await checkTelegramProduction(token, groups, async () => { throw new Error('https://api.telegram.org/botSECRET/getMe'); });
  assert.ok(result.some(check => !check.ok));
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});
