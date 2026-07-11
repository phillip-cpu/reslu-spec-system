import peopleData from "@/emails/signatures/people.json";

// ============================================================
// RESLU Spec System — Email signatures (r22).
// BUILD-SPEC.md "Email signatures page (r22)".
//
// NOTE ON THE FILE NAME: BUILD-SPEC calls this "lib/signatures.ts", but
// that path is already taken by the unrelated NATIVE E-SIGNATURE
// feature (document signing on client-portal contracts — see
// app/api/signatures/route.ts, app/api/signatures/[id]/route.ts,
// app/portal/[token]/sign/[requestId]/**, components/portal/
// SignatureCanvas.tsx / SignatureCertificatePdf.tsx, all of which
// import from lib/signatures.ts and are live prior-round work). This
// module lives at lib/email-signatures.ts instead to avoid clobbering
// that feature — same reasoning applies to the API route below, which
// nests under a literal "installer" segment specifically so it doesn't
// collide with the existing app/api/signatures/[id]/route.ts dynamic
// route.
//
// Source of truth: emails/signatures/reference-signature-phillip.html
// (markup between the SIGNATURE STARTS/ENDS comments) and
// emails/signatures/reference-installer-phillip.sh (the working Apple
// Mail installer). Both are reproduced here VERBATIM as templates with
// exactly three substitution points — name, title, phone (display +
// tel: href) — everything else (the hosted logo URL at 100x41, fonts,
// colours, strapline, single table cell, the installer's Mail headers
// and chflags uchg locking) is byte-identical to the reference.
//
// Person source (BUILD-SPEC item 2/5): the `profiles` table (migrations
// 001_initial.sql / 003_profiles_provisioning.sql) has id, full_name,
// email, role, avatar_url — NO title or phone columns. Per item 5 ("do
// NOT add columns without checking"), no migration was added this
// round. This ships fully people.json-driven: name, title and phone
// all come from emails/signatures/people.json (imported directly —
// tsconfig.json already has resolveJsonModule: true, and there's
// existing codebase precedent for importing a JSON file straight into
// a route, see app/api/second-brain/brain-data/route.ts's
// `vercelConfig` import). TBC values are shown as-is (see
// phoneSegment() below — a TBC phone renders as plain text, never a
// broken tel: link).
//
// `name` also comes from people.json rather than profiles.full_name:
// the locked design's pen-line is a single first name ("Phillip", not
// "Phillip Introna" — see the reference file's own signature), which
// people.json already models; profiles only has the combined
// full_name field, so it wouldn't reproduce the reference exactly.
// ============================================================

export interface SignaturePerson {
  id: string;
  name: string;
  title: string;
  phone: string;
  email: string;
}

interface PeopleJson {
  template_note: string;
  people: SignaturePerson[];
}

const PEOPLE = (peopleData as PeopleJson).people;

/** All signature people, in people.json order (Phillip first). */
export function getSignaturePeople(): SignaturePerson[] {
  return PEOPLE;
}

/** A single signature person by id, or null if no such id. */
export function getSignaturePersonById(id: string): SignaturePerson | null {
  return PEOPLE.find((p) => p.id === id) ?? null;
}

// ------------------------------------------------------------
// Escaping + substitution helpers
// ------------------------------------------------------------

/**
 * HTML-escapes a value AND normalises the literal middot character (·)
 * to the `&middot;` entity the reference markup uses throughout (its
 * title line is literally "DIRECTOR &middot; DESIGN &amp; BUILD", not
 * a raw U+00B7 character) — this is what makes the Phillip output
 * byte-identical to the reference file rather than merely visually
 * identical.
 */
function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/·/g, "&middot;");
}

/** Digits-only tel: href (e.g. "+61 439 870 594" -> "+61439870594"), or "" if the phone has no digits (e.g. "TBC"). */
function phoneDigits(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  return digits ? `+${digits}` : "";
}

/**
 * The phone segment of the signature: a `tel:` link for a real number
 * (byte-identical to the reference's anchor for Phillip), or the plain
 * escaped text (e.g. "TBC") when there are no digits to link — BUILD-
 * SPEC item 5's "TBC shown as-is", applied so a placeholder person
 * never ships a nonsense `tel:+` link.
 */
