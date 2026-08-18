#!/bin/bash
set -euo pipefail
umask 077

CACHE_DIR="/private/tmp/reslu-health-$(id -u)"
SESSION_FILE="${CACHE_DIR}/aria-session.json"
LOCK_DIR="${CACHE_DIR}/aria-session.lock"
CURL=(/usr/bin/curl --silent --show-error --connect-timeout 8 --max-time 20 --retry 1 --retry-delay 1 --retry-all-errors --retry-max-time 20)

mkdir -p "$CACHE_DIR"
chmod 700 "$CACHE_DIR"

if [ "${1:-}" = "--invalidate" ]; then
  rm -f "$SESSION_FILE"
  exit 0
fi
if [ "$#" -ne 0 ]; then
  echo "usage: get-aria-token.sh [--invalidate]" >&2
  exit 64
fi

SUPABASE_URL="${SUPABASE_URL:?}"
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:?}"
ARIA_EMAIL="${ARIA_EMAIL:?}"
ARIA_PASSWORD="${ARIA_PASSWORD:?}"

attempt=0
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 100 ]; then
    if [ -n "$(find "$LOCK_DIR" -mmin +1 -print -quit 2>/dev/null)" ]; then
      rmdir "$LOCK_DIR" 2>/dev/null || true
      attempt=0
      continue
    fi
    echo "reslu-health: timed out waiting for the private auth-cache lock" >&2
    exit 75
  fi
  sleep 0.1
done
cleanup_lock() { rmdir "$LOCK_DIR" 2>/dev/null || true; }
trap cleanup_lock EXIT INT TERM HUP

now=$(date +%s)
if [ -f "$SESSION_FILE" ]; then
  chmod 600 "$SESSION_FILE"
  cached_access=$(/usr/bin/jq -r '.access_token // empty' "$SESSION_FILE" 2>/dev/null || true)
  cached_expiry=$(/usr/bin/jq -r '.expires_at // 0' "$SESSION_FILE" 2>/dev/null || true)
  if [ -n "$cached_access" ] && [ "$cached_expiry" -gt $((now + 300)) ] 2>/dev/null; then
    printf '%s' "$cached_access"
    exit 0
  fi
fi

auth_response=""
cached_refresh=""
if [ -f "$SESSION_FILE" ]; then
  cached_refresh=$(/usr/bin/jq -r '.refresh_token // empty' "$SESSION_FILE" 2>/dev/null || true)
fi
if [ -n "$cached_refresh" ]; then
  refresh_payload=$(/usr/bin/jq -cn --arg refresh_token "$cached_refresh" '{refresh_token:$refresh_token}')
  auth_response=$(printf '%s' "$refresh_payload" | "${CURL[@]}" \
    -X POST "${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Content-Type: application/json" \
    --data-binary @- 2>/dev/null || true)
fi

if ! printf '%s' "$auth_response" | /usr/bin/jq -e \
  '(.access_token | type == "string" and length > 0) and (.refresh_token | type == "string" and length > 0)' \
  >/dev/null 2>&1; then
  password_payload=$(/usr/bin/jq -cn --arg email "$ARIA_EMAIL" --arg password "$ARIA_PASSWORD" \
    '{email:$email,password:$password}')
  auth_response=$(printf '%s' "$password_payload" | "${CURL[@]}" \
    -X POST "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Content-Type: application/json" \
    --data-binary @- 2>/dev/null || true)
fi

if ! printf '%s' "$auth_response" | /usr/bin/jq -e \
  '(.access_token | type == "string" and length > 0) and (.refresh_token | type == "string" and length > 0)' \
  >/dev/null 2>&1; then
  echo "reslu-health: authentication and refresh both failed" >&2
  exit 1
fi

session_tmp=$(mktemp "${CACHE_DIR}/aria-session.XXXXXX")
printf '%s' "$auth_response" | /usr/bin/jq \
  --argjson fallback_expiry "$((now + 3600))" \
  '{access_token,refresh_token,expires_at:(.expires_at // $fallback_expiry),expires_in,token_type,user_id:(.user.id // null)}' \
  > "$session_tmp"
chmod 600 "$session_tmp"
mv -f "$session_tmp" "$SESSION_FILE"
chmod 600 "$SESSION_FILE"
/usr/bin/jq -r '.access_token' "$SESSION_FILE"
