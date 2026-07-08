#!/usr/bin/env python3
# ============================================================
# RESLU Spec System — Step 8: Email ingest + preprocessing
# (Second Brain — docs/SECOND-BRAIN.md §"Step 8").
#
# Runs on Aria's Mac mini ONLY (not Vercel): it needs real mailbox
# access (Gmail API, aria@reslu.com.au) and local binaries
# (pdftotext, ocrmypdf, tesseract) that don't exist in the serverless
# runtime — which is why this half of Step 8 was built here rather
# than as a Vercel API route. The `emails` / `email_attachments`
# tables it writes were already created by migration 037_emails.sql
# (applied to the live DB); this script does NOT create schema.
#
# Pipeline (one pass; scheduled every ~10 min via launchd — see
# scripts/ai.reslu.email-ingest.plist. The brief says "cron"; this
# machine schedules with launchd exclusively, so a StartInterval=600
# LaunchAgent is the local equivalent):
#   1. Fetch new mail via the Gmail API (same OAuth refresh-token flow
#      as lib/gmail/send.ts). Dedupe on the RFC Message-ID header.
#   2. Pick the best body part; HTML -> markdown (html2text); strip
#      quoted replies + signatures (talon if importable, else
#      email_reply_parser + a light signature scrubber). Store as
#      clean_text; record a rough token_estimate.
#   3. PDFs: pdftotext first; empty text layer -> ocrmypdf -> retry;
#      still nothing -> needs_vision=true + store page_count. For docs
#      >5 pages, keep only pages containing `$`, a "<n> wk/week", or a
#      known item name, and record which in kept_pages.
#      Image attachments (jpg/png/…) have no text layer, so content
#      images above a size threshold are flagged needs_vision=true for
#      Step 9's vision pass; small decorative logos are left alone.
#   4. Hard-rule skip (newsletters / auto-replies / noreply senders)
#      -> status='skipped'. Everything else is left at status='new'
#      for Step 9 (triage) to pick up.
#
# Scope note: triage, extraction, and project matching are Steps 9-10.
# This script never sets triage_label / matched_project_id / etc.
#
# Storage: the raw .eml and every attachment are uploaded to the
# private `assets` Supabase Storage bucket (lib/storage.ts
# ASSET_BUCKET) under email-ingest/<sha1(message_id)>/..., and the
# OBJECT PATH (not a signed URL) is stored in raw_ref / storage_ref —
# mirroring how the app stores storage_path and mints signed URLs on
# read. This keeps needs_vision attachments reachable from Vercel for
# Step 9's vision pass.
#
# Env (loaded from ../.env.local, same loader style as
# scripts/import-monday-leads.mjs; shell env wins if already set):
#   SUPABASE_URL | NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
#   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, ARIA_GMAIL_REFRESH_TOKEN,
#   GMAIL_TOKEN_URI (optional)
#
# Usage (run from anywhere; env is read relative to this file):
#   .venv-email-ingest/bin/python scripts/email_ingest.py            # normal pass
#   ... scripts/email_ingest.py --limit 20                           # cap fetched msgs (acceptance)
#   ... scripts/email_ingest.py --lookback-days 3                    # Gmail newer_than window
#   ... scripts/email_ingest.py --dry-run                            # fetch+process, write nothing
#   ... scripts/email_ingest.py --selftest                           # offline: run pure fns on samples
# ============================================================

import argparse
import base64
import email
import hashlib
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from email.header import decode_header, make_header
from email.message import Message
from email.utils import parsedate_to_datetime, getaddresses
from pathlib import Path

import requests

# --- talon is optional (frequently unbuildable on new CPythons). ----
try:
    import talon
    from talon import quotations, signature as talon_signature
    talon.init()
    _HAS_TALON = True
except Exception:
    _HAS_TALON = False

from email_reply_parser import EmailReplyParser

ASSET_BUCKET = "assets"  # mirrors lib/storage.ts
GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"
DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token"
HTTP_TIMEOUT = 30


