import { setTimeout as delay } from 'node:timers/promises';
import type { BotConfig } from './config.js';
import type { OffsetStore } from './state.js';
import { telegram } from './telegram.js';

export interface TelegramUpdate { update_id: number; [field: string]: unknown }
export interface WorkerDependencies {
  fetch?: typeof fetch;
  wait?: (signal: AbortSignal) => Promise<void>;
  warn?: (message: string) => void;
}

export function createWorker(config: BotConfig, store: OffsetStore, dependencies: WorkerDependencies = {}) {
  const request = dependencies.fetch ?? fetch;
  const warn = dependencies.warn ?? console.warn;
  const wait = dependencies.wait ?? (signal => delay(5000, undefined, { signal }));

  async function poll(offset: number, signal: AbortSignal): Promise<TelegramUpdate[]> {
    try {
      const result = await telegram<unknown>(config.token, 'getUpdates', { offset, timeout: 25, limit: 100, allowed_updates: ['message', 'callback_query'] },
        AbortSignal.any([signal, AbortSignal.timeout(35_000)]), request);
      if (!Array.isArray(result) || result.length > 100) throw new Error();
      const updates = result as TelegramUpdate[];
      let last = offset - 1;
      for (const update of updates) {
        if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0 || update.update_id <= last || update.update_id === Number.MAX_SAFE_INTEGER) throw new Error();
        last = update.update_id;
      }
      return updates;
    } catch { throw new Error('Telegram polling unavailable.'); }
  }

  async function deliver(update: TelegramUpdate, signal: AbortSignal) {
    try {
      const response = await request(`${config.backendOrigin}/internal/telegram/updates`, {
        method: 'POST', redirect: 'error', headers: {
          'content-type': 'application/json', authorization: `Bearer ${config.backendSecret}`,
          'x-klan-telegram-bot-id': config.token.split(':', 1)[0]!,
        },
        body: JSON.stringify(update), signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
      });
      const body = await response.json() as { data?: { accepted?: boolean } };
      if (!response.ok || body.data?.accepted !== true) throw new Error();
    } catch { throw new Error('API did not accept the Telegram update.'); }
  }

  async function run(signal: AbortSignal): Promise<void> {
    let offset = await store.load();
    while (!signal.aborted) {
      try {
        for (const update of await poll(offset, signal)) {
          if (signal.aborted) return;
          await deliver(update, signal);
          const next = update.update_id + 1;
          await store.save(next);
          offset = next;
        }
      } catch {
        if (signal.aborted) return;
        // Vendor errors can contain tokens, URLs and message bodies. Never log them.
        warn('Telegram delivery is unavailable; retrying without advancing the unconfirmed offset.');
        try { await wait(signal); } catch { if (signal.aborted) return; throw new Error('Bot retry timer failed.'); }
      }
    }
  }
  return { run };
}
