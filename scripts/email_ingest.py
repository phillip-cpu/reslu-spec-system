#!/usr/bin/env python3
# ============================================================
# RESLU Spec System — Step 8: Email ingest + preprocessing
# (Second Brain — docs/SECOND-BRAIN.md §"Step 8").
#
# Runs on Aria's Mac mini ONLY (not Vercel): it needs real mailbox
# access (Gmail API for aria@, phillip@ and tenille@reslu.com.au) and local binaries
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
#   1. Fetch received + sent mail from all three already-authorised
#      RESLU Gmail accounts. OAuth comes from OpenClaw's per-account
#      token files + shared gmail/credentials.json, never copied env
#      secrets. Dedupe on RFC Message-ID across mailboxes and preserve
#      every mailbox/Gmail-id reference on the canonical email row.
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
#   4. Hard-rule skip newsletters / auto-replies / ordinary noreply
#      notifications, but RETAIN transactional automated emails with
#      invoice/receipt/order evidence (e.g. Bunnings donotreply).
#      Everything else is left at status='new' for Step 9 triage.
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
#   OPENCLAW_WORKSPACE (optional; defaults ~/.openclaw/workspace)
#   GMAIL_CREDENTIALS_FILE (optional path override)
#   ARIA_GMAIL_TOKEN_FILE, PHILLIP_GMAIL_TOKEN_FILE,
#   TENILLE_GMAIL_TOKEN_FILE (optional per-account path overrides)
#
# Usage (run from anywhere; env is read relative to this file):
#   .venv-email-ingest/bin/python scripts/email_ingest.py            # normal pass
#   ... scripts/email_ingest.py --limit 20                           # cap fetched msgs (acceptance)
#   ... scripts/email_ingest.py --lookback-days 3                    # all 3 accounts
#   ... scripts/email_ingest.py --mailbox phillip@reslu.com.au       # one account
#   ... scripts/email_ingest.py --dry-run                            # fetch+process, write nothing
#   ... scripts/email_ingest.py --selftest                           # offline: run pure fns on samples
# ============================================================

import argparse
import base64
import email
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
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

EXPECTED_MAILBOXES = (
    ("aria@reslu.com.au", "aria-gmail/token.json", "ARIA_GMAIL_TOKEN_FILE"),
    ("phillip@reslu.com.au", "phillip-gmail/token.json", "PHILLIP_GMAIL_TOKEN_FILE"),
    ("tenille@reslu.com.au", "tenille-gmail/token.json", "TENILLE_GMAIL_TOKEN_FILE"),
)


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


@dataclass(frozen=True)
class MailboxConfig:
    address: str
    token_file: Path


@dataclass(frozen=True)
class GmailMessage:
    mailbox: str
    gmail_id: str
    raw: bytes
    message_id: str
    direction: str


def openclaw_workspace() -> Path:
    return Path(
        env("OPENCLAW_WORKSPACE") or str(Path.home() / ".openclaw" / "workspace")
    ).expanduser()


def gmail_credentials_file() -> Path:
    configured = env("GMAIL_CREDENTIALS_FILE")
    return (
        Path(configured).expanduser()
        if configured
        else openclaw_workspace() / "gmail" / "credentials.json"
    )


def mailbox_configs(selected: list[str] | None = None) -> list[MailboxConfig]:
    wanted = {address.lower() for address in selected or []}
    known = {address for address, _, _ in EXPECTED_MAILBOXES}
    unknown = wanted - known
    if unknown:
        raise SystemExit(
            "Unknown mailbox selection: " + ", ".join(sorted(unknown))
        )

    workspace = openclaw_workspace()
    result = []
    for address, relative_path, override_env in EXPECTED_MAILBOXES:
        if wanted and address not in wanted:
            continue
        override = env(override_env)
        token_file = Path(override).expanduser() if override else workspace / relative_path
        result.append(MailboxConfig(address=address, token_file=token_file))
    return result


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
_AUTOMATED_SENDER = re.compile(
    r"(no[._-]?reply|do[._-]?not[._-]?reply|donotreply|notification|"
    r"mailer-daemon|postmaster|bounce)",
    re.IGNORECASE,
)
_BOUNCE_SENDER = re.compile(r"(mailer-daemon|postmaster|bounce)", re.IGNORECASE)
_TRANSACTIONAL_SUBJECT = re.compile(
    r"\b(invoice|tax invoice|credit note|receipt|remittance|statement|"
    r"order confirmation|online order|purchase order|payment confirmation)\b",
    re.IGNORECASE,
)
_DOCUMENT_EXTENSIONS = (".pdf", ".csv", ".xlsx", ".xls", ".docx")


