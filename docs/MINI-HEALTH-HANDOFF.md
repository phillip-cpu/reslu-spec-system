# Mini health handoff — Health + web push round (r26)

For Claude Code. This round (docs/BUILD-SPEC.md §"Health + web push
(r26)") built the SPEC-SIDE half of mini monitoring — the five tables
(migration 053), the REST routes, the MCP tools, the Health page, and
web push. It did NOT (and per this round's own protocol, could not)
touch anything that runs ON the mini itself, or `vercel.json` (Claude
Code-owned). This doc is everything CC needs to finish the handoff:
the mini-side scripts to write, the env vars to set both places, and
the one `vercel.json` line to add.

**Standing ruling, repeated because it matters for every script below:
monitoring must burn zero AI credits.** Every script in this doc is a
plain bash/curl loop — no LLM call anywhere in the heartbeat or
silence-checking path. The ONLY credit-consuming action anywhere in
this system is a Claude Code repair session, and that only ever runs
because Phillip explicitly started one himself, entirely outside
everything described here. The mini's own "diagnostics" repair
(restart WhatsApp bridge, check for updates) is also a dumb script —
see §4 below — not an agent session.

**Repair scripts are CC's to write and own.** This doc gives the exact
shape (endpoints, payloads, auth, plist skeleton) every mini-side script
needs to follow; CC writes the actual scripts on the mini itself (they
don't live in this repo — nothing in `supabase/`, `app/`, `lib/`, or
`mcp/` runs unattended on the mini) and is responsible for keeping the
repair logic (§4's actual restart/verify commands) safe and idempotent.

---

## 1. Why heartbeats are OUTBOUND-only

Vercel has no inbound network path to a machine sitting on Phillip's/
the studio's LAN — there is no way for `GET /api/health/check` to ping
the mini directly. So liveness is inferred entirely from the mini's own
OUTBOUND posts going quiet: the mini posts a heartbeat roughly every 5
minutes; the silence-checker cron (`GET /api/health/check`, run every
10 minutes) treats "no heartbeat in the last 15 minutes" as an
incident. Diagnostics work the same way in reverse: an admin presses a
button on `/health`, which just inserts a `health_diagnostics` row —
the mini has to come and GET it, run repairs, then POST the result
back. Nothing in this system ever pushes work TO the mini synchronously.

## 2. Auth — identical to Aria's own MCP auth

Every mini-facing route (`POST /api/health/heartbeat`, `POST
/api/health/channel-status`, `GET /api/health/diagnostics/pending`,
`POST /api/health/diagnostics/[id]/complete`) uses
`lib/supabase/server.ts`'s existing Bearer-token branch — the exact
same mechanism `mcp/src/index.mjs`'s `apiFetch()` already uses (see
`docs/ARIA.md`'s Authentication section). No new secret/scheme was
introduced for this round. The heartbeat/diagnostics scripts below
authenticate the SAME way: sign in as Aria via a plain curl to Supabase
Auth's own REST endpoint, cache the access token for its ~1h lifetime,
re-sign-in on a 401.

```bash
# sign-in call (returns {"access_token": "...", ...})
curl -s -X POST "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${ARIA_EMAIL}\",\"password\":\"${ARIA_PASSWORD}\"}"
```

Every script below assumes a helper function `get_token()` that runs
this once, caches the result in a variable/temp file, and re-runs it if
a subsequent call 401s. `jq` is NOT assumed to be installed on the mini
(per this round's own "jq-free payload assembly" instruction) — extract
`access_token` with a plain `sed`/grep, e.g.:

```bash
ACCESS_TOKEN=$(curl -s -X POST "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
  -H "apikey: ${SUPABASE_ANON_KEY}" -H "Content-Type: application/json" \
  -d "{\"email\":\"${ARIA_EMAIL}\",\"password\":\"${ARIA_PASSWORD}\"}" \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
```

## 3. Heartbeat script — launchd job, every ~5 minutes

**Payload fields** (`POST ${SPEC_URL}/api/health/heartbeat`, all
optional — see migration 053's `health_heartbeats` table):

| field | type | source |
|---|---|---|
| `uptime` | string | `uptime` output, verbatim |
| `disk_free_gb` | number | e.g. `df -g / \| awk 'NR==2{print $4}'` |
| `mem_free_gb` | number | e.g. `vm_stat`-derived free pages × page size ÷ 1e9 |
| `openclaw_up` | boolean | whether the OpenClaw process is alive (`pgrep`) |
| `pending_updates` | number | count of lines from `softwareupdate -l` |
| `extra` | object | anything else worth carrying (CPU temp, load avg) — free-form |

**Jq-free JSON assembly** — build the body with plain shell string
interpolation (every field here is a controlled, script-computed value,
never untrusted user input, so this is safe):

```bash
#!/bin/bash
# ~/reslu-health/heartbeat.sh — run every 5 minutes via launchd (see
# plist below). Zero AI credits: this is the entire script, no LLM
# call anywhere in it.
set -euo pipefail

SPEC_URL="${SPEC_URL:?set in environment}"
SUPABASE_URL="${SUPABASE_URL:?}"
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:?}"
ARIA_EMAIL="${ARIA_EMAIL:?}"
ARIA_PASSWORD="${ARIA_PASSWORD:?}"

TOKEN_FILE="/tmp/.reslu-aria-token"

get_token() {
  if [ -f "$TOKEN_FILE" ] && [ "$(find "$TOKEN_FILE" -mmin -50 2>/dev/null)" != "" ]; then
    cat "$TOKEN_FILE"
    return
  fi
  local resp token
  resp=$(curl -s -X POST "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
    -H "apikey: ${SUPABASE_ANON_KEY}" -H "Content-Type: application/json" \
    -d "{\"email\":\"${ARIA_EMAIL}\",\"password\":\"${ARIA_PASSWORD}\"}")
  token=$(printf '%s' "$resp" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
  [ -n "$token" ] || { echo "reslu-health: sign-in failed: $resp" >&2; exit 1; }
  printf '%s' "$token" > "$TOKEN_FILE"
  printf '%s' "$token"
}

UPTIME=$(uptime | sed 's/"/\\"/g')
DISK_FREE_GB=$(df -g / | awk 'NR==2{print $4}')
MEM_FREE_GB=$(( $(vm_stat | awk '/Pages free/{gsub(/\./,"",$3); print $3}') * 4096 / 1000000000 ))
OPENCLAW_UP=$(pgrep -f openclaw >/dev/null 2>&1 && echo true || echo false)
PENDING_UPDATES=$(softwareupdate -l 2>/dev/null | grep -c '^\s*\*' || true)

BODY=$(cat <<JSON
{"uptime":"${UPTIME}","disk_free_gb":${DISK_FREE_GB},"mem_free_gb":${MEM_FREE_GB},"openclaw_up":${OPENCLAW_UP},"pending_updates":${PENDING_UPDATES}}
JSON
)

TOKEN=$(get_token)
STATUS=$(curl -s -o /tmp/.reslu-heartbeat-resp -w '%{http_code}' -X POST "${SPEC_URL}/api/health/heartbeat" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" -d "$BODY")

if [ "$STATUS" = "401" ]; then
  rm -f "$TOKEN_FILE"
  TOKEN=$(get_token)
  curl -s -o /tmp/.reslu-heartbeat-resp -X POST "${SPEC_URL}/api/health/heartbeat" \
    -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" -d "$BODY"
fi
```

**launchd plist** (`~/Library/LaunchAgents/com.reslu.health-heartbeat.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.reslu.health-heartbeat</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/aria/reslu-health/heartbeat.sh</string>
  </array>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/reslu-heartbeat.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/reslu-heartbeat.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SPEC_URL</key>
    <string>https://spec.reslu.com.au</string>
    <key>SUPABASE_URL</key>
    <string>REPLACE_WITH_NEXT_PUBLIC_SUPABASE_URL</string>
    <key>SUPABASE_ANON_KEY</key>
    <string>REPLACE_WITH_NEXT_PUBLIC_SUPABASE_ANON_KEY</string>
    <key>ARIA_EMAIL</key>
    <string>aria@reslu.com.au</string>
    <key>ARIA_PASSWORD</key>
    <string>REPLACE_WITH_ARIA_PASSWORD</string>
  </dict>
</dict>
</plist>
```

Load with `launchctl load ~/Library/LaunchAgents/com.reslu.health-heartbeat.plist`.

## 4. Channel-status reporting from OpenClaw

Whenever OpenClaw's own WhatsApp-bridge health check (or email/calendar
integration) notices a state change, it should POST to
`${SPEC_URL}/api/health/channel-status` (same auth as above):

```bash
curl -s -X POST "${SPEC_URL}/api/health/channel-status" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{"channel":"whatsapp","label":"WhatsApp bridge","status":"down","session_valid":false,"note":"QR session expired"}'
```

This is event-driven (call it when OpenClaw itself detects a change),
not a separate polling loop — OpenClaw already has to know its own
WhatsApp session state to function at all; this is just also reporting
it outward. Valid `channel` keys used by this round: `whatsapp`,
`email`, `calendar` (see migration 053's own comment — free text, add
more as needed, no migration required).

## 5. Diagnostics runner loop

Poll loop (cron/launchd, e.g. every 2 minutes — lighter-weight than a
webhook since there's no inbound path, but far cheaper than the
heartbeat's own 5-minute full-system read):

```bash
#!/bin/bash
# ~/reslu-health/diagnostics-loop.sh — poll get_pending_diagnostics,
# repair, report back. Zero AI credits — every check/repair step below
# is a fixed, scripted command; nothing here calls an LLM.
set -euo pipefail
TOKEN=$(get_token)   # same helper as heartbeat.sh

PENDING=$(curl -s "${SPEC_URL}/api/health/diagnostics/pending" -H "Authorization: Bearer ${TOKEN}")

# Jq-free: extract each {"id":"..."} — one diagnostics request is the
# common case; a simple grep/sed loop over "id" occurrences is enough
# (install jq on the mini if this ever needs to get fancier — CC's call).
echo "$PENDING" | grep -o '"id":"[^"]*"' | sed 's/"id":"//;s/"//' | while read -r ID; do
  REPORT="Diagnostics run $(date -u +%Y-%m-%dT%H:%M:%SZ)."
  STATUS="done"

  # --- restart WhatsApp bridge ---
  if ! pgrep -f whatsapp-bridge >/dev/null 2>&1; then
    REPORT="${REPORT} WhatsApp bridge was down, restarting."
    /usr/bin/env node ~/reslu-health/restart-whatsapp-bridge.mjs || { STATUS="failed"; REPORT="${REPORT} Restart FAILED."; }
  else
    REPORT="${REPORT} WhatsApp bridge already running."
  fi

  # --- verify session ---
  if ~/reslu-health/verify-whatsapp-session.sh; then
    REPORT="${REPORT} Session valid."
  else
    STATUS="failed"
    REPORT="${REPORT} Session INVALID — needs a human to re-scan the QR code."
  fi

  # --- check for pending macOS updates ---
  UPDATES=$(softwareupdate -l 2>/dev/null | grep -c '^\s*\*' || true)
  REPORT="${REPORT} ${UPDATES} macOS update(s) pending."

  curl -s -X POST "${SPEC_URL}/api/health/diagnostics/${ID}/complete" \
    -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
    -d "{\"status\":\"${STATUS}\",\"report\":\"${REPORT}\"}"
done
```

**CC owns writing the actual repair scripts** referenced above
(`restart-whatsapp-bridge.mjs`, `verify-whatsapp-session.sh`) — this
loop only shows the shape (poll -> repair -> report), not their
internals, since those depend on exactly how OpenClaw's WhatsApp bridge
is implemented on the mini (outside this repo).

## 6. VAPID keygen (no new npm dependency)

Verified round-trip (keygen -> JWT sign -> signature verify against the
public key) during this round's build — see this round's own final
report for the exact test. Run once, on any machine with Node
installed (does not need to be the mini):

```bash
node -e "
const { generateKeyPairSync } = require('crypto');
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = publicKey.export({ format: 'jwk' });
const priv = privateKey.export({ format: 'jwk' });
const pubBytes = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
console.log('NEXT_PUBLIC_VAPID_PUBLIC_KEY=' + pubBytes.toString('base64url'));
console.log('VAPID_PRIVATE_KEY=' + Buffer.from(priv.d, 'base64url').toString('base64url'));
"
```

Set `NEXT_PUBLIC_VAPID_PUBLIC_KEY` on Vercel (build-time public env —
also read directly client-side by `components/settings/PushSettings.tsx`)
and `VAPID_PRIVATE_KEY` as a server-only secret. Never commit either.
If the keys are ever rotated, every existing `push_subscriptions` row
becomes invalid for NEW sends (the browser subscribed against the OLD
public key) — the next push attempt against each will 404/410 and
lib/push.ts will delete the stale row automatically; affected users
just need to re-enable push in Settings.

## 7. Env vars — full list for this round

**Vercel (Next.js app):**
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` — from §6 above.
- `VAPID_PRIVATE_KEY` — from §6 above, server-only.
- `CRON_SECRET` — already exists (this round's `/api/health/check` reuses it, same as every other cron in this build).

**Mini (heartbeat/channel-status/diagnostics scripts, launchd
`EnvironmentVariables` or a sourced `.env`):**
- `SPEC_URL` — already exists (`https://spec.reslu.com.au`).
- `SUPABASE_URL` (same value as `NEXT_PUBLIC_SUPABASE_URL`) — for the
  direct Supabase Auth sign-in curl call (§2).
- `SUPABASE_ANON_KEY` (same value as `NEXT_PUBLIC_SUPABASE_ANON_KEY`).
- `ARIA_EMAIL` / `ARIA_PASSWORD` — already exist.

No new secret/scheme was introduced anywhere in this round — every
value above either already exists in `.env.local.example` or is the
newly-generated VAPID pair from §6.

## 8. `vercel.json` cron line (PROTECTED — CC adds this)

`vercel.json` is protected in this round (agents never touch it). Add
this entry to the existing `"crons"` array, alongside the others:

```json
{
  "path": "/api/health/check",
  "schedule": "*/10 * * * *"
}
```

Every 10 minutes — comfortably inside the 15-minute mini-silence
threshold (`lib/health.ts`'s `MINI_SILENCE_INCIDENT_MINUTES`) so a
genuine outage is caught within one or two missed checks, without
adding a cron entry so frequent it meaningfully adds to Vercel's cron
invocation count.
