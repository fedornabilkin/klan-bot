import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The real transport and server scripts run against disposable files and command doubles.
// No Docker daemon, SSH connection, registry, Telegram token or application database is used.
const deployDirectory = dirname(fileURLToPath(import.meta.url));
const bash = process.env.DEPLOY_TEST_BASH || (process.platform === 'win32'
  ? 'C:/Program Files/Git/bin/bash.exe'
  : 'bash');
const bashEnvironment = { ...process.env, MSYS: 'winsymlinks:lnk' };
const probe = spawnSync(bash, ['--version'], { env: bashEnvironment, encoding: 'utf8' });
const unavailable = probe.status !== 0
  ? 'Bash is unavailable; run on Linux or allow Git Bash to start on Windows'
  : false;
const oldId = `${'a'.repeat(40)}-1-1`;
const newId = `${'b'.repeat(40)}-2-1`;

function shellPath(value) {
  const absolute = resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32'
    ? absolute.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
    : absolute;
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o700 });
}

function harness(context, { previous = true, runtime = 'SYNTHETIC_CONFIGURATION=only\n', sharedRuntime } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'klan-deployment-test-'));
  context.after(() => {
    assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep));
    rmSync(temporary, { recursive: true, force: true });
  });
  const root = join(temporary, 'klan', 'bot');
  const bin = join(temporary, 'bin');
  const log = join(temporary, 'calls.log');
  const environment = {
    ...bashEnvironment,
    TEST_BIN: shellPath(bin),
    TEST_LOG: shellPath(log),
    FAIL_PREFLIGHT: '', FAIL_START: '', FAIL_VERIFY: '', FAIL_STOP: '', FAIL_PULL: '',
  };
  write(join(bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == 'compose version --short' ]]; then printf '2.30.0\\n'; exit 0; fi
if [[ "$1" == login ]]; then cat >/dev/null; printf 'docker:login\\n' >> "$TEST_LOG"; exit 0; fi
if [[ "$1" == pull ]]; then printf 'docker:pull\\n' >> "$TEST_LOG"; [[ "$FAIL_PULL" != yes ]]; exit; fi
if [[ "$*" == "image inspect --format {{.Id}} "* ]]; then printf '%s\\n' "\${!#}" | cut -d@ -f2; exit 0; fi
if [[ "$1 $2" == 'image ls' ]]; then
  for letter in c d e f; do
    hash=$(printf '%064d' 0 | tr 0 "$letter")
    echo "ghcr.io/fedornabilkin/klan-bot <none> sha256:$hash sha256:$hash"
  done
  echo 'another/app latest <none> sha256:${'a'.repeat(64)}'
  exit 0
fi
if [[ "$1 $2" == 'container ls' ]]; then
  if [[ "\${!#}" == 'ancestor=sha256:${'f'.repeat(64)}' ]]; then echo stopped; fi
  exit 0