# ------------------------------------------------------------------
# Env loading (matches scripts/import-monday-leads.mjs behaviour)
# ------------------------------------------------------------------
def load_env() -> None:
    env_path = Path(__file__).resolve().parent.parent / ".env.local"
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            eq = s.find("=")
            if eq < 1:
                continue
            k, v = s[:eq].strip(), s[eq + 1:].strip()
            os.environ.setdefault(k, v)
    except FileNotFoundError:
        pass  # rely on shell env


def env(*names: str) -> str | None:
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return None


# ------------------------------------------------------------------
# Body extraction + cleaning (Step 8.2)
# ------------------------------------------------------------------
def _decode(part: Message) -> str:
    payload = part.get_payload(decode=True)
    if payload is None:
        return ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except (LookupError, UnicodeDecodeError):
        return payload.decode("utf-8", errors="replace")


def _html_to_markdown(html: str) -> str:
    import html2text
    h = html2text.HTML2Text()
    h.body_width = 0          # don't hard-wrap — keeps prices/urls intact
    h.ignore_images = True
    h.ignore_emphasis = False
    h.protect_links = True
    return h.handle(html)


def best_body_markdown(msg: Message) -> str:
    """Prefer text/plain; fall back to text/html converted to markdown.
    Skips attachment dispositions."""
    plain, html = None, None
    for part in msg.walk():
        if part.is_multipart():
            continue
        disp = (part.get("Content-Disposition") or "").lower()
        if "attachment" in disp:
            continue
        ctype = part.get_content_type()
        if ctype == "text/plain" and plain is None:
            plain = _decode(part)
        elif ctype == "text/html" and html is None:
            html = _decode(part)
    if plain and plain.strip():
        return plain
    if html and html.strip():
        return _html_to_markdown(html)
    return plain or ""


# A light signature scrubber — belt-and-suspenders on top of the reply
# parser. Cuts from the first line that looks like a sig delimiter or a
# common "sent from" footer. Deliberately conservative.
_SIG_DELIM = re.compile(r"^\s*--\s*$")
# Sign-off openers, anchored at line start. Bare words carry a trailing
# \b so a following comma/newline still matches ("Cheers," / "Regards");
# the two "sent from my" / "get outlook for" footers end in a space and
# match the phrase directly.
_SIG_HINTS = re.compile(
    r"^\s*(?:sent from |get outlook for |"          # "Sent from my iPhone", "Sent from Outlook for iOS"
    r"(?:kind |best |warm |many )?(?:regards|cheers|thanks|thank you|thanx)\b)",
    re.IGNORECASE,
)


def _strip_signature_heuristic(text: str) -> str:
    lines = text.splitlines()
    cut = None
    for i, ln in enumerate(lines):
        if _SIG_DELIM.match(ln) or _SIG_HINTS.match(ln):
            cut = i
            break
    if cut is None:
        return text
    return "\n".join(lines[:cut]).rstrip()


def clean_body(markdown_text: str) -> str:
    """Strip quoted replies + signatures. talon when available (best),
    else email_reply_parser + heuristic scrubber."""
    text = markdown_text.replace("\r\n", "\n").replace("\r", "\n")
    if _HAS_TALON:
        reply = quotations.extract_from(text, "text/plain")
        reply, _sig = talon_signature.extract(reply, sender="")
        cleaned = reply
    else:
        cleaned = EmailReplyParser.parse_reply(text)
        cleaned = _strip_signature_heuristic(cleaned)
    # collapse 3+ blank lines the parsers can leave behind
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned


def estimate_tokens(text: str) -> int:
    """Rough token estimate for downstream Claude budgeting. ~4 chars/
    token is the standard heuristic; we also floor on word count so
    very "wide" text isn't undercounted."""
    if not text:
        return 0
    by_chars = len(text) / 4.0
    by_words = len(text.split()) * 0.75
    return int(round(max(by_chars, by_words)))


# ------------------------------------------------------------------
# Hard-rule skip (Step 8.4)
# ------------------------------------------------------------------
_NOREPLY = re.compile(
    r"(no[._-]?reply|do[._-]?not[._-]?reply|donotreply|notification|"
    r"mailer-daemon|postmaster|bounce)",
    re.IGNORECASE,
)