def has_business_document_attachment(msg: Message) -> bool:
    for part in msg.walk():
        filename = decode_hdr(part.get_filename())
        mime = (part.get_content_type() or "").lower()
        if filename and filename.lower().endswith(_DOCUMENT_EXTENSIONS):
            return True
        if mime in (
            "application/pdf",
            "text/csv",
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ):
            return True
    return False


def is_transactional_business_email(msg: Message, subject: str) -> bool:
    return bool(_TRANSACTIONAL_SUBJECT.search(subject or "")) or has_business_document_attachment(msg)


def should_skip(msg: Message, from_addr: str, subject: str) -> str | None:
    """Return a short reason string if this email should be skipped,
    else None."""
    # Bounces and out-of-office replies are never business evidence.
    if _BOUNCE_SENDER.search(from_addr or ""):
        return "bounce sender"
    subj = (subject or "").strip().lower()
    if subj.startswith(("out of office", "automatic reply", "auto:", "autoreply")):
        return "out-of-office subject"

    # Transactional automated mail is common supplier evidence. A Bunnings
    # invoice from donotreply@orders.bunnings.com.au must reach triage, while
    # an ordinary no-reply notification can still be dropped here.
    transactional = is_transactional_business_email(msg, subject)
    if _AUTOMATED_SENDER.search(from_addr or "") and not transactional:
        return "noreply sender"
    # RFC 3834 auto-replies / auto-generated
    auto = (msg.get("Auto-Submitted") or "").lower()
    if auto and auto != "no" and not transactional:
        return f"auto-submitted:{auto}"
    if msg.get("X-Autoreply") or msg.get("X-Autorespond"):
        return "auto-reply header"
    prec = (msg.get("Precedence") or "").lower()
    if prec in ("bulk", "list", "auto_reply", "junk") and not transactional:
        return f"precedence:{prec}"
    # newsletters / bulk lists
    if (msg.get("List-Unsubscribe") or msg.get("List-Id")) and not transactional:
        return "mailing list"
    if (
        msg.get("X-Campaign") or msg.get("X-Mailgun-Sid") or msg.get("X-Mailchimp-Id")
    ) and not transactional:
        return "bulk campaign"
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
def read_json_file(path: Path, label: str) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError(f"{label} file not found: {path}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"{label} file is unreadable: {path}") from exc
    if not isinstance(data, dict):
        raise RuntimeError(f"{label} file must contain a JSON object: {path}")
    return data


def oauth_client_config(credentials_file: Path) -> dict:
    data = read_json_file(credentials_file, "Gmail credentials")
    nested = data.get("installed") or data.get("web") or data
    if not isinstance(nested, dict):
        raise RuntimeError(f"Gmail credentials file has no installed/web client: {credentials_file}")
    return nested


def gmail_access_token(mailbox: MailboxConfig, credentials_file: Path) -> str:
    """Refresh one mailbox using its existing OpenClaw token file.

    The scheduled worker deliberately does not use GMAIL_CLIENT_SECRET or
    ARIA_GMAIL_REFRESH_TOKEN from .env.local. Those legacy values belong to
    the app's Gmail send helper and caused the production ingest outage when
    the copied client secret became invalid. The already-authorised token
    files are the mailbox source of truth here.
    """
    token_data = read_json_file(mailbox.token_file, f"{mailbox.address} token")
    client = oauth_client_config(credentials_file)
    client_id = client.get("client_id") or token_data.get("client_id")
    client_secret = client.get("client_secret") or token_data.get("client_secret")
    refresh_token = token_data.get("refresh_token")
    token_uri = token_data.get("token_uri") or client.get("token_uri") or DEFAULT_TOKEN_URI
    if not (client_id and client_secret and refresh_token):
        raise RuntimeError(
            f"{mailbox.address} OAuth files are missing client_id, client_secret or refresh_token"
        )

    response = requests.post(
        token_uri,
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        },
        timeout=HTTP_TIMEOUT,
    )
    if not response.ok:
        try:
            detail = response.json().get("error_description") or response.json().get("error")
        except Exception:
            detail = "token refresh rejected"
        raise RuntimeError(
            f"{mailbox.address} token refresh failed ({response.status_code}): {detail}"
        )
    access_token = response.json().get("access_token")
    if not access_token:
        raise RuntimeError(f"{mailbox.address} token refresh returned no access token")
    return access_token