fi
if [[ "$1 $2" == 'image rm' ]]; then echo "removed:$3" >> "$TEST_LOG"; exit 0; fi
if [[ "$1" == image && "$2" == inspect ]]; then exit 0; fi
if [[ "$1" == compose ]]; then printf 'docker:config\\n' >> "$TEST_LOG"; exit 0; fi
printf 'Unexpected mocked Docker command\\n' >&2; exit 98
`);
  for (const command of ['flock', 'curl']) write(join(bin, command), '#!/usr/bin/env bash\nexit 0\n');
  write(join(bin, 'ssh'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${CAPTURE_TRANSPORT:-}" == yes ]]; then
  if [[ "$*" == *'tar -xf'* ]]; then tar -xf - -C "$TEST_PAYLOAD"; fi
  if [[ "$*" == *'server-release.sh'* ]]; then cat >/dev/null; fi
  exit 0
fi
printf 'unexpected:ssh\\n' >> "$TEST_LOG"
exit 99
`);
  const service = `#!/usr/bin/env bash
record_hook() { printf '%s:%s\\n' "$1" "$(cat "$release_dir/fixture-name")" >> "$TEST_LOG"; }
service_preflight() { record_hook preflight; [[ "$FAIL_PREFLIGHT" != "$(cat "$release_dir/fixture-name")" ]]; }
service_start() { record_hook start; [[ "$FAIL_START" != "$(cat "$release_dir/fixture-name")" ]]; }
service_verify() { record_hook verify; [[ "$FAIL_VERIFY" != "$(cat "$release_dir/fixture-name")" ]]; }
service_stop() { record_hook stop; [[ "$FAIL_STOP" != "$(cat "$release_dir/fixture-name")" ]]; }
`;
  const server = readFileSync(join(deployDirectory, 'server-release.sh'), 'utf8')
    .replaceAll('/opt/klan/', `${shellPath(temporary)}/klan/`);
  for (const [id, label, digest] of [[oldId, 'old', 'c'], [newId, 'new', 'd']]) {
    const release = join(root, 'releases', id);
    write(join(release, 'Deploy', 'server-release.sh'), server);
    write(join(release, 'Deploy', 'service.sh'), service);
    write(join(release, 'Deploy', 'clean-images.sh'), readFileSync(join(deployDirectory, 'clean-images.sh')));
    write(join(release, 'Docker', 'compose.production.yaml'), 'services: {}\n');
    if (label === 'old' || runtime !== null) write(join(release, 'runtime.env'), label === 'old' ? 'OLD_CONFIGURATION=saved\n' : runtime);
    write(join(release, 'image-ref'), `ghcr.io/example/klan-bot@sha256:${digest.repeat(64)}\n`);
    write(join(release, 'fixture-name'), label);
  }
  if (sharedRuntime !== undefined) write(join(root, 'shared', 'runtime.env'), sharedRuntime);
  function command(script, args = [], extra = {}, input = '') {
    return spawnSync(bash, ['-c', 'export PATH="$TEST_BIN:$PATH"; exec bash "$@"', 'test', shellPath(script), ...args], {
      env: { ...environment, ...extra }, input, encoding: 'utf8', timeout: 15_000,
    });
  }
  function shell(code, args = []) {
    const result = spawnSync(bash, ['-c', code, 'test', ...args], {
      env: environment, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
  }
  function link(name, id) {
    shell('ln -s -- "$1" "$2"; test -L "$2"', [`releases/${id}`, shellPath(join(root, name))]);
  }
  if (previous) link('current', oldId);
  return {
    root,
    log: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [],
    hooks: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
      .filter((line) => /^(preflight|start|verify|stop):/.test(line)),
    current: () => shell('if test -L "$1"; then readlink "$1"; fi', [shellPath(join(root, 'current'))]),
    previous: () => shell('if test -L "$1"; then readlink "$1"; fi', [shellPath(join(root, 'previous'))]),
    link,
    command,
    runtime: () => readFileSync(join(root, 'releases', newId, 'runtime.env'), 'utf8'),
    sharedRuntime: () => readFileSync(join(root, 'shared', 'runtime.env'), 'utf8'),
    transport: (productionEnvironment) => {
      const payload = join(temporary, 'payload');
      mkdirSync(payload);
      const result = command(join(deployDirectory, 'deploy.sh'), [], {
        ...transportEnvironment, PRODUCTION_ENV: productionEnvironment,
        CAPTURE_TRANSPORT: 'yes', TEST_PAYLOAD: shellPath(payload),
      });
      return { result, payload };
    },
    deploy: (extra = {}) => command(join(root, 'releases', newId, 'Deploy', 'server-release.sh'), ['deploy', 'example'], extra, 'fake-short-lived-token\n'),
    rollback: (extra = {}) => command(join(root, 'releases', newId, 'Deploy', 'server-release.sh'), ['rollback'], extra),
  };
}

const transportEnvironment = {
  DEPLOY_HOST: 'server.example.test', DEPLOY_PORT: '22', DEPLOY_USER: 'deploy',
  DEPLOY_SSH_KEY: 'synthetic-key', DEPLOY_KNOWN_HOSTS: 'synthetic-host-key',
  PRODUCTION_ENV: 'EXAMPLE=value', KLAN_COMPONENT: 'bot',
  IMAGE_REF: `ghcr.io/example/klan-bot@sha256:${'c'.repeat(64)}`,
  GITHUB_SHA: 'b'.repeat(40), GITHUB_RUN_ID: '2', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_ACTOR: 'example', GHCR_TOKEN: 'synthetic-token',
};

for (const [setting, value, expected] of [
  ['DEPLOY_HOST', "host'; touch /tmp/forbidden", 'Invalid SSH host'],
  ['DEPLOY_PORT', '0', 'Invalid SSH port'],
  ['DEPLOY_PORT', '65536', 'Invalid SSH port'],
  ['DEPLOY_USER', 'user;command', 'Invalid SSH user'],
  ['KLAN_COMPONENT', '../backend', 'Invalid component'],
  ['IMAGE_REF', 'ghcr.io/example/klan-bot:latest', 'immutable Klan image digest'],
  ['IMAGE_REF', `ghcr.io/example/klan-frontend@sha256:${'c'.repeat(64)}`, 'immutable Klan image digest'],
  ['GITHUB_SHA', 'main', 'Invalid commit'],
  ['GITHUB_RUN_ID', '../2', 'Invalid run'],
  ['GITHUB_ACTOR', 'user;command', 'Invalid registry user'],
]) {
  test(`transport rejects ${setting}=${JSON.stringify(value)} before SSH`, { skip: unavailable }, (context) => {
    const fixture = harness(context);
    const result = fixture.command(join(deployDirectory, 'deploy.sh'), [], { ...transportEnvironment, [setting]: value });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(expected));
    assert.deepEqual(fixture.log(), []);
  });
}

