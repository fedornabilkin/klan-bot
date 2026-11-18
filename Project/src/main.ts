import 'dotenv/config';
import { readConfig } from './config.js';
import { fileOffsetStore } from './state.js';
import { createWorker } from './worker.js';

async function main() {
  const config = readConfig();
  if (process.argv.includes('--check-config')) {
    console.log('Klan bot configuration is valid. No network requests were made.');
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    console.log('Klan Telegram worker started.');
    await createWorker(config, fileOffsetStore(config.stateFile)).run(controller.signal);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
main().catch(error => {
  // Only our fixed config/state errors escape. No Telegram responses or request objects.
  console.error(error instanceof Error ? error.message : 'Klan bot could not start.');
  process.exitCode = 1;
});