def should_skip(msg: Message, from_addr: str, subject: str) -> str | None:
    """Return a short reason string if this email should be skipped,
    else None."""
    # noreply / automated senders
    if _NOREPLY.search(from_addr or ""):
        return "noreply sender"
    # RFC 3834 auto-replies / auto-generated
    auto = (msg.get("Auto-Submitted") or "").lower()
    if auto and auto != "no":
        return f"auto-submitted:{auto}"
    if msg.get("X-Autoreply") or msg.get("X-Autorespond"):
        return "auto-reply header"
    prec = (msg.get("Precedence") or "").lower()
    if prec in ("bulk", "list", "auto_reply", "junk"):
        return f"precedence:{prec}"
    # newsletters / bulk lists
    if msg.get("List-Unsubscribe") or msg.get("List-Id"):
        return "mailing list"
    if msg.get("X-Campaign") or msg.get("X-Mailgun-Sid") or msg.get("X-Mailchimp-Id"):
        return "bulk campaign"
    subj = (subject or "").strip().lower()
    if subj.startswith(("out of office", "automatic reply", "auto:", "autoreply")):
        return "out-of-office subject"
    return None


# ------------------------------------------------------------------
# PDF extraction (Step 8.3)
# ------------------------------------------------------------------
_HAS_OCRMYPDF = None  # resolved lazily


def _bin_exists(name: str) -> bool:
    from shutil import which
    return which(name) is not None


def pdf_page_count(path: str) -> int | None:
    """Page count via poppler's pdfinfo (installed alongside pdftotext)."""
    try:
        out = subprocess.run(
            ["pdfinfo", path], capture_output=True, text=True, timeout=60
        )
        m = re.search(r"^Pages:\s+(\d+)", out.stdout, re.MULTILINE)
        return int(m.group(1)) if m else None
    except Exception:
        return None


def _pdftotext(path: str) -> str:
    """Extract text, keeping form-feed (\\f) page separators so we can
    split per page later (pdftotext emits \\f between pages)."""
    try:
        out = subprocess.run(
            ["pdftotext", "-layout", path, "-"],
            capture_output=True, text=True, timeout=120,
        )
        return out.stdout or ""
    except Exception:
        return ""


def _ocr_then_text(path: str) -> str:
    global _HAS_OCRMYPDF
    if _HAS_OCRMYPDF is None:
        _HAS_OCRMYPDF = _bin_exists("ocrmypdf")
    if not _HAS_OCRMYPDF:
        return ""
    try:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tf:
            out_pdf = tf.name
        subprocess.run(
            ["ocrmypdf", "--force-ocr", "--optimize", "0", "--quiet", path, out_pdf],
            capture_output=True, text=True, timeout=600, check=True,
        )
        txt = _pdftotext(out_pdf)
        os.unlink(out_pdf)
        return txt
    except Exception:
        return ""


_PRICE_RE = re.compile(r"\$")
_LEADTIME_RE = re.compile(r"\d+\s*(?:wk|wks|week|weeks)\b", re.IGNORECASE)

# Image attachments can only be read by the Step 9 vision pass, so flag
# them needs_vision=true — EXCEPT small decorative graphics (email
# signature logos, tracking pixels). A real photo / quote screenshot
# from a phone or scanner is comfortably above this; inline logos sit
# well below it. gif is treated as decorative regardless of size.
IMAGE_VISION_MIN_BYTES = 30_000
_IMAGE_EXTS = ("jpg", "jpeg", "png", "webp", "heic", "heif", "tif", "tiff")


def is_content_image(mime: str, filename: str, size: int) -> bool:
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    is_img = mime.startswith("image/") or ext in _IMAGE_EXTS
    if not is_img or mime == "image/gif":
        return False
    return size >= IMAGE_VISION_MIN_BYTES


def _page_is_relevant(page_text: str, known_items: set[str]) -> bool:
    if _PRICE_RE.search(page_text) or _LEADTIME_RE.search(page_text):
        return True
    low = page_text.lower()
    return any(name in low for name in known_items)


