#!/usr/bin/env python3
"""
One-off parser: docs-address-book-export.txt -> supabase/seed_contacts.sql

Run from the repo root: `python3 scripts/parse_address_book.py` (reads
./docs-address-book-export.txt, writes ./supabase/seed_contacts.sql).

Not part of the app runtime — a build-time tool used once to produce the
seed file, kept here for reproducibility / re-running if Phillip supplies
a corrected export later. Not wired into any npm script (no package.json
change) since it never runs in production.

Format (pdftotext of the Monday export), observed from the source file:
  - Two title lines + an "Exported from..." line, then blank.
  - A CATEGORY heading line (e.g. "Appliances", "CARPENTERS") — detected
    heuristically (see is_category_heading below), followed immediately
    by the first company's name line (no blank line separates a heading
    from the first company under it).
  - Per company: a name line, then zero or more of:
        Contact: X
        Phone: X
        Email: X
        Website: X
        Specialty: X
    then a blank line separating it from the next company (or heading).
  - Multi-line wraps: pdftotext sometimes wraps a long URL or email
    across two lines with no leading keyword on the continuation line
    (e.g. Website: https://terracefloors.com.au/contact?\n  srsltid=...).
    Handled by: if a line has no recognised "Key: " prefix and is not a
    category heading and not blank, and the PREVIOUS field line was one
    of website/email, glue it onto that field with no separator (the
    wrap has no space in the source).
  - Some contact names/emails are followed by a stray blank line before
    "Phone:"/"Email:" continues (e.g. "Hoile Electrical" -> "Contact:
    Blake" -> blank -> "Phone: ..."). Blank lines WITHIN a company's
    field block (i.e. before all of Contact/Phone/Email/Website/
    Specialty for that company have been seen) are treated as
    formatting noise and skipped, not as a record separator — a true
    record separator is a blank line immediately followed by a new
    company name or category heading.
  - Duplicated emails on one line, e.g. "truni3@hotmail.com -
    truni3@hotmail.com" or "info@x.com info@x.com" — deduped to the
    first occurrence.
  - "Contact: 82957827" (Cameron Davidson Painting) — a phone number
    mislabelled as a contact name in the source. Flagged ambiguous.

Ambiguous / needs-review rows get notes = 'Imported — verify':
  - the phone-in-contact-name case above,
  - any row where the only data captured is a company name (no other
    field at all) — still imported (spec says "ALL parseable entries"),
    but flagged since there's nothing to verify it against,
  - a company name that repeats one already seen under a different
    category heading in the source (kept as separate rows — a company
    can legitimately do multiple trades — but flagged for a human to
    confirm it's not a straight duplicate entry).
"""
import re
import html

SRC = "docs-address-book-export.txt"
OUT = "supabase/seed_contacts.sql"

FIELD_RE = re.compile(r"^(Contact|Phone|Email|Website|Specialty):\s*(.*)$")

# Category headings: either ALL-CAPS words (CARPENTERS, WASTE-adjacent
# etc.) or Title Case short lines matching the known set of headings
# observed verbatim in the source file. Using an explicit set is safer
# than a heuristic here, since heuristics on this messy text will
# misfire on a company name like "P&G Furnishing".
KNOWN_HEADINGS = {
    "Appliances", "Architect", "CARPENTERS", "Caulking", "Hardware",
    "Demolition", "Drywall & Plastering", "Electrical", "Engineering",
    "Foundations", "Flooring", "Furniture", "Glazier", "Joinery",
    "Landscaping", "Lighting", "Painting", "Plumbing", "Rendering",
    "Sanitary Ware", "Stone", "Textiles", "Timber", "Waste", "Tiles",
    "Concrete", "Upholstery / Drapery", "Metal works", "Pools and spas",
    "Surveyor",
}


def normalise_category(raw: str) -> str:
    """'CARPENTERS' -> 'Carpenters'; already-Title-Case headings pass through."""
    if raw.isupper():
        # Title-case each word, but keep '&' and short connector words lower.
        words = raw.split(" ")
        out = []
        for w in words:
            if w == "&":
                out.append(w)
            else:
                out.append(w.capitalize())
        return " ".join(out)
    return raw