function phoneSegment(phone: string): string {
  const href = phoneDigits(phone);
  const display = escapeHtml(phone);
  if (!href) return display;
  return `<a href="tel:${href}" style="color:#313131;text-decoration:none;">${display}</a>`;
}

// ------------------------------------------------------------
// Templates — extracted VERBATIM from the reference package, with
// {{NAME}} / {{TITLE}} / {{PHONE_SEGMENT}} / {{ID}} substitution
// points only. Do not hand-edit these without re-diffing against the
// reference files (see docs/BUILD-SPEC.md "Email signatures page").
// ------------------------------------------------------------

/** Multi-line signature block — everything between SIGNATURE STARTS/ENDS in reference-signature-phillip.html. */
const SIGNATURE_TEMPLATE =
  "<div id=\"signature\">\n<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"max-width:460px;width:100%;margin:0 auto;\">\n<tr><td style=\"padding:6px 0;\">\n\n  <div style=\"font-family:'Caveat','Segoe Script','Bradley Hand',cursive;font-weight:600;font-size:30px;line-height:1.1;color:#274690;\">{{NAME}}</div>\n\n  <div style=\"font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-weight:300;font-size:10px;letter-spacing:3px;color:#313131;padding:8px 0 14px;border-bottom:1px solid #1A1A1A;\">{{TITLE}}</div>\n\n  <div style=\"padding:16px 0 10px;\"><a href=\"https://www.reslu.com.au\" style=\"text-decoration:none;\"><img src=\"https://www.reslu.com.au/reslu-logo-sig.png\" width=\"100\" height=\"41\" alt=\"RESLU\" style=\"display:inline-block;width:100px;height:41px;border:0;vertical-align:bottom;\"></a></div>\n\n  <div style=\"font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-weight:300;font-size:12px;line-height:1.9;color:#313131;\">\n    {{PHONE_SEGMENT}} &middot; <a href=\"https://www.reslu.com.au\" style=\"color:#1A1A1A;text-decoration:underline;\">reslu.com.au</a><br>\n    219 Sturt Street, Adelaide SA 5000 &middot; BLD 299219\n  </div>\n\n  <div style=\"font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-weight:300;font-size:9px;letter-spacing:3px;color:#A08C72;padding-top:16px;\">ONE PROJECT &middot; ONE TEAM &middot; ONE STANDARD</div>\n\n</td></tr>\n</table>\n</div>\n";

/** Single-line, whitespace-collapsed table markup — the exact form the reference installer's heredoc embeds (no wrapping div, no comment markers, no newlines inside the table). */
const INSTALLER_LINE_TEMPLATE =
  "<table cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"max-width:460px;\"><tr><td style=\"padding:6px 0;\"><div style=\"font-family:'Caveat','Segoe Script','Bradley Hand',cursive;font-weight:600;font-size:30px;line-height:1.1;color:#274690;\">{{NAME}}</div><div style=\"font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-weight:300;font-size:10px;letter-spacing:3px;color:#313131;padding:8px 0 14px;border-bottom:1px solid #1A1A1A;\">{{TITLE}}</div><div style=\"padding:16px 0 10px;\"><a href=\"https://www.reslu.com.au\" style=\"text-decoration:none;\"><img src=\"https://www.reslu.com.au/reslu-logo-sig.png\" width=\"100\" height=\"41\" alt=\"RESLU\" style=\"display:inline-block;width:100px;height:41px;border:0;vertical-align:bottom;\"></a></div><div style=\"font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-weight:300;font-size:12px;line-height:1.9;color:#313131;\">{{PHONE_SEGMENT}} &middot; <a href=\"https://www.reslu.com.au\" style=\"color:#1A1A1A;text-decoration:underline;\">reslu.com.au</a><br>219 Sturt Street, Adelaide SA 5000 &middot; BLD 299219</div><div style=\"font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-weight:300;font-size:9px;letter-spacing:3px;color:#A08C72;padding-top:16px;\">ONE PROJECT &middot; ONE TEAM &middot; ONE STANDARD</div></td></tr></table>\n";

