#!/bin/bash
set -euo pipefail
umask 077

SPEC_URL="${SPEC_URL:?set in environment}"
TOKEN_HELPER="/Users/vale/reslu-health/get-aria-token.sh"
CACHE_DIR="/private/tmp/reslu-health-$(id -u)"
PENDING_RESPONSE="${CACHE_DIR}/diagnostics-pending"
COMMAND_OUTPUT="${CACHE_DIR}/diagnostics-command"
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

get_pending() {
  local token="$1"
  "${CURL[@]}" -o "$PENDING_RESPONSE" -w '%{http_code}' \
    "${SPEC_URL}/api/health/diagnostics/pending" \
    -H "Authorization: Bearer ${token}"
}

TOKEN=$("$TOKEN_HELPER")
HTTP_STATUS=$(get_pending "$TOKEN")
if [ "$HTTP_STATUS" = "401" ]; then
  "$TOKEN_HELPER" --invalidate
  TOKEN=$("$TOKEN_HELPER")
  HTTP_STATUS=$(get_pending "$TOKEN")
fi
if [[ "$HTTP_STATUS" != 2* ]]; then
  echo "reslu-health: diagnostics claim returned HTTP ${HTTP_STATUS}" >&2
  exit 1
fi

/usr/bin/jq -e '.diagnostics | type == "array"' "$PENDING_RESPONSE" >/dev/null
while IFS= read -r ID; do
  [ -n "$ID" ] || continue
  REPORT="Diagnostics run $(date -u +%Y-%m-%dT%H:%M:%SZ)."
  STATUS="done"

  if ! pgrep -f openclaw >/dev/null 2>&1; then
    REPORT="${REPORT} OpenClaw/WhatsApp bridge was down; restart attempted."
    if ! run_bounded_capture "$COMMAND_OUTPUT" 30 /usr/bin/env node /Users/vale/reslu-health/restart-whatsapp-bridge.mjs; then
      STATUS="failed"
      REPORT="${REPORT} Restart failed or timed out."
    fi
  else
    REPORT="${REPORT} OpenClaw running."
  fi

  if run_bounded_capture "$COMMAND_OUTPUT" 20 /Users/vale/reslu-health/verify-whatsapp-session.sh; then
    REPORT="${REPORT} WhatsApp session valid."
  else
    STATUS="failed"
    REPORT="${REPORT} WhatsApp session invalid, stale, or verification timed out."
  fi

  if run_bounded_capture "$COMMAND_OUTPUT" 45 /usr/sbin/softwareupdate -l; then
    UPDATES=$(grep -c '^\s*\*' "$COMMAND_OUTPUT" || true)
    REPORT="${REPORT} ${UPDATES} macOS update(s) pending."
  else
    STATUS="failed"
    REPORT="${REPORT} macOS update check timed out."
  fi

  COMPLETION_BODY=$(/usr/bin/jq -cn --arg status "$STATUS" --arg report "$REPORT" '{status:$status,report:$report}')
  COMPLETE_STATUS=$("${CURL[@]}" -o "$COMMAND_OUTPUT" -w '%{http_code}' \
    -X POST "${SPEC_URL}/api/health/diagnostics/${ID}/complete" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    --data-binary "$COMPLETION_BODY")
  if [[ "$COMPLETE_STATUS" != 2* ]]; then
    echo "reslu-health: diagnostic completion returned HTTP ${COMPLETE_STATUS}" >&2
    exit 1
  fi
done < <(/usr/bin/jq -r '.diagnostics[]?.id' "$PENDING_RESPONSE")

chmod 600 "$PENDING_RESPONSE" "$COMMAND_OUTPUT" 2>/dev/null || true
