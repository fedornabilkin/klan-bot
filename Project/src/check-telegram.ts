import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import 'dotenv/config';
import { telegram, validateBotIdentity, type BotIdentity } from './telegram.js';

export interface TelegramCheck { name: string; ok: boolean; message: string }
type ReadMethod = 'getMe' | 'getWebhookInfo' | 'getChat' | 'getChatMember';
export type TelegramReadClient = <T>(method: ReadMethod, payload: object) => Promise<T>;
interface Chat { type: string }
interface Member { status: string }

function readOnlyClient(token: string): TelegramReadClient {
  return <T>(method: ReadMethod, payload: object) => telegram<T>(token, method, payload, AbortSignal.timeout(12_000));
}

/** Does not send messages, consume updates, change webhooks, create sessions or access PostgreSQL. */
export async function checkTelegramProduction(token: string, groups: string[], client?: TelegramReadClient): Promise<TelegramCheck[]> {
  const checks: TelegramCheck[] = [];
  const ready = /^[1-9][0-9]*:[A-Za-z0-9_-]{20,}$/.test(token)
    && groups.every(group => /^-[1-9][0-9]*$/.test(group) && Number.isSafeInteger(Number(group)));
  checks.push({ name: 'configuration', ok: ready, message: ready
    ? 'Формат токена и переданных ID групп корректен.'
    : 'Проверьте формат токена и переданных ID групп.' });
  if (!ready) return checks;
  const request = client ?? readOnlyClient(token);
  let bot: BotIdentity;
  try {
    bot = validateBotIdentity(token, await request<unknown>('getMe', {}));
    checks.push({ name: 'bot', ok: true, message: `Telegram подтвердил бота @${bot.username}.` });
  } catch {
    checks.push({ name: 'bot', ok: false, message: 'Telegram не подтвердил бота. Проверьте токен и исходящий HTTPS-доступ.' });
    return checks;
  }
  try {
    const webhook = await request<{ url: string }>('getWebhookInfo', {});
    checks.push({ name: 'polling', ok: !webhook.url, message: webhook.url
      ? 'У бота настроен webhook. Для long polling его нужно отключить отдельно; эта проверка ничего не меняет.'
      : 'Webhook отсутствует: можно использовать один экземпляр long polling.' });
  } catch { checks.push({ name: 'polling', ok: false, message: 'Не удалось проверить настройку webhook.' }); }
  for (const [index, group] of groups.entries()) {
    try {
      const chat = await request<Chat>('getChat', { chat_id: group });
      const membership = await request<Member>('getChatMember', { chat_id: group, user_id: bot.id });
      const validType = ['group', 'supergroup'].includes(chat.type);
      const administrator = ['creator', 'administrator'].includes(membership.status);
      checks.push({ name: `group-${index + 1}`, ok: validType && administrator, message: !validType
        ? 'Указан не групповой чат. Проверьте TELEGRAM_GROUP_IDS.'
        : administrator ? 'Группа доступна; бот — администратор.'
          : 'Боту нужны права администратора группы для надёжной проверки членства других пользователей.' });
    } catch { checks.push({ name: `group-${index + 1}`, ok: false, message: 'Группа недоступна боту. Проверьте числовой ID и участие бота.' }); }
  }
  return checks;
}

async function main() {
  try {
    const groups = (process.env.TELEGRAM_GROUP_IDS ?? '').split(',').map(group => group.trim()).filter(Boolean);
    const checks = await checkTelegramProduction(process.env.TELEGRAM_BOT_TOKEN?.trim() ?? '', [...new Set(groups)]);
    for (const check of checks) console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.message}`);
    if (checks.some(check => !check.ok)) process.exitCode = 1;
    else console.log('Предварительные проверки пройдены. Проверьте вход в браузере.');
  } catch (error) {
    // Config errors have fixed messages and never embed credential values.
    console.error(error instanceof Error ? error.message : 'Не удалось проверить конфигурацию Telegram.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