/** Full installer script — verbatim reference-installer-phillip.sh, with {{NAME}} in the header comment, {{ID}} in the two filename usage lines, and {{SIGNATURE_LINE}} standing in for the heredoc body. Mail headers, chflags nouchg/uchg locking and the most-recent-file/path-arg logic are untouched. */
const INSTALLER_SCRIPT_TEMPLATE =
  "#!/bin/bash\n# RESLU signature installer for Apple Mail ({{NAME}}).\n# Rewrites the target .mailsignature with clean text/html headers + the card.\n#\n# BEFORE RUNNING: quit Mail completely (Cmd+Q).\n# Usage:\n#   bash install-signature-{{ID}}.sh            -> edits most recently modified signature\n#   bash install-signature-{{ID}}.sh /path/to/file.mailsignature   -> edits that file\n\nset -e\n\nif [ -n \"$1\" ]; then\n  F=\"$1\"\nelse\n  ICLOUD=\"$HOME/Library/Mobile Documents/com~apple~mail/Data/V3/Signatures\"\n  LOCAL=$(ls -d \"$HOME/Library/Mail/\"V*/MailData/Signatures 2>/dev/null | tail -1)\n  if [ -d \"$ICLOUD\" ] && ls \"$ICLOUD\"/*.mailsignature >/dev/null 2>&1; then\n    SIGDIR=\"$ICLOUD\"\n  elif [ -n \"$LOCAL\" ] && ls \"$LOCAL\"/*.mailsignature >/dev/null 2>&1; then\n    SIGDIR=\"$LOCAL\"\n  else\n    echo \"No .mailsignature files found.\"\n    exit 1\n  fi\n  F=$(ls -t \"$SIGDIR\"/*.mailsignature | head -1)\nfi\n\necho \"Editing: $F\"\n\nMSGID=$(grep -m1 '^Message-Id:' \"$F\" || echo \"Message-Id: <$(uuidgen)>\")\n\nchflags nouchg \"$F\" 2>/dev/null || true\n\n{\n  printf '%s\\n' \"$MSGID\"\n  printf 'Mime-Version: 1.0 (Mac OS X Mail 16.0 \\\\(3826.700.81\\\\))\\n'\n  printf 'Content-Transfer-Encoding: 7bit\\n'\n  printf 'Content-Type: text/html;\\n\\tcharset=us-ascii\\n\\n'\n  cat <<'EOF_HTML'\n{{SIGNATURE_LINE}}\nEOF_HTML\n} > \"$F\"\n\nchflags uchg \"$F\"\necho \"Done. Open Mail and check Settings > Signatures.\"\necho \"To unlock later: chflags nouchg \\\"$F\\\"\"\n";

function substitute(template: string, person: SignaturePerson, extra?: Record<string, string>): string {
  let out = template
    .split("{{NAME}}").join(escapeHtml(person.name))
    .split("{{TITLE}}").join(escapeHtml(person.title))
    .split("{{PHONE_SEGMENT}}").join(phoneSegment(person.phone));
  if (extra) {
    for (const [token, value] of Object.entries(extra)) {
      out = out.split(`{{${token}}}`).join(value);
    }
  }
  return out;
}

/**
 * Renders the signature markup (multi-line, same shape as the block
 * between SIGNATURE STARTS/ENDS in the reference file) for live
 * preview and rich-text copy. For person "phillip" with the reference
 * package's own values this is byte-identical to that block.
 */
export function renderSignatureHtml(person: SignaturePerson): string {
  return substitute(SIGNATURE_TEMPLATE, person);
}

/**
 * Renders the single-line, whitespace-collapsed table markup used
 * inside the Mail installer's heredoc (no wrapping div, no comments).
 */
export function renderInstallerSignatureLine(person: SignaturePerson): string {
  return substitute(INSTALLER_LINE_TEMPLATE, person).replace(/\n$/, "");
}

/**
 * Renders the full install-signature-<id>.sh script for a person. For
 * person "phillip" this is byte-identical to
 * emails/signatures/reference-installer-phillip.sh.
 */
export function renderInstallerScript(person: SignaturePerson): string {
  const line = renderInstallerSignatureLine(person);
  return substitute(INSTALLER_SCRIPT_TEMPLATE, person, { ID: person.id, SIGNATURE_LINE: line });
}
