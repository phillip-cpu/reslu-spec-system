#!/bin/bash
# RESLU signature installer for Apple Mail (Phillip).
# Rewrites the target .mailsignature with clean text/html headers + the card.
#
# BEFORE RUNNING: quit Mail completely (Cmd+Q).
# Usage:
#   bash install-signature-phillip.sh            -> edits most recently modified signature
#   bash install-signature-phillip.sh /path/to/file.mailsignature   -> edits that file

set -e

if [ -n "$1" ]; then
  F="$1"
else
  ICLOUD="$HOME/Library/Mobile Documents/com~apple~mail/Data/V3/Signatures"
  LOCAL=$(ls -d "$HOME/Library/Mail/"V*/MailData/Signatures 2>/dev/null | tail -1)
  if [ -d "$ICLOUD" ] && ls "$ICLOUD"/*.mailsignature >/dev/null 2>&1; then
    SIGDIR="$ICLOUD"
  elif [ -n "$LOCAL" ] && ls "$LOCAL"/*.mailsignature >/dev/null 2>&1; then
    SIGDIR="$LOCAL"
  else
    echo "No .mailsignature files found."
    exit 1
  fi
  F=$(ls -t "$SIGDIR"/*.mailsignature | head -1)
fi

echo "Editing: $F"

MSGID=$(grep -m1 '^Message-Id:' "$F" || echo "Message-Id: <$(uuidgen)>")

chflags nouchg "$F" 2>/dev/null || true

{
  printf '%s\n' "$MSGID"
  printf 'Mime-Version: 1.0 (Mac OS X Mail 16.0 \\(3826.700.81\\))\n'
  printf 'Content-Transfer-Encoding: 7bit\n'
  printf 'Content-Type: text/html;\n\tcharset=us-ascii\n\n'
  cat <<'EOF_HTML'
<table cellpadding="0" cellspacing="0" border="0" style="max-width:460px;"><tr><td style="padding:6px 0;"><div style="font-family:'Caveat','Segoe Script','Bradley Hand',cursive;font-weight:600;font-size:30px;line-height:1.1;color:#274690;">Phillip</div><div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-weight:300;font-size:10px;letter-spacing:3px;color:#313131;padding:8px 0 14px;border-bottom:1px solid #1A1A1A;">DIRECTOR &middot; DESIGN &amp; BUILD</div><div style="padding:16px 0 10px;"><a href="https://www.reslu.com.au" style="text-decoration:none;"><img src="https://www.reslu.com.au/reslu-logo-sig.png" width="100" height="41" alt="RESLU" style="display:inline-block;width:100px;height:41px;border:0;vertical-align:bottom;"></a></div><div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-weight:300;font-size:12px;line-height:1.9;color:#313131;"><a href="tel:+61439870594" style="color:#313131;text-decoration:none;">+61 439 870 594</a> &middot; <a href="https://www.reslu.com.au" style="color:#1A1A1A;text-decoration:underline;">reslu.com.au</a><br>219 Sturt Street, Adelaide SA 5000 &middot; BLD 299219</div><div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-weight:300;font-size:9px;letter-spacing:3px;color:#A08C72;padding-top:16px;">ONE PROJECT &middot; ONE TEAM &middot; ONE STANDARD</div></td></tr></table>
EOF_HTML
} > "$F"

chflags uchg "$F"
echo "Done. Open Mail and check Settings > Signatures."
echo "To unlock later: chflags nouchg \"$F\""