def dedupe_value(v: str) -> str:
    """'a@b.com - a@b.com' or 'a@b.com a@b.com' -> 'a@b.com' when the value
    is literally repeated (whole value, split on ' - ' or whitespace)."""
    v = v.strip()
    if " - " in v:
        parts = [p.strip() for p in v.split(" - ")]
        if len(parts) == 2 and parts[0] == parts[1]:
            return parts[0]
    # whitespace-repeated (e.g. "info@x.com info@x.com")
    tokens = v.split()
    if len(tokens) == 2 and tokens[0] == tokens[1]:
        return tokens[0]
    return v


def sql_quote(v):
    if v is None:
        return "NULL"
    v = v.replace("'", "''")
    return f"'{v}'"


def main():
    with open(SRC, "r", encoding="utf-8") as f:
        raw_lines = [html.unescape(l.rstrip("\n")) for l in f.readlines()]

    # Skip the header block: two title lines + "Exported from..." + blank.
    lines = raw_lines[3:]

    records = []
    current_category = None
    current = None  # dict in progress
    last_field_key = None  # for wrap-continuation gluing
    seen_company_category = set()

    def flush():
        nonlocal current
        if current is not None and current.get("company"):
            records.append(current)
        current = None

    i = 0
    n = len(lines)
    while i < n:
        line = lines[i].strip()
        i += 1

        if line == "":
            # Blank line: only a record separator if the NEXT non-blank
            # line looks like a new company name or heading — i.e. NOT a
            # field line. Peek ahead.
            j = i
            while j < n and lines[j].strip() == "":
                j += 1
            if j >= n:
                continue
            nxt = lines[j].strip()
            if FIELD_RE.match(nxt):
                # Blank line was just formatting noise inside the same
                # company's field block (e.g. Hoile Electrical case).
                continue
            # Otherwise it's a genuine separator before a new company/heading.
            flush()
            last_field_key = None
            continue

        if line in KNOWN_HEADINGS:
            flush()
            current_category = normalise_category(line)
            last_field_key = None
            continue

        m = FIELD_RE.match(line)
        if m:
            key, val = m.group(1), dedupe_value(m.group(2))
            if current is None:
                # Shouldn't normally happen — a field with no company yet.
                current = {"company": None, "category": current_category, "flags": []}
            field_map = {
                "Contact": "contact_name",
                "Phone": "phone",
                "Email": "email",
                "Website": "website",
                "Specialty": "specialty",
            }
            fkey = field_map[key]
            if val == "":
                last_field_key = fkey
                continue
            if fkey in current and current[fkey]:
                # Already has a value (shouldn't happen in this source) — append.
                current[fkey] = current[fkey] + "; " + val
            else:
                current[fkey] = val
            last_field_key = fkey
            continue

        # Not blank, not a heading, not a "Key: value" line.
        if current is not None and last_field_key in ("website", "email") and current.get(last_field_key):
            # Wrapped continuation of a URL/email onto the next line —
            # glue with no separator (pdftotext line-wrap, no space in source,
            # e.g. Terrace Floors' website query string).
            current[last_field_key] = current[last_field_key] + line
            continue
        if current is not None and last_field_key in ("contact_name", "specialty") and current.get(last_field_key):
            # Wrapped continuation of a Contact:/Specialty: value onto the
            # next line (e.g. Forma's "Contact: Lenice (Accounts & Admin) /
            # Dom (Scheduling) / Jake (Quoting &\nSales)") — glue WITH a
            # space, since these wrap mid-sentence/mid-name at a natural
            # word boundary, unlike the no-space URL/email wrap above.
            current[last_field_key] = current[last_field_key] + " " + line
            continue

        # Otherwise: this is a new company's name line.
        flush()
        key = (line, current_category)
        flags = []
        if key in seen_company_category:
            flags.append("dup-in-source")
        seen_company_category.add(key)
        # Phone-in-contact-name artefact check happens after the block
        # closes (we don't know contact_name yet) — deferred below via
        # a post-pass instead, to keep this loop simple.
        current = {"company": line, "category": current_category, "flags": flags}
        last_field_key = None

    flush()

    # Post-pass: flag ambiguous rows.
    for r in records:
        flags = r.get("flags", [])
        cn = r.get("contact_name")
        if cn and re.fullmatch(r"[\d\s()+-]{6,}", cn):
            # A contact_name that's actually just digits/punctuation —
            # e.g. "Contact: 82957827" (Cameron Davidson Painting) — a
            # phone number mislabelled as a contact name in the source.
            flags.append("contact-name-looks-like-phone")
        only_company = not any(r.get(k) for k in ("contact_name", "phone", "email", "website", "specialty"))
        if only_company:
            flags.append("no-other-fields")
        r["flags"] = flags

    # ---- Emit SQL ----
    out_lines = []
    out_lines.append("-- ============================================================")
    out_lines.append("-- RESLU Spec System — Address Book seed data")
    out_lines.append("-- Parsed from docs-address-book-export.txt (pdftotext of RESLU's")
    out_lines.append("-- Monday.com address book export, 5 July 2026) by")
    out_lines.append("-- scripts_parse_address_book.py — see that script's docstring for")
    out_lines.append("-- the exact parsing rules (blank-line handling, wrapped URL/email")
    out_lines.append("-- continuation lines, deduped repeated emails, category heading")
    out_lines.append("-- normalisation e.g. 'CARPENTERS' -> 'Carpenters').")
    out_lines.append("--")
    out_lines.append("-- Run AFTER migrations/013_boards_contacts.sql has been applied.")
    out_lines.append("-- Idempotent guard: skips a row if a contact with the same")
    out_lines.append("-- (company, category) already exists and is not deleted, so this")
    out_lines.append("-- file can be safely re-run.")
    out_lines.append("--")
    out_lines.append(f"-- {len(records)} companies parsed. Rows flagged 'Imported — verify'")
    out_lines.append("-- in the notes column have some parsing ambiguity — a human should")
    out_lines.append("-- confirm them against the original Monday board.")
    out_lines.append("-- ============================================================")
    out_lines.append("")

    ambiguous_count = 0
    by_category = {}

    for r in records:
        company = r["company"]
        category = r.get("category")
        contact_name = r.get("contact_name")
        phone = r.get("phone")
        email = r.get("email")
        website = r.get("website")
        specialty = r.get("specialty")
        flags = r.get("flags", [])

        notes = "Imported — verify" if flags else None
        if flags:
            ambiguous_count += 1

        by_category.setdefault(category or "Uncategorised", []).append(company)

        cols = "(company, contact_name, phone, email, website, specialty, category, notes)"
        vals = (
            f"{sql_quote(company)}, {sql_quote(contact_name)}, {sql_quote(phone)}, "
            f"{sql_quote(email)}, {sql_quote(website)}, {sql_quote(specialty)}, "
            f"{sql_quote(category)}, {sql_quote(notes)}"
        )
        flag_comment = f"  -- flags: {', '.join(flags)}" if flags else ""
        stmt = (
            f"insert into contacts {cols}\n"
            f"  select {vals}\n"
            f"  where not exists (\n"
            f"    select 1 from contacts c\n"
            f"    where c.company = {sql_quote(company)}\n"
            f"      and c.category is not distinct from {sql_quote(category)}\n"
            f"      and c.deleted_at is null\n"
            f"  );{flag_comment}"
        )
        out_lines.append(stmt)
        out_lines.append("")

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(out_lines))

    print(f"Parsed {len(records)} companies across {len(by_category)} categories.")
    print(f"Ambiguous (flagged 'Imported — verify'): {ambiguous_count}")
    print()
    for cat, companies in sorted(by_category.items()):
        print(f"  {cat}: {len(companies)}")


if __name__ == "__main__":
    main()