def extract_pdf(path: str, known_items: set[str]) -> dict:
    """Returns dict: extracted_text, extraction_method, needs_vision,
    page_count, kept_pages."""
    result = {
        "extracted_text": None,
        "extraction_method": None,
        "needs_vision": False,
        "page_count": pdf_page_count(path),
        "kept_pages": None,
    }
    text = _pdftotext(path)
    method = "pdftotext"
    if not text.strip():
        text = _ocr_then_text(path)
        method = "ocrmypdf+pdftotext" if text.strip() else "none"

    if not text.strip():
        # No text layer and OCR yielded nothing -> hand to vision later.
        result["needs_vision"] = True
        result["extraction_method"] = "none"
        return result

    pages = text.split("\f")
    # trailing empty page from a final form-feed
    if pages and not pages[-1].strip():
        pages = pages[:-1]
    n_pages = result["page_count"] or len(pages)

    if n_pages > 5:
        kept_idx, kept_text = [], []
        for i, pg in enumerate(pages, start=1):
            if _page_is_relevant(pg, known_items):
                kept_idx.append(i)
                kept_text.append(pg)
        result["kept_pages"] = kept_idx or None
        # If nothing matched, keep the full text rather than emit empty.
        result["extracted_text"] = ("\f".join(kept_text) if kept_text else text).strip()
    else:
        result["extracted_text"] = text.strip()

    result["extraction_method"] = method
    return result


# ------------------------------------------------------------------
# Gmail API
# ------------------------------------------------------------------
def gmail_access_token() -> str:
    cid = env("GMAIL_CLIENT_ID")
    secret = env("GMAIL_CLIENT_SECRET")
    refresh = env("ARIA_GMAIL_REFRESH_TOKEN")
    token_uri = env("GMAIL_TOKEN_URI") or DEFAULT_TOKEN_URI
    if not (cid and secret and refresh):
        raise SystemExit(
            "Gmail not configured: set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, "
            "ARIA_GMAIL_REFRESH_TOKEN in .env.local (rotated values — see "
            ".env.local.example)."
        )
    r = requests.post(
        token_uri,
        data={
            "client_id": cid,
            "client_secret": secret,
            "refresh_token": refresh,
            "grant_type": "refresh_token",
        },
        timeout=HTTP_TIMEOUT,
    )
    if not r.ok:
        raise SystemExit(f"Gmail token exchange failed ({r.status_code}): {r.text[:200]}")
    return r.json()["access_token"]


