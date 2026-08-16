#!/bin/bash
set -euo pipefail

export ARIA_EMAIL="aria@reslu.com.au"
export ARIA_PASSWORD="$(/usr/bin/security find-generic-password -a vale -s reslu-aria-supabase-password -w)"
export SPEC_URL="https://spec.reslu.com.au"
export NEXT_PUBLIC_SUPABASE_URL="https://tnwtpljckhdyyrqjaneo.supabase.co"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="sb_publishable_itck3XfmwjSOfLTlJBcOPQ_VE-rLRMT"
exec /opt/homebrew/bin/node /Users/vale/reslu-spec-system/mcp/src/index.mjs
