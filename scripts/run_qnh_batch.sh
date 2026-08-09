#!/usr/bin/env bash
set -Eeuo pipefail

# Canonical future-only entry for QNH Node batch work. The first invocation
# re-enters under a bounded transient unit; the inner invocation runs Node.

umask 077

readonly guard=/home/saas/repo/tools/runtime_stability/run_bounded_automation.sh
readonly direct_script=/home/ubuntu/.codex/skills/qnh-fill-channel-unavailable/scripts/qnh_direct.mjs
readonly adaptive_controller=/home/ubuntu/.codex/skills/qnh-fill-channel-unavailable/scripts/qnh_adaptive_concurrency.py

adaptive_enabled=0
if [[ "${QNH_DIRECT_ADAPTIVE_APPROVED:-0}" == "1" ]]; then
  adaptive_enabled=1
  if [[ -z "${QNH_ADAPTIVE_STATE_FILE:-}" || "${QNH_ADAPTIVE_STATE_FILE}" != /* ]]; then
    echo 'QNH adaptive mode requires an absolute QNH_ADAPTIVE_STATE_FILE' >&2
    exit 80
  fi
fi

if [[ "${YDSG_AUTOMATION_MANAGED:-0}" != "1" ]]; then
  if [[ "$adaptive_enabled" == "1" ]]; then
    decision_json="$(python3 "$adaptive_controller" decide --state "$QNH_ADAPTIVE_STATE_FILE")"
    QNH_DIRECT_MAX_CONCURRENCY="$(jq -er '.concurrency' <<<"$decision_json")"
    export QNH_DIRECT_MAX_CONCURRENCY
    printf '%s\n' "$decision_json" >&2
  fi
  exec "$guard" --kind batch -- "$0" "$@"
fi

if [[ "$adaptive_enabled" != "1" ]]; then
  export QNH_DIRECT_MAX_CONCURRENCY=2
  exec /usr/bin/node \
    --expose-gc \
    --max-old-space-size=2560 \
    "$direct_script" \
    "$@"
fi

if [[ ! "${QNH_DIRECT_MAX_CONCURRENCY:-}" =~ ^([2-9]|10)$ ]]; then
  echo 'adaptive concurrency must be between 2 and 10' >&2
  exit 81
fi

summary_tmp="$(mktemp)"
node_pid=''
watchdog_pid=''
cleanup() {
  if [[ -n "$watchdog_pid" ]]; then
    kill "$watchdog_pid" >/dev/null 2>&1 || true
    wait "$watchdog_pid" >/dev/null 2>&1 || true
  fi
  rm -f -- "$summary_tmp"
}
trap cleanup EXIT
batch_name=''
previous_argument=''
for argument in "$@"; do
  if [[ "$previous_argument" == '--batch-name' ]]; then
    batch_name="$argument"
    break
  fi
  if [[ "$argument" == --batch-name=* ]]; then
    batch_name="${argument#--batch-name=}"
    break
  fi
  previous_argument="$argument"
done

watch_adaptive_node() {
  local target_pid="$1"
  local threshold_kib=$((2200 * 1024))
  local required_samples=5
  local high_samples=0
  local elapsed_samples=0
  local max_elapsed_samples=150
  local rss_kib=0

  while kill -0 "$target_pid" >/dev/null 2>&1; do
    sleep 2
    elapsed_samples=$((elapsed_samples + 1))
    rss_kib="$(awk '$1 == "VmRSS:" {print $2}' "/proc/${target_pid}/status" 2>/dev/null || true)"
    if [[ "$rss_kib" =~ ^[0-9]+$ ]] && ((rss_kib >= threshold_kib)); then
      high_samples=$((high_samples + 1))
    else
      high_samples=0
    fi
    if ((high_samples >= required_samples)); then
      printf '{"event":"adaptive_process_watchdog_stop","reason":"sustained_rss_high","rss_mib":%d,"threshold_mib":2200,"samples":%d}\n' \
        "$((rss_kib / 1024))" \
        "$high_samples" >&2
      kill -TERM "$target_pid" >/dev/null 2>&1 || true
      return 0
    fi
    if ((elapsed_samples >= max_elapsed_samples)); then
      printf '{"event":"adaptive_process_watchdog_stop","reason":"wall_time_budget_exceeded","elapsed_seconds":%d,"threshold_seconds":300}\n' \
        "$((elapsed_samples * 2))" >&2
      kill -TERM "$target_pid" >/dev/null 2>&1 || true
      return 0
    fi
  done
}

set +e
/usr/bin/node \
  --expose-gc \
  --max-old-space-size=2560 \
  "$direct_script" \
  "$@" >"$summary_tmp" &
node_pid=$!
watch_adaptive_node "$node_pid" &
watchdog_pid=$!
wait "$node_pid"
status=$?
kill "$watchdog_pid" >/dev/null 2>&1 || true
wait "$watchdog_pid" >/dev/null 2>&1 || true
watchdog_pid=''
set -e
python3 "$adaptive_controller" observe \
  --state "$QNH_ADAPTIVE_STATE_FILE" \
  --summary "$summary_tmp" \
  --exit-code "$status" \
  --batch-name "$batch_name" >&2
cat "$summary_tmp"
exit "$status"