def gmail_list_message_ids(token: str, query: str, limit: int) -> list[str]:
    ids, page_token = [], None
    headers = {"Authorization": f"Bearer {token}"}
    while len(ids) < limit:
        params = {"q": query, "maxResults": min(100, limit - len(ids))}
        if page_token:
            params["pageToken"] = page_token
        r = requests.get(f"{GMAIL_API}/messages", headers=headers,
                          params=params, timeout=HTTP_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        ids.extend(m["id"] for m in data.get("messages", []))
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return ids[:limit]


def gmail_fetch_raw(token: str, gmail_id: str) -> bytes:
    r = requests.get(
        f"{GMAIL_API}/messages/{gmail_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"format": "raw"}, timeout=HTTP_TIMEOUT,
    )
    r.raise_for_status()
    return base64.urlsafe_b64decode(r.json()["raw"])


# ------------------------------------------------------------------
# Supabase REST + Storage (service role)
# ------------------------------------------------------------------
class Supabase:
    def __init__(self, url: str, key: str):
        self.url = url.rstrip("/")
        self.key = key
        self.h = {"apikey": key, "Authorization": f"Bearer {key}"}

    def existing_message_ids(self, message_ids: list[str]) -> set[str]:
        if not message_ids:
            return set()
        found = set()
        # chunk to keep the in.(...) filter URL a sane length
        for i in range(0, len(message_ids), 50):
            chunk = message_ids[i:i + 50]
            quoted = ",".join('"' + m.replace('"', '\\"') + '"' for m in chunk)
            r = requests.get(
                f"{self.url}/rest/v1/emails",
                headers=self.h,
                params={"select": "message_id", "message_id": f"in.({quoted})"},
                timeout=HTTP_TIMEOUT,
            )
            r.raise_for_status()
            found.update(row["message_id"] for row in r.json())
        return found

    def known_item_names(self) -> set[str]:
        """Distinctive item names + codes for the >5-page relevance
        filter. Bounded fetch; short/blank tokens dropped to avoid
        matching everything."""
        try:
            r = requests.get(
                f"{self.url}/rest/v1/items",
                headers={**self.h, "Range": "0-4999"},
                params={"select": "name,item_code"},
                timeout=HTTP_TIMEOUT,
            )
            r.raise_for_status()
        except Exception:
            return set()
        names = set()
        for row in r.json():
            for v in (row.get("name"), row.get("item_code")):
                if v and len(v.strip()) >= 4:
                    names.add(v.strip().lower())
        return names

    def insert_email(self, row: dict) -> str:
        r = requests.post(
            f"{self.url}/rest/v1/emails",
            headers={**self.h, "Content-Type": "application/json",
                     "Prefer": "return=representation"},
            json=row, timeout=HTTP_TIMEOUT,
        )
        if r.status_code == 409:
            raise DuplicateEmail(row["message_id"])
        r.raise_for_status()
        return r.json()[0]["id"]

    def insert_attachment(self, row: dict) -> None:
        r = requests.post(
            f"{self.url}/rest/v1/email_attachments",
            headers={**self.h, "Content-Type": "application/json"},
            json=row, timeout=HTTP_TIMEOUT,
        )
        r.raise_for_status()

    def update_email(self, email_id: str, patch: dict) -> None:
        r = requests.patch(
            f"{self.url}/rest/v1/emails",
            headers={**self.h, "Content-Type": "application/json"},
            params={"id": f"eq.{email_id}"}, json=patch, timeout=HTTP_TIMEOUT,
        )
        r.raise_for_status()

    def upload(self, key: str, data: bytes, content_type: str) -> str:
        r = requests.post(
            f"{self.url}/storage/v1/object/{ASSET_BUCKET}/{key}",
            headers={**self.h, "Content-Type": content_type, "x-upsert": "true"},
            data=data, timeout=HTTP_TIMEOUT,
        )
        r.raise_for_status()
        return key


class DuplicateEmail(Exception):
    pass


# ------------------------------------------------------------------
# Per-message processing
# ------------------------------------------------------------------
def decode_hdr(raw: str | None) -> str | None:
    """Decode an RFC 2047 encoded-word header (=?UTF-8?B?...?=) to plain
    text. Gmail returns Subject as-received, so multi-byte / non-ASCII
    subjects arrive encoded and must be decoded before storage."""
    if not raw:
        return None
    try:
        return str(make_header(decode_header(raw))).strip() or None
    except Exception:
        return raw.strip() or None


def header_message_id(msg: Message, fallback: str) -> str:
    mid = (msg.get("Message-ID") or msg.get("Message-Id") or "").strip()
    mid = mid.strip("<>").strip()
    return mid or fallback


def parse_from(msg: Message) -> str:
    addrs = getaddresses([msg.get("From", "")])
    return (addrs[0][1] if addrs else msg.get("From", "")).strip()


def received_at(msg: Message) -> str:
    for h in ("Date",):
        raw = msg.get(h)
        if raw:
            try:
                dt = parsedate_to_datetime(raw)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt.astimezone(timezone.utc).isoformat()
            except Exception:
                pass
    return datetime.now(timezone.utc).isoformat()


def iter_attachments(msg: Message):
    for part in msg.walk():
        if part.is_multipart():
            continue
        disp = (part.get("Content-Disposition") or "").lower()
        filename = part.get_filename()
        if "attachment" not in disp and not filename:
            continue
        payload = part.get_payload(decode=True)
        if payload is None:
            continue
        yield (filename or "attachment.bin",
               part.get_content_type() or "application/octet-stream",
               payload)


def process_message(raw: bytes, sb: Supabase | None, known_items: set[str],
                    gmail_id: str, dry_run: bool, verbose: bool) -> dict:
    msg = email.message_from_bytes(raw)
    message_id = header_message_id(msg, fallback=f"gmail:{gmail_id}")
    from_addr = parse_from(msg)
    subject = decode_hdr(msg.get("Subject"))

    skip_reason = should_skip(msg, from_addr, subject or "")
    body_md = best_body_markdown(msg)
    clean_text = clean_body(body_md)
    tok = estimate_tokens(clean_text)
    now = datetime.now(timezone.utc).isoformat()
    key_prefix = f"email-ingest/{hashlib.sha1(message_id.encode()).hexdigest()}"

    row = {
        "message_id": message_id,
        "thread_id": (msg.get("Thread-Index") or msg.get("References") or "").strip()[:255] or None,
        "from_addr": from_addr or "unknown@unknown",
        "subject": subject,
        "received_at": received_at(msg),
        "clean_text": clean_text,
        "token_estimate": tok,
        "status": "skipped" if skip_reason else "new",
    }
    if skip_reason:
        row["processed_at"] = now

    summary = {
        "message_id": message_id, "from": from_addr, "subject": subject,
        "status": row["status"], "skip_reason": skip_reason,
        "token_estimate": tok, "attachments": 0, "needs_vision": 0,
    }

    if dry_run or sb is None:
        summary["attachments"] = sum(1 for _ in iter_attachments(msg))
        return summary

    # upload raw .eml, then insert
    row["raw_ref"] = sb.upload(f"{key_prefix}/raw.eml", raw, "message/rfc822")
    try:
        email_id = sb.insert_email(row)
    except DuplicateEmail:
        summary["status"] = "duplicate"
        return summary

    # Skipped emails: don't spend OCR/vision effort on their attachments.
    if skip_reason:
        return summary

    for i, (filename, mime, data) in enumerate(iter_attachments(msg)):
        storage_ref = sb.upload(
            f"{key_prefix}/att-{i}-{slug(filename)}", data, mime)
        att = {
            "email_id": email_id, "filename": filename, "mime": mime,
            "storage_ref": storage_ref, "extracted_text": None,
            "extraction_method": None, "needs_vision": False,
            "page_count": None, "kept_pages": None,
        }
        if mime == "application/pdf" or filename.lower().endswith(".pdf"):
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tf:
                tf.write(data)
                tmp = tf.name
            try:
                pdf = extract_pdf(tmp, known_items)
            finally:
                os.unlink(tmp)
            att.update(pdf)
        elif is_content_image(mime, filename, len(data)):
            # No text layer to extract — hand to Step 9's vision pass.
            att["needs_vision"] = True
        sb.insert_attachment(att)
        summary["attachments"] += 1
        if att["needs_vision"]:
            summary["needs_vision"] += 1

    return summary


def slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9.\-]+", "-", name, flags=re.IGNORECASE)
    return re.sub(r"-+", "-", s).lower().strip("-") or "file"


