#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/../Deploy/service.sh"
test_dir=$(mktemp -d)
trap 'rm -f -- "$test_dir/compose" "$test_dir/docker"; rmdir -- "$test_dir"' EXIT

compose() {
  printf '%s\n' "$*" >>"$test_dir/compose"
  case "$1" in
    stop) return "${stop_result:-0}" ;;
    up) return "${up_result:-0}" ;;
    ps) printf '%s\n' "${container_ids:-bot-container}" ;;
    run) cat >/dev/null; return "${preflight_result:-0}" ;;
  esac
}
docker() {
  printf '%s\n' "$*" >>"$test_dir/docker"
  if [[ "$1" == inspect ]]; then
    printf '%s\n' "${container_snapshot:-true false 0 2026-01-01T00:00:00Z}"
  fi
}
sleep() { :; }
fail() { printf '%s\n' "$1" >&2; exit 1; }

# An old worker that cannot stop must prevent starting the replacement.
stop_result=42
if service_start; then fail 'Start accepted a failed stop.'; fi
if grep -q '^up ' "$test_dir/compose"; then fail 'A second worker was started.'; fi
stop_result=0
: >"$test_dir/compose"
service_start
[[ $(sed -n '1p' "$test_dir/compose") == 'stop --timeout 20 bot' ]] || fail 'Old worker was not stopped first.'
[[ $(sed -n '2p' "$test_dir/compose") == 'up --detach --no-deps --force-recreate --scale bot=1 bot' ]] || fail 'Replacement did not use a single fresh container.'

# The orchestrator calls hooks in conditionals: failures must propagate there.
up_result=43
if service_start; then fail 'Start hid an up failure.'; fi
up_result=0
preflight_result=44
if service_preflight </dev/null; then fail 'Preflight hid a config failure.'; fi
preflight_result=0

# A restart loop or multiple workers must not pass the startup observation.
container_snapshot='true false 1 2026-01-01T00:00:00Z'
if service_verify; then fail 'A restarted worker passed verification.'; fi
container_snapshot='false false 0 2026-01-01T00:00:00Z'
if service_verify; then fail 'An exited worker passed verification.'; fi
container_snapshot='true false 0 2026-01-01T00:00:00Z'
container_ids=$'bot-one\nbot-two'
if service_verify; then fail 'Multiple workers passed verification.'; fi
container_ids=bot-container
service_verify

: >"$test_dir/compose"
service_stop
[[ $(cat "$test_dir/compose") == 'stop --timeout 20 bot' ]] || fail 'Stop affected more than the bot service.'
printf '%s\n' 'Bot deployment hook tests passed without Docker or Telegram.'
