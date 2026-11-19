import 'dotenv/config';
import { readConfig } from './config.js';
import { fileOffsetStore } from './state.js';
import { createWorker } from './worker.js';
import { runBotCommands } from './commands.js';

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
  const tasks = [
    createWorker(config, fileOffsetStore(config.stateFile)).run(controller.signal),
    runBotCommands(config, controller.signal),
  ];
  try {
    console.log('Klan Telegram worker started.');
    await Promise.all(tasks);
  } finally {
    controller.abort();
    await Promise.allSettled(tasks);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
main().catch(error => {
  // Only our fixed config/state errors escape. No Telegram responses or request objects.
  console.error(error instanceof Error ? error.message : 'Klan bot could not start.');
  process.exitCode = 1;
});
