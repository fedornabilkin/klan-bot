import { setTimeout as delay } from 'node:timers/promises';
import type { BotConfig } from './config.js';
import { getBotIdentity, telegram, type BotIdentity } from './telegram.js';

type TelegramCommand = { id: string; method: string; payload: Record<string, unknown> };
type CommandResult = { ok: false } | { ok: true; result?: { status: string; is_member?: boolean } | { message_id: number } };
type LoginButton = { text: string; callback_data: string };

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function loginKeyboard(markup: unknown): LoginButton[][] | undefined {
  const rows = (markup as { inline_keyboard?: unknown } | undefined)?.inline_keyboard;
  if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0]) || rows[0].length !== 2) return undefined;
  const buttons = rows[0] as Partial<LoginButton>[];
  if (buttons.some(button => !button || typeof button.text !== 'string' || button.text.length < 1 || button.text.length > 64
    || typeof button.callback_data !== 'string' || !/^(ok|no):[a-f0-9]{48}$/.test(button.callback_data))) return undefined;
  return [buttons.map(({ text, callback_data }) => ({ text: text!, callback_data: callback_data! }))];
}

export async function runBotCommands(config: BotConfig, signal: AbortSignal, request = fetch, warn = console.warn): Promise<void> {
  async function api(path: 'commands' | 'command-result', payload: object, timeoutMs: number) {
    const response = await request(`${config.backendOrigin}/internal/telegram/${path}`, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.backendSecret}` },
      body: JSON.stringify(payload), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('API did not accept the bot command request.');
    }
    return response;
  }

  async function execute(command: TelegramCommand): Promise<CommandResult> {
    const { method, payload } = command;
    const vendorSignal = AbortSignal.any([signal, AbortSignal.timeout(9000)]);
    try {
      if (method === 'sendMessage' && positiveId(payload?.chat_id) && typeof payload.text === 'string'
        && payload.text.length > 0 && payload.text.length <= 4096) {
        const keyboard = loginKeyboard(payload.reply_markup);
        if (payload.reply_markup !== undefined && !keyboard) return { ok: false };
        const message = await telegram<{ message_id?: unknown }>(config.token, method, {
          chat_id: payload.chat_id, text: payload.text, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
        }, vendorSignal, request);
        if (keyboard) return positiveId(message?.message_id) ? { ok: true, result: { message_id: message.message_id } } : { ok: false };
        return { ok: true };
      }
      if (method === 'editMessageText' && positiveId(payload?.chat_id) && positiveId(payload.message_id)
        && typeof payload.text === 'string' && payload.text.length > 0 && payload.text.length <= 4096) {
        await telegram(config.token, method, {
          chat_id: payload.chat_id, message_id: payload.message_id, text: payload.text, reply_markup: { inline_keyboard: [] },
        }, vendorSignal, request);
        return { ok: true };
      }
      if (method === 'answerCallbackQuery' && typeof payload?.callback_query_id === 'string'
        && payload.callback_query_id.length >= 1 && payload.callback_query_id.length <= 128
        && (payload.text === undefined || (typeof payload.text === 'string' && payload.text.length <= 200))) {
        await telegram(config.token, method, { callback_query_id: payload.callback_query_id, text: payload.text }, vendorSignal, request);
        return { ok: true };
      }
      if (method === 'getChatMember' && typeof payload?.chat_id === 'string' && /^-[1-9]\d{0,15}$/.test(payload.chat_id)
        && positiveId(payload.user_id)) {
        const member = await telegram<{ status?: unknown; is_member?: unknown }>(config.token, method,
          { chat_id: payload.chat_id, user_id: payload.user_id }, vendorSignal, request);
        if (typeof member?.status === 'string' && member.status.length <= 32) {
          return { ok: true, result: { status: member.status, is_member: typeof member.is_member === 'boolean' ? member.is_member : undefined } };
        }
      }
    } catch {
      // Return only failure, without Telegram responses or request details.
    }
    return { ok: false };
  }

  let identity: BotIdentity | undefined;
  let refreshAt = 0;
  while (!signal.aborted) {
    try {
      if (!identity || Date.now() >= refreshAt) {
        identity = await getBotIdentity(config.token, AbortSignal.any([signal, AbortSignal.timeout(12_000)]), request);
        refreshAt = Date.now() + 60_000;
      }
      const bot = identity;
      const response = await api('commands', identity, 30_000);
      const body = await response.json() as { data?: { commands?: TelegramCommand[] } } | null;
      const batch = body?.data?.commands;
      if (!Array.isArray(batch) || batch.length > 16 || batch.some(command => !command || typeof command.id !== 'string'
        || !/^[a-f0-9-]{36}$/.test(command.id))) throw new Error('Invalid command response.');
      await Promise.all(batch.map(async command => {
        const result = await execute(command);
        await api('command-result', { botId: bot.id, id: command.id, response: result }, 10_000);
      }));
    } catch {
      if (signal.aborted) return;
      warn('Telegram bot could not exchange commands with the API; retrying.');
      try { await delay(5000, undefined, { signal }); } catch { if (signal.aborted) return; throw new Error('Bot retry timer failed.'); }
    }
  }
}
