#!/bin/bash
set -euo pipefail

export ARIA_EMAIL="aria@reslu.com.au"
export ARIA_PASSWORD="$(/usr/bin/security find-generic-password -a vale -s reslu-aria-supabase-password -w)"
exec /opt/homebrew/bin/node /Users/vale/reslu-spec-system/mcp/src/index.mjs
