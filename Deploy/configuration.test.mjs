import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Compose renders configuration without a daemon, image pull or network request.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.DEPLOY_TEST_COMPOSE || 'docker';
const prefix = process.env.DEPLOY_TEST_COMPOSE ? [] : ['compose'];
const probe = spawnSync(executable, [...prefix, 'version', '--short'], { encoding: 'utf8' });
const unavailable = probe.status !== 0 ? 'Docker Compose CLI is unavailable' : false;

function render(context, runtime) {
  const temporary = mkdtempSync(join(tmpdir(), 'klan-bot-config-test-'));
  context.after(() => {
    assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep));
    rmSync(temporary, { recursive: true, force: true });
  });
  mkdirSync(join(temporary, 'Docker'));
  copyFileSync(join(repo, 'Docker/compose.production.yaml'), join(temporary, 'Docker/compose.production.yaml'));
  if (runtime !== null) writeFileSync(join(temporary, 'runtime.env'), runtime);
  return spawnSync(executable, [
    ...prefix, '--project-directory', join(temporary, 'Docker'),
    '-f', join(temporary, 'Docker/compose.production.yaml'), 'config', '--format', 'json',
  ], {
    cwd: temporary,
    env: { ...process.env, IMAGE_REF: `ghcr.io/example/klan-bot@sha256:${'a'.repeat(64)}` },
    encoding: 'utf8',
  });
}

for (const origin of ['http://api:3001', 'https://api.private.example.test']) {
  test(`production Compose preserves API origin ${origin} and literal raw secret`, { skip: unavailable }, (context) => {
    const secret = 'exact$"\'`#literal\\$(not-a-command)=value';
    const result = render(context, `TELEGRAM_BOT_TOKEN=123456:synthetic-token-only\nBOT_BACKEND_SECRET=${secret}\nBOT_BACKEND_URL=${origin}\n`);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const environment = JSON.parse(result.stdout).services.bot.environment;
    assert.equal(environment.BOT_BACKEND_URL, origin);
    // `compose config` escapes dollars for a reusable Compose document.
    assert.equal(environment.BOT_BACKEND_SECRET, secret.replaceAll('$', () => '$$'));
    assert.equal(environment.NODE_ENV, 'production');
    assert.equal(environment.BOT_STATE_FILE, '/var/lib/klan-bot/offset.json');
    assert.doesNotMatch(result.stderr, /synthetic-token-only|not-a-command/);
  });
}

test('production Compose requires the selected release configuration file', { skip: unavailable }, (context) => {
  const result = render(context, null);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime\.env/);
});
