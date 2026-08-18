#!/bin/bash
set -euo pipefail
umask 077

SPEC_URL="${SPEC_URL:?set in environment}"
TOKEN_HELPER="/Users/vale/reslu-health/get-aria-token.sh"
CACHE_DIR="/private/tmp/reslu-health-$(id -u)"
HEARTBEAT_RESPONSE="${CACHE_DIR}/heartbeat-response"
SOFTWAREUPDATE_OUTPUT="${CACHE_DIR}/heartbeat-softwareupdate"
CURL=(/usr/bin/curl --silent --show-error --connect-timeout 8 --max-time 25 --retry 1 --retry-delay 1 --retry-all-errors --retry-max-time 25)
mkdir -p "$CACHE_DIR"
chmod 700 "$CACHE_DIR"

run_bounded_capture() {
  local output_file="$1"
  local timeout_seconds="$2"
  shift 2
  "$@" >"$output_file" 2>&1 &
  local child_pid=$!
  local elapsed=0
  while kill -0 "$child_pid" 2>/dev/null; do
    if [ "$elapsed" -ge "$timeout_seconds" ]; then
      kill "$child_pid" 2>/dev/null || true
      wait "$child_pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  wait "$child_pid"
}

UPTIME=$(uptime)
DISK_FREE_GB=$(df -g / | awk 'NR==2{print $4}')
MEM_FREE_GB=$(( $(vm_stat | awk '/Pages free/{gsub(/\./,"",$3); print $3}') * 4096 / 1000000000 ))
OPENCLAW_UP=$(pgrep -f openclaw >/dev/null 2>&1 && echo true || echo false)
if run_bounded_capture "$SOFTWAREUPDATE_OUTPUT" 45 /usr/sbin/softwareupdate -l; then
  PENDING_UPDATES=$(grep -c '^\s*\*' "$SOFTWAREUPDATE_OUTPUT" || true)
else
  PENDING_UPDATES=0
  echo "reslu-health: softwareupdate timed out; heartbeat continues" >&2
fi

BODY=$(/usr/bin/jq -cn \
  --arg uptime "$UPTIME" \
  --argjson disk_free_gb "$DISK_FREE_GB" \
  --argjson mem_free_gb "$MEM_FREE_GB" \
  --argjson openclaw_up "$OPENCLAW_UP" \
  --argjson pending_updates "$PENDING_UPDATES" \
  '{uptime:$uptime,disk_free_gb:$disk_free_gb,mem_free_gb:$mem_free_gb,openclaw_up:$openclaw_up,pending_updates:$pending_updates}')

post_heartbeat() {
  local token="$1"
  "${CURL[@]}" -o "$HEARTBEAT_RESPONSE" -w '%{http_code}' \
    -X POST "${SPEC_URL}/api/health/heartbeat" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    --data-binary "$BODY"
}

TOKEN=$("$TOKEN_HELPER")
STATUS=$(post_heartbeat "$TOKEN")
if [ "$STATUS" = "401" ]; then
  "$TOKEN_HELPER" --invalidate
  TOKEN=$("$TOKEN_HELPER")
  STATUS=$(post_heartbeat "$TOKEN")
fi
if [[ "$STATUS" != 2* ]]; then
  echo "reslu-health: heartbeat endpoint returned HTTP ${STATUS}" >&2
  exit 1
fi
chmod 600 "$HEARTBEAT_RESPONSE" "$SOFTWAREUPDATE_OUTPUT"
