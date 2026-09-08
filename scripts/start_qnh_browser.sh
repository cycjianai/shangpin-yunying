#!/usr/bin/env bash
set -Eeuo pipefail

# Start an isolated, extension-free QNH Chrome with loopback-only CDP and noVNC.
# Keep this process running for the lifetime of the browser session.

umask 077

# Only future launches enter the isolated automation slice. A browser session
# that was already running when this file changed is neither moved nor restarted.
readonly runtime_guard="${QNH_RUNTIME_GUARD:-/home/saas/repo/tools/runtime_stability/run_bounded_automation.sh}"
readonly host_os="$(uname -s)"
if [[ "$host_os" == "Linux" && "${YDSG_AUTOMATION_MANAGED:-0}" != "1" ]]; then
  [[ -x "$runtime_guard" ]] || { echo "bounded runtime entry missing; configure QNH_RUNTIME_GUARD" >&2; exit 79; }
  exec "$runtime_guard" --kind browser -- "$0" "$@"
fi

display_number="132"
cdp_port="9292"
vnc_port="5992"
novnc_port="6092"
profile_dir=""
log_dir=""
chrome_bin=""

while (($#)); do
  case "$1" in
    --display) display_number="${2:?missing --display value}"; shift 2 ;;
    --cdp-port) cdp_port="${2:?missing --cdp-port value}"; shift 2 ;;
    --vnc-port) vnc_port="${2:?missing --vnc-port value}"; shift 2 ;;
    --novnc-port) novnc_port="${2:?missing --novnc-port value}"; shift 2 ;;
    --profile-dir) profile_dir="${2:?missing --profile-dir value}"; shift 2 ;;
    --log-dir) log_dir="${2:?missing --log-dir value}"; shift 2 ;;
    --chrome-bin) chrome_bin="${2:?missing --chrome-bin value}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

for value in "$display_number" "$cdp_port" "$vnc_port" "$novnc_port"; do
  [[ "$value" =~ ^[0-9]+$ ]] || { echo "display/ports must be numeric" >&2; exit 2; }
done

timestamp="$(date +%Y%m%d-%H%M%S)"
if [[ "$host_os" == "Darwin" ]]; then
  profile_dir="${profile_dir:-${TMPDIR:-/tmp}/qnh-direct-${timestamp}-profile}"
  log_dir="${log_dir:-${TMPDIR:-/tmp}/qnh-direct-${timestamp}-logs}"
else
  profile_dir="${profile_dir:-/home/ubuntu/e2e-browser-lab/profiles/qnh-direct-${timestamp}}"
  log_dir="${log_dir:-/home/ubuntu/e2e-browser-lab/logs/qnh-direct-${timestamp}}"
fi

if [[ "$profile_dir" == "/" || "$profile_dir" == "/home/ubuntu" || "$log_dir" == "/" || "$log_dir" == "/home/ubuntu" ]]; then
  echo "refusing broad profile/log directory" >&2
  exit 2
fi

if [[ -z "$chrome_bin" ]]; then
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    /home/ubuntu/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome \
    /usr/bin/google-chrome \
    /usr/bin/chromium; do
    if [[ -x "$candidate" ]]; then
      chrome_bin="$candidate"
      break
    fi
  done
fi
[[ -x "$chrome_bin" ]] || { echo "Chrome binary not found; pass --chrome-bin" >&2; exit 2; }

for port in "$cdp_port" "$vnc_port" "$novnc_port"; do
  if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$port" | tail -n +2 | grep -q .; then
    echo "port already in use: $port" >&2
    exit 2
  fi
  if ! command -v ss >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tail -n +2 | grep -q .; then
    echo "port already in use: $port" >&2
    exit 2
  fi
done
if [[ "$host_os" == "Linux" && -e "/tmp/.X${display_number}-lock" ]]; then
  echo "X display already in use: :$display_number" >&2
  exit 2
fi

mkdir -p "$profile_dir" "$log_dir"
chmod 700 "$profile_dir" "$log_dir"

pids=()
cleanup() {
  trap - EXIT INT TERM
  for pid in "${pids[@]:-}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  for pid in "${pids[@]:-}"; do
    wait "$pid" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT INT TERM

if [[ "$host_os" == "Darwin" ]]; then
  "$chrome_bin" \
    --user-data-dir="$profile_dir" \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="$cdp_port" \
    --remote-allow-origins='*' \
    --disable-extensions \
    --no-first-run \
    --no-default-browser-check \
    --window-size=1600,1000 \
    --start-maximized \
    https://qnh.meituan.com/ >>"$log_dir/chrome.log" 2>&1 &
  pids+=("$!")

  ready=0
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 1 "http://127.0.0.1:${cdp_port}/json/version" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.5
  done
  [[ "$ready" == "1" ]] || { echo "Chrome CDP did not become ready" >&2; exit 1; }

  printf 'NO_VNC_URL=\n'
  printf 'CDP_URL=http://127.0.0.1:%s\n' "$cdp_port"
  printf 'PROFILE_DIR=%s\n' "$profile_dir"
  printf 'LOG_DIR=%s\n' "$log_dir"
  wait "${pids[0]}"
  exit 1
fi

Xvfb ":${display_number}" -screen 0 1600x1000x24 -nolisten tcp >>"$log_dir/xvfb.log" 2>&1 &
pids+=("$!")
sleep 0.5
env DISPLAY=":${display_number}" openbox >>"$log_dir/openbox.log" 2>&1 &
pids+=("$!")
env DISPLAY=":${display_number}" tint2 >>"$log_dir/tint2.log" 2>&1 &
pids+=("$!")
x11vnc -display ":${display_number}" -listen 127.0.0.1 -localhost -forever -shared -nopw \
  -rfbport "$vnc_port" >>"$log_dir/x11vnc.log" 2>&1 &
pids+=("$!")
websockify --web=/usr/share/novnc "127.0.0.1:${novnc_port}" "127.0.0.1:${vnc_port}" \
  >>"$log_dir/novnc.log" 2>&1 &
pids+=("$!")
env DISPLAY=":${display_number}" "$chrome_bin" \
  --user-data-dir="$profile_dir" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$cdp_port" \
  --disable-extensions \
  --no-first-run \
  --no-default-browser-check \
  --no-sandbox \
  --disable-setuid-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --disable-accelerated-2d-canvas \
  --disable-accelerated-video-decode \
  --disable-features=Vulkan \
  --use-gl=swiftshader \
  --window-size=1600,1000 \
  --start-maximized \
  https://qnh.meituan.com/ >>"$log_dir/chrome.log" 2>&1 &
pids+=("$!")

ready=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 1 "http://127.0.0.1:${cdp_port}/json/version" >/dev/null 2>&1 \
    && curl -fsS --max-time 1 "http://127.0.0.1:${novnc_port}/vnc.html" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
[[ "$ready" == "1" ]] || { echo "Chrome/noVNC did not become ready" >&2; exit 1; }

printf 'NO_VNC_URL=http://127.0.0.1:%s/vnc.html\n' "$novnc_port"
printf 'CDP_URL=http://127.0.0.1:%s\n' "$cdp_port"
printf 'PROFILE_DIR=%s\n' "$profile_dir"
printf 'LOG_DIR=%s\n' "$log_dir"
printf 'TUNNEL_TEMPLATE=ssh -fN -o ExitOnForwardFailure=yes -L %s:127.0.0.1:%s YOUR_SSH_HOST\n' \
  "$novnc_port" "$novnc_port"

wait -n "${pids[@]}"
exit 1