test('successful deployment publishes current and retains the previous release', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const result = fixture.deploy();
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(fixture.current(), `releases/${newId}`);
  assert.equal(fixture.previous(), `releases/${oldId}`);
  assert.deepEqual(fixture.hooks(), ['preflight:new', 'start:new', 'verify:new']);
  assert.deepEqual(fixture.log().filter(line => line.startsWith('removed:')), [
    'removed:ghcr.io/fedornabilkin/klan-bot@sha256:' + 'e'.repeat(64),
  ]);
  assert.doesNotMatch(result.stdout + result.stderr, /fake-short-lived-token/);
});

for (const [failure, hooks] of [
  ['FAIL_PREFLIGHT', ['preflight:new']],
  ['FAIL_PULL', []],
]) {
  test(`${failure} keeps the current release running without attempting rollback`, { skip: unavailable }, (context) => {
    const fixture = harness(context);
    const result = fixture.deploy({ [failure]: failure === 'FAIL_PULL' ? 'yes' : 'new' });
    assert.notEqual(result.status, 0);
    assert.equal(fixture.current(), `releases/${oldId}`);
    assert.equal(fixture.previous(), '');
    assert.deepEqual(fixture.hooks(), hooks);
  });
}

for (const failure of ['FAIL_START', 'FAIL_VERIFY']) {
  test(`${failure} stops the failed service and restores the old release`, { skip: unavailable }, (context) => {
    const fixture = harness(context);
    const result = fixture.deploy({ [failure]: 'new' });
    assert.notEqual(result.status, 0);
    assert.equal(fixture.current(), `releases/${oldId}`);
    assert.equal(fixture.previous(), '');
    const expected = ['preflight:new', 'start:new'];
    if (failure === 'FAIL_VERIFY') expected.push('verify:new');
    assert.deepEqual(fixture.hooks(), [...expected, 'stop:new', 'start:old', 'verify:old']);
    assert.match(result.stderr, /Previous release restored/);
  });
}

test('a failed first deployment stops the service and does not publish current', { skip: unavailable }, (context) => {
  const fixture = harness(context, { previous: false });
  const result = fixture.deploy({ FAIL_VERIFY: 'new' });
  assert.notEqual(result.status, 0);
  assert.equal(fixture.current(), '');
  assert.equal(fixture.previous(), '');
  assert.deepEqual(fixture.hooks(), ['preflight:new', 'start:new', 'verify:new', 'stop:new']);
  assert.match(result.stderr, /First deployment failed; service stopped/);
  assert.ok(existsSync(join(fixture.root, 'releases', newId, 'runtime.env')));
});

test('failed rollback is reported and cannot turn a failed deployment into success', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const result = fixture.deploy({ FAIL_VERIFY: 'new', FAIL_START: 'old' });
  assert.notEqual(result.status, 0);
  assert.equal(fixture.current(), `releases/${oldId}`);
  assert.deepEqual(fixture.hooks(), ['preflight:new', 'start:new', 'verify:new', 'stop:new', 'start:old']);
  assert.match(result.stderr, /ROLLBACK FAILED/);
});

test('if the failed service cannot stop, rollback never starts a second worker', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const result = fixture.deploy({ FAIL_VERIFY: 'new', FAIL_STOP: 'new' });
  assert.notEqual(result.status, 0);
  assert.equal(fixture.current(), `releases/${oldId}`);
  assert.deepEqual(fixture.hooks(), ['preflight:new', 'start:new', 'verify:new', 'stop:new']);
  assert.match(result.stderr, /automatic rollback was not started/);
});

test('manual rollback uses the saved release and environment, then swaps current and previous', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  assert.equal(fixture.deploy().status, 0);
  const before = fixture.hooks().length;
  const result = fixture.rollback();
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(fixture.current(), `releases/${oldId}`);
  assert.equal(fixture.previous(), `releases/${newId}`);
  assert.deepEqual(fixture.hooks().slice(before), ['preflight:old', 'start:old', 'verify:old']);
  assert.equal(fixture.log().filter((entry) => entry === 'docker:login').length, 1);
  assert.equal(fixture.log().filter((entry) => entry === 'docker:pull').length, 1);
});