# ------------------------------------------------------------------
# Offline self-test (no creds needed) — proves the pure functions
# ------------------------------------------------------------------
SAMPLE_EMAIL = """From: Dave Trader <dave@acmejoinery.com.au>
To: aria@reslu.com.au
Subject: Re: Goldsworthy kitchen — updated quote

Hi Aria,

Updated pricing below — the stone benchtop is now $136/m2 (was $128),
and the overhead cabinets have a lead time of 5 weeks.

Cheers,
Dave
Dave Trader | Acme Joinery
0400 000 000 | dave@acmejoinery.com.au
Sent from my iPhone

On Tue, 1 Jul 2026 at 09:14, Aria <aria@reslu.com.au> wrote:
> Hi Dave, can you send the updated quote for Goldsworthy?
> Thanks, Aria
"""


def run_selftest() -> int:
    print("=== SELF-TEST (offline, pure functions) ===")
    print(f"talon available: {_HAS_TALON}  (fallback: email_reply_parser)")
    clean = clean_body(SAMPLE_EMAIL.split("\n\n", 1)[1])  # body after headers
    print("\n--- clean_text ---")
    print(clean)
    tok = estimate_tokens(clean)
    checks = {
        "no quoted history (no '>' line, no 'On ... wrote:')":
            (">" not in clean) and ("wrote:" not in clean),
        "signature stripped (no sign-off, name, phone, or contact email)":
            all(s not in clean.lower() for s in
                ("sent from my iphone", "cheers", "acme joinery",
                 "0400 000 000", "dave@acmejoinery.com.au")),
        "prices survive ('$136' present)": "$136" in clean,
        "lead time survives ('5 weeks' present)": "5 weeks" in clean,
        f"token_estimate < 900 (got {tok})": tok < 900,
    }
    print("\n--- checks ---")
    ok = True
    for label, passed in checks.items():
        print(f"  [{'PASS' if passed else 'FAIL'}] {label}")
        ok = ok and passed
    print(f"\nRESULT: {'ALL PASS' if ok else 'FAILURES'}")
    return 0 if ok else 1