def gmail_profile_email(token: str) -> str:
    response = requests.get(
        f"{GMAIL_API}/profile",
        headers={"Authorization": f"Bearer {token}"},
        timeout=HTTP_TIMEOUT,
    )
    response.raise_for_status()
    return str(response.json().get("emailAddress") or "").strip().lower()


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


def gmail_fetch_raw(token: str, gmail_id: str) -> tuple[bytes, set[str]]:
    r = requests.get(
        f"{GMAIL_API}/messages/{gmail_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"format": "raw"}, timeout=HTTP_TIMEOUT,
    )
    r.raise_for_status()
    payload = r.json()
    return (
        base64.urlsafe_b64decode(payload["raw"]),
        {str(label).upper() for label in payload.get("labelIds", [])},
    )


def gmail_direction(labels: set[str]) -> str:
    # An archived inbound message has neither INBOX nor SENT; it is still
    # inbound. A self-addressed message can carry both labels and should be
    # treated inbound so it remains eligible for Second Brain triage.
    return "sent" if "SENT" in labels and "INBOX" not in labels else "inbound"


# ------------------------------------------------------------------
# Supabase REST + Storage (service role)
# ------------------------------------------------------------------
class Supabase:
    def __init__(self, url: str, key: str):
        self.url = url.rstrip("/")
        self.key = key
        self.h = {"apikey": key, "Authorization": f"Bearer {key}"}

    def existing_emails(self, message_ids: list[str]) -> dict[str, dict]:
        if not message_ids:
            return {}
        found = {}
        # chunk to keep the in.(...) filter URL a sane length
        for i in range(0, len(message_ids), 50):
            chunk = message_ids[i:i + 50]
            quoted = ",".join('"' + m.replace('"', '\\"') + '"' for m in chunk)
            r = requests.get(
                f"{self.url}/rest/v1/emails",
                headers=self.h,
                params={
                    "select": "id,message_id,direction,ingested_mailboxes,gmail_refs",
                    "message_id": f"in.({quoted})",
                },
                timeout=HTTP_TIMEOUT,
            )
            r.raise_for_status()
            for row in r.json():
                found[row["message_id"]] = row
        return found

    def merge_email_source(
        self, existing: dict, mailbox: str, gmail_id: str, direction: str
    ) -> dict:
        mailboxes = {
            str(value).strip().lower()
            for value in (existing.get("ingested_mailboxes") or [])
            if value
        }
        mailboxes.add(mailbox.lower())
        refs = dict(existing.get("gmail_refs") or {})
        refs[mailbox.lower()] = gmail_id
        merged_direction = (
            "inbound"
            if "inbound" in (existing.get("direction"), direction)
            else "sent"
        )
        patch = {
            "ingested_mailboxes": sorted(mailboxes),
            "gmail_refs": refs,
            "direction": merged_direction,
        }
        if (
            patch["ingested_mailboxes"] != existing.get("ingested_mailboxes")
            or patch["gmail_refs"] != existing.get("gmail_refs")
            or patch["direction"] != existing.get("direction")
        ):
            self.update_email(existing["id"], patch)
        return {**existing, **patch}

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


