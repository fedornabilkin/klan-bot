import { resolve } from 'node:path';

export interface BotConfig { token: string; backendOrigin: string; backendSecret: string; stateFile: string }

export function readConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('TELEGRAM_BOT_TOKEN is missing or invalid.');
  const backendSecret = env.BOT_BACKEND_SECRET?.trim();
  if (!backendSecret || !/^[\x21-\x7e]{32,256}$/.test(backendSecret)) throw new Error('BOT_BACKEND_SECRET must contain 32 to 256 non-space ASCII characters.');
  const backendOrigin = env.BOT_BACKEND_URL || 'http://127.0.0.1:3001';
  let url: URL;
  try { url = new URL(backendOrigin); } catch { throw new Error('BOT_BACKEND_URL must be an HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== backendOrigin || url.username || url.password) throw new Error('BOT_BACKEND_URL must contain only scheme and host.');
  const stateFile = env.BOT_STATE_FILE?.trim();
  if (!stateFile) throw new Error('BOT_STATE_FILE is required; use a persistent writable path.');
  return { token, backendOrigin, backendSecret, stateFile: resolve(stateFile) };
}