# ------------------------------------------------------------------
# Main
# ------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="RESLU Step 8 — email ingest + preprocessing")
    ap.add_argument("--limit", type=int, default=int(os.environ.get("LIMIT", "50")))
    ap.add_argument("--lookback-days", type=int, default=int(os.environ.get("LOOKBACK_DAYS", "2")))
    ap.add_argument("--query", default=os.environ.get("GMAIL_QUERY"),
                    help="override Gmail search query (default: in:inbox newer_than:Nd)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args()

    load_env()

    if args.selftest:
        return run_selftest()

    sup_url = env("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL")
    sup_key = env("SUPABASE_SERVICE_ROLE_KEY")
    if not (sup_url and sup_key):
        raise SystemExit(
            "Supabase not configured: set SUPABASE_URL (or "
            "NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY in "
            ".env.local."
        )
    sb = None if args.dry_run else Supabase(sup_url, sup_key)

    query = args.query or f"in:inbox newer_than:{args.lookback_days}d"
    token = gmail_access_token()
    gmail_ids = gmail_list_message_ids(token, query, args.limit)
    print(f"Gmail query {query!r}: {len(gmail_ids)} message(s) (limit {args.limit})")

    known_items = sb.known_item_names() if sb else set()
    if args.verbose:
        print(f"known item names loaded: {len(known_items)}")

    # Fetch raw first so we can dedupe by RFC Message-ID before writing.
    fetched = []  # (gmail_id, raw, message_id)
    for gid in gmail_ids:
        try:
            raw = gmail_fetch_raw(token, gid)
        except Exception as e:
            print(f"  ! fetch {gid} failed: {e}")
            continue
        msg = email.message_from_bytes(raw)
        mid = header_message_id(msg, fallback=f"gmail:{gid}")
        fetched.append((gid, raw, mid))

    seen = sb.existing_message_ids([m for _, _, m in fetched]) if sb else set()

    stats = {"new": 0, "skipped": 0, "duplicate": 0, "error": 0, "attachments": 0, "needs_vision": 0}
    for gid, raw, mid in fetched:
        if mid in seen:
            stats["duplicate"] += 1
            if args.verbose:
                print(f"  = dup   {mid}")
            continue
        try:
            s = process_message(raw, sb, known_items, gid, args.dry_run, args.verbose)
        except Exception as e:
            stats["error"] += 1
            print(f"  ! process {mid} failed: {e}")
            continue
        key = s["status"] if s["status"] in stats else "new"
        stats[key] = stats.get(key, 0) + 1
        stats["attachments"] += s.get("attachments", 0)
        stats["needs_vision"] += s.get("needs_vision", 0)
        flag = f" [SKIP: {s['skip_reason']}]" if s.get("skip_reason") else ""
        print(f"  {s['status']:9s} tok={s['token_estimate']:<5d} "
              f"att={s.get('attachments',0)} {s['from']:35.35s} "
              f"{(s['subject'] or '(no subject)'):40.40s}{flag}")

    print("\n=== summary ===")
    print(f"  new={stats['new']} skipped={stats['skipped']} "
          f"duplicate={stats['duplicate']} error={stats['error']} "
          f"attachments={stats['attachments']} needs_vision={stats['needs_vision']}")
    if args.dry_run:
        print("  (dry-run: nothing written)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