def process_message(
    raw: bytes,
    sb: Supabase | None,
    known_items: set[str],
    gmail_id: str,
    mailbox: str,
    direction: str,
    dry_run: bool,
    verbose: bool,
) -> dict:
    msg = email.message_from_bytes(raw)
    message_id = header_message_id(msg, fallback=f"gmail:{mailbox}:{gmail_id}")
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
        "direction": direction,
        "ingested_mailboxes": [mailbox],
        "gmail_refs": {mailbox: gmail_id},
        "status": "skipped" if skip_reason else "new",
    }
    if skip_reason:
        row["processed_at"] = now

    summary = {
        "message_id": message_id, "from": from_addr, "subject": subject,
        "mailbox": mailbox, "direction": direction,
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
    summary["email_id"] = email_id

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
            "content_sha256": hashlib.sha256(data).hexdigest(),
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
    bunnings = email.message_from_string(
        "From: donotreply@orders.bunnings.com.au\n"
        "Subject: Bunnings Online Order - Invoice\n\n"
        "Invoice attached."
    )
    generic_noreply = email.message_from_string(
        "From: notifications@example.com\nSubject: Account notice\n\nHello"
    )
    newsletter = email.message_from_string(
        "From: studio@example.com\nSubject: July news\n"
        "List-Unsubscribe: <https://example.com/unsubscribe>\n\nHello"
    )
    fake_supabase = Supabase("https://example.supabase.co", "test-key")
    fake_supabase.update_email = lambda _email_id, _patch: None
    merged_source = fake_supabase.merge_email_source(
        {
            "id": "email-1",
            "direction": "sent",
            "ingested_mailboxes": ["phillip@reslu.com.au"],
            "gmail_refs": {"phillip@reslu.com.au": "sent-1"},
        },
        "aria@reslu.com.au",
        "inbound-1",
        "inbound",
    )
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
        "Bunnings donotreply invoice is retained":
            should_skip(bunnings, "donotreply@orders.bunnings.com.au", bunnings["Subject"]) is None,
        "ordinary automated notification is skipped":
            should_skip(generic_noreply, "notifications@example.com", generic_noreply["Subject"])
            == "noreply sender",
        "newsletter is skipped":
            should_skip(newsletter, "studio@example.com", newsletter["Subject"])
            == "mailing list",
        "Gmail direction keeps archived mail inbound": gmail_direction(set()) == "inbound",
        "Gmail direction recognises Sent": gmail_direction({"SENT"}) == "sent",
        "all three RESLU mailboxes are configured":
            {address for address, _, _ in EXPECTED_MAILBOXES}
            == {"aria@reslu.com.au", "phillip@reslu.com.au", "tenille@reslu.com.au"},
        "cross-mailbox duplicate records both sources":
            merged_source["ingested_mailboxes"]
            == ["aria@reslu.com.au", "phillip@reslu.com.au"],
        "an inbound copy upgrades a sent-only canonical row":
            merged_source["direction"] == "inbound",
    }
    print("\n--- checks ---")
    ok = True
    for label, passed in checks.items():
        print(f"  [{'PASS' if passed else 'FAIL'}] {label}")
        ok = ok and passed
    print(f"\nRESULT: {'ALL PASS' if ok else 'FAILURES'}")
    return 0 if ok else 1


def process_fetched_messages(
    messages: list[GmailMessage],
    sb: Supabase | None,
    known_items: set[str],
    dry_run: bool,
    verbose: bool,
    existing: dict[str, dict],
    dry_seen: set[str],
    stats: dict[str, int],
) -> None:
    for message in messages:
        current = existing.get(message.message_id)
        if current or message.message_id in dry_seen:
            stats["duplicate"] += 1
            if verbose:
                print(f"  = dup   {message.message_id} [{message.mailbox}]")
            if sb and current:
                try:
                    existing[message.message_id] = sb.merge_email_source(
                        current,
                        message.mailbox,
                        message.gmail_id,
                        message.direction,
                    )
                except Exception as exc:
                    stats["error"] += 1
                    print(f"  ! merge {message.message_id} failed: {exc}")
            continue
        try:
            summary = process_message(
                message.raw,
                sb,
                known_items,
                message.gmail_id,
                message.mailbox,
                message.direction,
                dry_run,
                verbose,
            )
        except Exception as exc:
            stats["error"] += 1
            print(f"  ! process {message.message_id} failed: {exc}")
            continue
        dry_seen.add(message.message_id)
        if summary.get("email_id"):
            existing[message.message_id] = {
                "id": summary["email_id"],
                "message_id": message.message_id,
                "direction": message.direction,
                "ingested_mailboxes": [message.mailbox],
                "gmail_refs": {message.mailbox: message.gmail_id},
            }
        elif summary.get("status") == "duplicate" and sb:
            # A concurrent run may have inserted between the initial lookup
            # and this message. Merge the mailbox provenance after the race.
            raced = sb.existing_emails([message.message_id]).get(message.message_id)
            if raced:
                existing[message.message_id] = sb.merge_email_source(
                    raced,
                    message.mailbox,
                    message.gmail_id,
                    message.direction,
                )
        key = summary["status"] if summary["status"] in stats else "new"
        stats[key] = stats.get(key, 0) + 1
        stats["attachments"] += summary.get("attachments", 0)
        stats["needs_vision"] += summary.get("needs_vision", 0)
        flag = (
            f" [SKIP: {summary['skip_reason']}]"
            if summary.get("skip_reason")
            else ""
        )
        print(
            f"  {summary['status']:9s} tok={summary['token_estimate']:<5d} "
            f"att={summary.get('attachments', 0)} {summary['mailbox']:24.24s} "
            f"{summary['direction']:7s} {summary['from']:35.35s} "
            f"{(summary['subject'] or '(no subject)'):40.40s}{flag}"
        )


