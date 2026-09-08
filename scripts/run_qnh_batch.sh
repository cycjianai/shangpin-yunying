#!/usr/bin/env bash
set -Eeuo pipefail

# Canonical future-only entry for QNH Node batch work. The first invocation
# re-enters under a bounded transient unit; the inner invocation runs Node.

umask 077

readonly guard="${QNH_RUNTIME_GUARD:-/home/saas/repo/tools/runtime_stability/run_bounded_automation.sh}"
readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly direct_script="${script_dir}/qnh_direct.mjs"
readonly adaptive_controller="${script_dir}/qnh_adaptive_concurrency.py"
readonly node_bin="${QNH_NODE_BIN:-$(command -v node)}"
readonly python_bin="${QNH_PYTHON_BIN:-$(command -v python3)}"

# Reject an oversized mutation window before entering the managed process or
# attaching to the logged-in browser.  The orchestrator advances large tasks
# through stable offset windows of at most 50 SPUs.
if [[ "${1:-}" == 'apply-direct-batch' ]]; then
  mutation_limit=50
  previous_argument=''
  for argument in "$@"; do
    if [[ "$previous_argument" == '--limit' ]]; then
      mutation_limit="$argument"
      break
    fi
    if [[ "$argument" == --limit=* ]]; then
      mutation_limit="${argument#--limit=}"
      break
    fi
    previous_argument="$argument"
  done
  if [[ ! "$mutation_limit" =~ ^[1-9][0-9]*$ ]] || ((mutation_limit > 50)); then
    echo 'qnh_batch_window_limit_exceeded: apply-direct-batch --limit 必须为 1..50' >&2
    exit 82
  fi
fi

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
    decision_json="$("$python_bin" "$adaptive_controller" decide --state "$QNH_ADAPTIVE_STATE_FILE")"
    desired_concurrency="$(jq -er '.concurrency' <<<"$decision_json")"
    if [[ ! "$desired_concurrency" =~ ^(1|2|4)$ ]]; then
      echo 'adaptive concurrency decision must be one of 1,2,4' >&2
      exit 81
    fi
    # The external admission guard may require at least 2 as its compatibility
    # input. Admit the same bounded cgroup with 2, then restore the frozen
    # controller decision inside that cgroup before Node starts.  This keeps
    # project-wide runtime policy untouched while allowing one warm editor
    # page after two editors proved counterproductive on the current host.
    QNH_DIRECT_MAX_CONCURRENCY="$desired_concurrency"
    if [[ "$desired_concurrency" == "1" ]]; then
      QNH_DIRECT_MAX_CONCURRENCY=2
    fi
    export QNH_DIRECT_MAX_CONCURRENCY
    printf '%s\n' "$decision_json" >&2
  fi
  [[ -x "$guard" ]] || { echo "bounded runtime entry missing; configure QNH_RUNTIME_GUARD" >&2; exit 79; }
  exec "$guard" --kind batch -- "$0" "$@"
fi

if [[ "$adaptive_enabled" != "1" ]]; then
  export QNH_DIRECT_MAX_CONCURRENCY=1
  exec "$node_bin" \
    --expose-gc \
    --max-old-space-size=2560 \
    "$direct_script" \
    "$@"
fi

desired_concurrency="$(jq -er '.last_decision.concurrency' "$QNH_ADAPTIVE_STATE_FILE")"
if [[ ! "$desired_concurrency" =~ ^(1|2|4)$ ]]; then
  echo 'adaptive concurrency must be one of 1,2,4' >&2
  exit 81
fi
QNH_DIRECT_MAX_CONCURRENCY="$desired_concurrency"
export QNH_DIRECT_MAX_CONCURRENCY

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
  local max_elapsed_samples=450
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
      printf '{"event":"adaptive_process_watchdog_stop","reason":"wall_time_budget_exceeded","elapsed_seconds":%d,"threshold_seconds":900}\n' \
        "$((elapsed_samples * 2))" >&2
      kill -TERM "$target_pid" >/dev/null 2>&1 || true
      return 0
    fi
  done
}

set +e
"$node_bin" \
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
"$python_bin" "$adaptive_controller" observe \
  --state "$QNH_ADAPTIVE_STATE_FILE" \
  --summary "$summary_tmp" \
  --exit-code "$status" \
  --batch-name "$batch_name" >&2
cat "$summary_tmp"
exit "$status"
