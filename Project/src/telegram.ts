export type TelegramMethod = 'getMe' | 'getUpdates' | 'getWebhookInfo' | 'getChat' | 'getChatMember' | 'sendMessage';
export type BotIdentity = { id: number; username: string };

export async function telegram<T>(
  token: string, method: TelegramMethod, payload: object, signal: AbortSignal, request = fetch,
): Promise<T> {
  try {
    const response = await request(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
      body: JSON.stringify(payload), signal,
    });
    const body = await response.json() as { ok?: boolean; result?: T };
    if (!response.ok || body.ok !== true || body.result === undefined) throw new Error();
    return body.result;
  } catch { throw new Error('Telegram API request failed.'); }
}

export async function getBotIdentity(token: string, signal: AbortSignal, request = fetch): Promise<BotIdentity> {
  return validateBotIdentity(token, await telegram<unknown>(token, 'getMe', {}, signal, request));
}

export function validateBotIdentity(token: string, value: unknown): BotIdentity {
  const bot = value as Partial<BotIdentity> & { is_bot?: boolean };
  if (bot?.is_bot !== true || typeof bot.id !== 'number' || !Number.isSafeInteger(bot.id) || bot.id <= 0
    || String(bot.id) !== token.split(':', 1)[0] || typeof bot.username !== 'string' || !/^[A-Za-z0-9_]{5,32}$/.test(bot.username)) {
    throw new Error('Telegram did not confirm the bot identity.');
  }
  return { id: bot.id, username: bot.username };
}
