#!/usr/bin/env bash
# Sourced by server-release.sh; compose() is scoped to the selected release.

service_preflight() {
  docker network inspect klan-production >/dev/null || return
  docker volume inspect klan-production-bot-state >/dev/null || return
  compose run --rm --no-deps -T --entrypoint node bot dist/main.js --check-config || return
  compose run --rm --no-deps -T --entrypoint node bot --input-type=module - <<'NODE' || return
import { access, constants } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readConfig } from './dist/config.js';
import { fileOffsetStore } from './dist/state.js';

try {
  const config = readConfig();
  await access(dirname(config.stateFile), constants.R_OK | constants.W_OK | constants.X_OK);
  // Validate existing state without creating or advancing an offset.
  await fileOffsetStore(config.stateFile).load();
  try {
    await access(`${config.stateFile}.tmp`, constants.W_OK);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const response = await fetch(`${config.backendOrigin}/api/health`, {
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  if (!response.ok || body.data?.status !== 'ok' || body.data?.demo !== false) throw new Error();
  console.log('Bot config, persistent state access and production API health are valid. No Telegram requests were made.');
} catch {
  console.error('Bot preflight failed: check configuration, state access and production API health.');
  process.exitCode = 1;
}
NODE
}

service_start() {
  # A token must never have two polling workers during update or rollback.
  compose stop --timeout 20 bot || return
  compose up --detach --no-deps --force-recreate --scale bot=1 bot || return
}

service_verify() {
  local container snapshot first_snapshot attempt
  container=$(compose ps --all --quiet bot) || return
  if [[ -z "$container" || "$container" == *$'\n'* ]]; then
    printf '%s\n' 'Expected exactly one production bot container.' >&2
    return 1
  fi
  first_snapshot=''
  for attempt in {0..6}; do
    snapshot=$(docker inspect --format '{{.State.Running}} {{.State.Restarting}} {{.RestartCount}} {{.State.StartedAt}}' "$container") || return
    if [[ "$snapshot" != 'true false 0 '* || ( -n "$first_snapshot" && "$snapshot" != "$first_snapshot" ) ]]; then
      printf '%s\n' 'Bot exited or restarted during the startup observation.' >&2
      return 1
    fi
    first_snapshot=$snapshot
    if (( attempt < 6 )); then
      sleep 5 || return
    fi
  done
  printf '%s\n' 'Bot process stayed running for 30 seconds without restart. Telegram delivery is not verified by this check.'
}

service_stop() {
  compose stop --timeout 20 bot || return
}