test('manual rollback without a saved previous release leaves the active service untouched', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const result = fixture.rollback();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No previous release/);
  assert.equal(fixture.current(), `releases/${oldId}`);
  assert.deepEqual(fixture.hooks(), []);
});

test('runtime configuration is treated as data rather than sourced shell code', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const marker = join(fixture.root, 'must-not-exist');
  write(join(fixture.root, 'releases', newId, 'runtime.env'), `EXAMPLE=$(touch '${shellPath(marker)}')\n`);
  const result = fixture.deploy();
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(existsSync(marker), false);
});

test('transport omits an empty optional GitHub override so the server can select its own configuration', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const { result, payload } = fixture.transport('');
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(existsSync(join(payload, 'runtime.env')), false);
});

test('transport preserves raw GitHub configuration without shell expansion or secret output', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const raw = 'TELEGRAM_BOT_TOKEN=123456:synthetic-token-only\r\nBOT_BACKEND_SECRET=exact$"\'`#value\\$(not-a-command)\r\n';
  const { result, payload } = fixture.transport(raw);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(readFileSync(join(payload, 'runtime.env'), 'utf8'), raw);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-token-only|not-a-command|synthetic-key|synthetic-token/);
});

test('a legacy two-value configuration receives the same-host API default', { skip: unavailable }, (context) => {
  const raw = 'TELEGRAM_BOT_TOKEN=123456:synthetic-token-only\nBOT_BACKEND_SECRET=synthetic-secret-not-real';
  const fixture = harness(context, { runtime: raw });
  const result = fixture.deploy();
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(fixture.runtime(), `${raw}\nBOT_BACKEND_URL=http://api:3001\n`);
});

test('server fallback is copied privately while the remote API and exact secret are retained', { skip: unavailable }, (context) => {
  const raw = 'TELEGRAM_BOT_TOKEN=123456:synthetic-token-only\nBOT_BACKEND_SECRET=exact$"\'`#value\\$(not-a-command)\nBOT_BACKEND_URL=https://private-api.example.test\n';
  const fixture = harness(context, { runtime: null, sharedRuntime: raw });
  const result = fixture.deploy();
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(fixture.runtime(), raw);
  assert.equal(fixture.sharedRuntime(), raw);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-token-only|not-a-command/);
});

test('a supplied GitHub override takes complete precedence over server settings', { skip: unavailable }, (context) => {
  const override = 'TELEGRAM_BOT_TOKEN=github-value\nBOT_BACKEND_SECRET=github-secret\nBOT_BACKEND_URL=https://github-api.example.test\n';
  const server = 'TELEGRAM_BOT_TOKEN=server-value\nBOT_BACKEND_SECRET=server-secret\nBOT_BACKEND_URL=https://server-api.example.test\n';
  const fixture = harness(context, { runtime: override, sharedRuntime: server });
  const result = fixture.deploy();
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(fixture.runtime(), override);
  assert.equal(fixture.sharedRuntime(), server);
});

for (const sharedRuntime of [undefined, '']) {
  test(`missing release config and ${sharedRuntime === undefined ? 'missing' : 'empty'} server config fail before registry or service changes`, { skip: unavailable }, (context) => {
    const fixture = harness(context, { runtime: null, sharedRuntime });
    const result = fixture.deploy();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing or invalid bot runtime configuration/);
    assert.deepEqual(fixture.log(), []);
    assert.equal(fixture.current(), `releases/${oldId}`);
  });
}

test('an explicitly empty release file is rejected instead of silently falling back', { skip: unavailable }, (context) => {
  const fixture = harness(context, { runtime: '', sharedRuntime: 'SERVER_SETTING=present\n' });
  const result = fixture.deploy();
  assert.notEqual(result.status, 0);
  assert.deepEqual(fixture.log(), []);
});

test('rollback uses its saved environment even if the shared file has since changed', { skip: unavailable }, (context) => {
  const fixture = harness(context, { runtime: null, sharedRuntime: 'FROM_SERVER=saved-for-release\n' });
  assert.equal(fixture.deploy().status, 0);
  write(join(fixture.root, 'shared', 'runtime.env'), '');
  const result = fixture.rollback();
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(readFileSync(join(fixture.root, 'releases', oldId, 'runtime.env'), 'utf8'), 'OLD_CONFIGURATION=saved\n');
});
