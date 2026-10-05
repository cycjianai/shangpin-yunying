#!/usr/bin/env bash
set -Eeuo pipefail

# ==============================================================================
# 统一测试浏览器启动脚本 (macOS & Linux)
# 用于多平台商品运营自动化（美团、牵牛花、饿了么、翱象、mini橙等）
# 核心目标：彻底规避平台安全风控拦截（如美团 Yoda 121056 请求异常、禁止登录、滑块报错）
#
# 启动核心规范：
# 1. 严禁携带 --enable-automation（避免 navigator.webdriver = true 与自动化提示条）
# 2. 必须添加 --disable-blink-features=AutomationControlled（抹除 Blink 内核自动化特征）
# 3. 必须指定独立 --user-data-dir（规避与现有日常 Chrome 冲突导致调试端口被静默忽略）
# 4. 默认采用持久化 Profile 目录，保持商户登录态与 Cookie，避免每次反复扫码/短信验证码
# ==============================================================================

umask 077

readonly host_os="$(uname -s)"

# 默认配置
target_url="https://waimaie.meituan.com/"
cdp_port="9222"
profile_dir=""
log_dir=""
chrome_bin=""
temp_profile=0
headless=0

# 解析命令行参数
while (($#)); do
  case "$1" in
    --url) target_url="${2:?missing --url value}"; shift 2 ;;
    --cdp-port) cdp_port="${2:?missing --cdp-port value}"; shift 2 ;;
    --profile-dir) profile_dir="${2:?missing --profile-dir value}"; shift 2 ;;
    --log-dir) log_dir="${2:?missing --log-dir value}"; shift 2 ;;
    --chrome-bin) chrome_bin="${2:?missing --chrome-bin value}"; shift 2 ;;
    --temp-profile) temp_profile=1; shift 1 ;;
    --headless) headless=1; shift 1 ;;
    -h|--help)
      echo "用法: $0 [选项]"
      echo "选项:"
      echo "  --url <URL>            目标网址 (默认: https://waimaie.meituan.com/)"
      echo "  --cdp-port <PORT>      CDP 远程调试端口 (默认: 9222)"
      echo "  --profile-dir <DIR>    用户数据目录 (默认持久化目录)"
      echo "  --log-dir <DIR>        日志输出目录"
      echo "  --chrome-bin <PATH>    Chrome 可执行文件路径"
      echo "  --temp-profile         使用一次性临时 Profile (会话结束后销毁)"
      echo "  --headless             以无头模式运行"
      exit 0
      ;;
    *) echo "未知选项: $1" >&2; exit 2 ;;
  esac
done

# 校验端口格式
[[ "$cdp_port" =~ ^[0-9]+$ ]] || { echo "端口必须为数字: $cdp_port" >&2; exit 2; }

# 配置 Profile 与日志目录
timestamp="$(date +%Y%m%d-%H%M%S)"
if [[ "$temp_profile" == "1" ]]; then
  if [[ "$host_os" == "Darwin" ]]; then
    profile_dir="${profile_dir:-${TMPDIR:-/tmp}/chrome-test-temp-${timestamp}}"
    log_dir="${log_dir:-${TMPDIR:-/tmp}/chrome-test-logs-${timestamp}}"
  else
    profile_dir="${profile_dir:-/tmp/chrome-test-temp-${timestamp}}"
    log_dir="${log_dir:-/tmp/chrome-test-logs-${timestamp}}"
  fi
else
  # 默认持久化 Profile：保留商户登录态，后续启动免重复扫码/输入短信
  if [[ "$host_os" == "Darwin" ]]; then
    profile_dir="${profile_dir:-${HOME}/Library/Application Support/Google/Chrome-AutomationProfile}"
    log_dir="${log_dir:-${HOME}/Library/Logs/Chrome-AutomationProfile}"
  else
    profile_dir="${profile_dir:-${HOME}/.config/google-chrome-automation-profile}"
    log_dir="${log_dir:-${HOME}/.config/google-chrome-automation-profile/logs}"
  fi
fi

# 安全检查：禁止根目录或用户主目录作为 profile_dir
if [[ "$profile_dir" == "/" || "$profile_dir" == "$HOME" || "$log_dir" == "/" || "$log_dir" == "$HOME" ]]; then
  echo "拒绝使用宽泛的根目录或家目录作为 profile/log 路径" >&2
  exit 2
fi

# 寻找 Chrome 可执行文件
if [[ -z "$chrome_bin" ]]; then
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    /usr/bin/google-chrome \
    /usr/bin/google-chrome-stable \
    /usr/bin/chromium \
    /usr/bin/chromium-browser \
    /home/ubuntu/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome; do
    if [[ -x "$candidate" ]]; then
      chrome_bin="$candidate"
      break
    fi
  done
fi
[[ -x "$chrome_bin" ]] || { echo "未找到 Chrome 可执行文件；请通过 --chrome-bin 指定" >&2; exit 2; }

# 检查 CDP 端口占用
if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$cdp_port" | tail -n +2 | grep -q .; then
  echo "CDP 端口已被占用: $cdp_port" >&2
  exit 2
fi
if ! command -v ss >/dev/null 2>&1 && lsof -nP -iTCP:"$cdp_port" -sTCP:LISTEN 2>/dev/null | tail -n +2 | grep -q .; then
  echo "CDP 端口已被占用: $cdp_port" >&2
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
  if [[ "$temp_profile" == "1" && -d "$profile_dir" ]]; then
    rm -rf "$profile_dir" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

# 组装 Chrome 核心启动参数
# 注意：严禁添加 --enable-automation！
chrome_args=(
  --user-data-dir="$profile_dir"
  --remote-debugging-address=127.0.0.1
  --remote-debugging-port="$cdp_port"
  --remote-allow-origins="*"
  --disable-blink-features=AutomationControlled
  --no-first-run
  --no-default-browser-check
  --window-size=1600,1000
)

if [[ "$headless" == "1" ]]; then
  chrome_args+=(--headless=new --disable-gpu)
else
  chrome_args+=(--start-maximized)
fi

if [[ "$host_os" != "Darwin" ]]; then
  chrome_args+=(
    --no-sandbox
    --disable-setuid-sandbox
    --disable-dev-shm-usage
  )
fi

echo "正在启动纯净 Chrome 测试浏览器 (反风控拦截模式)..."
echo "  可执行文件: $chrome_bin"
echo "  数据目录:   $profile_dir"
echo "  CDP 端口:   $cdp_port"
echo "  初始目标页: $target_url"

"$chrome_bin" "${chrome_args[@]}" "$target_url" >>"$log_dir/chrome.log" 2>&1 &
pids+=("$!")

# 等待 CDP 端口就绪
ready=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 1 "http://127.0.0.1:${cdp_port}/json/version" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done

if [[ "$ready" != "1" ]]; then
  echo "错误: Chrome CDP 未能在 30 秒内就绪，请检查日志: $log_dir/chrome.log" >&2
  exit 1
fi

echo "=========================================================="
echo "Chrome 纯净测试浏览器启动成功！"
echo "CDP_URL=http://127.0.0.1:${cdp_port}"
echo "PROFILE_DIR=${profile_dir}"
echo "LOG_DIR=${log_dir}"
echo "STATUS=READY"
echo "提示: 请在打开的浏览器窗口中正常完成商户登录；进程退出时浏览器将关闭。"
echo "=========================================================="

wait "${pids[0]}"