# ------------------------------------------------------------------
# Main
# ------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="RESLU Step 8 — email ingest + preprocessing")
    # The scheduled scan runs every ten minutes and deduplicates against
    # stored Message-IDs. A 250-message ceiling leaves enough headroom for a
    # busy shared mailbox without making ordinary runs do any extra writes.
    ap.add_argument("--limit", type=int, default=int(os.environ.get("LIMIT", "250")))
    ap.add_argument("--lookback-days", type=int, default=int(os.environ.get("LOOKBACK_DAYS", "2")))
    ap.add_argument("--query", default=os.environ.get("GMAIL_QUERY"),
                    help="override Gmail search query (default: received + sent, excluding spam/trash/drafts)")
    ap.add_argument(
        "--mailbox",
        action="append",
        help="limit a run to one expected mailbox; repeat to select more than one",
    )
    ap.add_argument(
        "--credentials-file",
        help="override the shared Gmail OAuth credentials.json path",
    )
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args()

    load_env()

    if args.selftest:
        return run_selftest()

    sup_url = env("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL")
    sup_key = env("SUPABASE_SERVICE_ROLE_KEY")
    if not args.dry_run and not (sup_url and sup_key):
        raise SystemExit(
            "Supabase not configured: set SUPABASE_URL (or "
            "NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY in "
            ".env.local."
        )
    sb = None if args.dry_run else Supabase(sup_url, sup_key)

    query = args.query or (
        f"newer_than:{args.lookback_days}d -in:spam -in:trash -in:drafts"
    )
    credentials_file = (
        Path(args.credentials_file).expanduser()
        if args.credentials_file
        else gmail_credentials_file()
    )
    mailboxes = mailbox_configs(args.mailbox)

    known_items = sb.known_item_names() if sb else set()
    if args.verbose:
        print(f"known item names loaded: {len(known_items)}")

    # Fetch every account independently. One bad token is reported but does
    # not prevent the healthy mailboxes from being ingested in the same run.
    stats = {
        "new": 0,
        "skipped": 0,
        "duplicate": 0,
        "error": 0,
        "auth_error": 0,
        "attachments": 0,
        "needs_vision": 0,
        "mailboxes_ok": 0,
    }
    existing: dict[str, dict] = {}
    dry_seen: set[str] = set()
    fetch_chunk_size = 25
    for mailbox in mailboxes:
        try:
            token = gmail_access_token(mailbox, credentials_file)
            profile_email = gmail_profile_email(token)
            if profile_email != mailbox.address:
                raise RuntimeError(
                    f"token belongs to {profile_email or 'an unknown account'}, expected {mailbox.address}"
                )
            gmail_ids = gmail_list_message_ids(token, query, args.limit)
            stats["mailboxes_ok"] += 1
            print(
                f"[{mailbox.address}] Gmail query {query!r}: "
                f"{len(gmail_ids)} message(s) (limit {args.limit})"
            )
        except Exception as exc:
            stats["auth_error"] += 1
            print(f"  ! {mailbox.address} unavailable: {exc}")
            continue

        # Raw messages can contain large PDFs. Fetch/process in bounded chunks
        # so the 30-day backfill never holds hundreds of attachments in memory.
        for offset in range(0, len(gmail_ids), fetch_chunk_size):
            fetched: list[GmailMessage] = []
            for gid in gmail_ids[offset:offset + fetch_chunk_size]:
                try:
                    raw, labels = gmail_fetch_raw(token, gid)
                except Exception as exc:
                    stats["error"] += 1
                    print(f"  ! {mailbox.address} fetch {gid} failed: {exc}")
                    continue
                msg = email.message_from_bytes(raw)
                mid = header_message_id(
                    msg, fallback=f"gmail:{mailbox.address}:{gid}"
                )
                fetched.append(
                    GmailMessage(
                        mailbox=mailbox.address,
                        gmail_id=gid,
                        raw=raw,
                        message_id=mid,
                        direction=gmail_direction(labels),
                    )
                )

            if sb:
                unknown_ids = [
                    message.message_id
                    for message in fetched
                    if message.message_id not in existing
                ]
                if unknown_ids:
                    existing.update(sb.existing_emails(unknown_ids))
            process_fetched_messages(
                fetched,
                sb,
                known_items,
                args.dry_run,
                args.verbose,
                existing,
                dry_seen,
                stats,
            )

    print("\n=== summary ===")
    print(f"  new={stats['new']} skipped={stats['skipped']} "
          f"duplicate={stats['duplicate']} error={stats['error']} "
          f"auth_error={stats['auth_error']} mailboxes_ok={stats['mailboxes_ok']}/{len(mailboxes)} "
          f"attachments={stats['attachments']} needs_vision={stats['needs_vision']}")
    if args.dry_run:
        print("  (dry-run: nothing written)")
    return 1 if stats["auth_error"] or stats["error"] else 0


if __name__ == "__main__":
    sys.exit(main())
