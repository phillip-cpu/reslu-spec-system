import { PDFDocument } from "pdf-lib";
import type { SupabaseClient } from "@supabase/supabase-js";
import { callClaude, type ClaudeContentBlock, type ClaudeTool } from "@/lib/second-brain/claude";
import { ASSET_BUCKET } from "@/lib/storage";

/**
 * RESLU Second Brain, Step 9 (docs/RESLU-second-brain-build-brief.md).
 * Extraction: Sonnet, one email at a time (unlike triage, this isn't
 * batched — the brief's own acceptance criterion tests a single seeded
 * email, and the schema is detailed enough per-email that batching
 * would blow past a reasonable output budget).
 *
 * source_quote is mandatory on every fact per the brief — Step 11's
 * (not yet built) verification gate depends on it matching verbatim
 * against clean_text or an attachment's extracted_text.
 *
 * attachment_transcriptions is an addition beyond the brief's literal
 * schema: for a needs_vision=true attachment, extracted_text is null
 * by construction (no text layer ever recovered) — there is nothing
 * for Step 11's verification gate to check a vision-derived
 * source_quote against. Having the SAME call that reads the image/PDF
 * also transcribe what it sees gives that gate real text to verify
 * against, for every fact regardless of source. See this migration's
 * sibling, supabase/migrations/038_email_extraction.sql, and the
 * extractEmail() doc comment below for how this gets persisted.
 */

export const EXTRACTION_MODEL = "claude-sonnet-5";

const EXTRACTION_SYSTEM_PROMPT = `You are the extraction step for RESLU, an interior design and design-build studio in Adelaide, South Australia. You are given ONE actionable email (already triaged as worth extracting from) — its cleaned body text, and optionally one or more attachments (images or PDF documents) that arrived with it.

Extract every price fact, lead-time fact, job/project mention, item/product mention, requested action, and supplier invoice candidate you can find, following the exact schema given by the extract_email tool. Rules:

- EVERY fact (price_facts, lead_time_facts, job_mentions, item_mentions, actions_requested) MUST carry a source_quote — an EXACT, VERBATIM substring copied character-for-character from the email body text or from an attachment. Do not paraphrase, summarise, or reconstruct a quote from memory — copy it directly. A fact with no genuine verbatim quote to point to should not be included at all.
- If an attachment is included, ALSO transcribe the relevant text/prices/lead-times you can read from it into attachment_transcriptions, one entry per attachment you were given (identified by the attachment_id provided), so that facts sourced from that attachment can have a source_quote that matches something on record. Transcribe accurately — this transcription itself becomes the "source of truth" your own source_quotes for that attachment will be checked against.
- Never invent a project/job name, item name, price, or lead time that isn't genuinely present in the text or attachment. If nothing extractable is present, return empty arrays — do not force a fact to justify calling the tool.
- confidence is your overall confidence (0.0-1.0) in this extraction as a whole, not per-fact.
- Currency defaults to AUD unless the text says otherwise. gst_inclusive should be your best read of whether the stated price includes GST — if genuinely ambiguous, use null rather than guessing.
- When the message or attachment is an invoice, tax invoice, credit note, or payment request issued by a supplier/trade, populate supplier_invoice. This is only a review candidate: never infer that it is approved or paid. Do not also turn the invoice total into a price_fact; price_facts are product/service price intelligence, while supplier_invoice records the financial document itself.

Call the extract_email tool exactly once.`;

const FACT_WITH_QUOTE = (extra: Record<string, unknown>) => ({
  type: "object",
  properties: { ...extra, source_quote: { type: "string" } },
  required: [...Object.keys(extra), "source_quote"],
  additionalProperties: false,
});

const EXTRACTION_TOOL: ClaudeTool = {
  name: "extract_email",
  description: "Record every extracted fact from this email (and any attachments), each with a mandatory verbatim source_quote.",
  input_schema: {
    type: "object",
    properties: {
      job_mentions: { type: "array", items: FACT_WITH_QUOTE({ text: { type: "string" } }) },
      item_mentions: { type: "array", items: FACT_WITH_QUOTE({ text: { type: "string" } }) },
      price_facts: {
        type: "array",
        items: FACT_WITH_QUOTE({
          item_text: { type: "string" },
          value: { type: "number" },
          currency: { type: "string" },
          unit: { type: "string" },
          gst_inclusive: { type: ["boolean", "null"] },
          effective_date: { type: ["string", "null"] },
        }),
      },
      lead_time_facts: {
        type: "array",
        items: FACT_WITH_QUOTE({ item_text: { type: "string" }, value_weeks: { type: "number" } }),
      },
      actions_requested: { type: "array", items: FACT_WITH_QUOTE({ description: { type: "string" } }) },
      supplier_invoice: {
        anyOf: [
          {
            type: "object",
            properties: {
              supplier: { type: "string" },
              abn: { type: ["string", "null"] },
              invoice_number: { type: ["string", "null"] },
              invoice_date: { type: ["string", "null"] },
              amount_ex_gst: { type: ["number", "null"] },
              gst: { type: ["number", "null"] },
              total: { type: "number" },
              job_hints: { type: ["string", "null"] },
              line_hints: { type: ["string", "null"] },
              source_quote: { type: "string" },
            },
            required: [
              "supplier",
              "abn",
              "invoice_number",
              "invoice_date",
              "amount_ex_gst",
              "gst",
              "total",
              "job_hints",
              "line_hints",
              "source_quote"
            ],
            additionalProperties: false,
          },
          { type: "null" },
        ],
      },
      attachment_transcriptions: {
        type: "array",
        items: {
          type: "object",
          properties: { attachment_id: { type: "string" }, text: { type: "string" } },
          required: ["attachment_id", "text"],
          additionalProperties: false,
        },
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["job_mentions", "item_mentions", "price_facts", "lead_time_facts", "actions_requested", "supplier_invoice", "attachment_transcriptions", "confidence"],
    additionalProperties: false,
  },
};

export type ExtractionAttachment = {
  id: string;
  filename: string | null;
  mime: string | null;
  storage_ref: string | null;
  needs_vision: boolean;
  kept_pages: number[] | null;
};

export type ExtractionResult = {
  job_mentions: { text: string; source_quote: string }[];
  item_mentions: { text: string; source_quote: string }[];
  price_facts: {
    item_text: string;
    value: number;
    currency: string;
    unit: string;
    gst_inclusive: boolean | null;
    effective_date: string | null;
    source_quote: string;
  }[];
  lead_time_facts: { item_text: string; value_weeks: number; source_quote: string }[];
  actions_requested: { description: string; source_quote: string }[];
  supplier_invoice: {
    supplier: string;
    abn: string | null;
    invoice_number: string | null;
    invoice_date: string | null;
    amount_ex_gst: number | null;
    gst: number | null;
    total: number;
    job_hints: string | null;
    line_hints: string | null;
    source_quote: string;
  } | null;
  attachment_transcriptions: { attachment_id: string; text: string }[];
  confidence: number;
};

/** Subsets a PDF to just `pages` (1-indexed, matching Step 8's kept_pages convention) when given; returns the original bytes unchanged otherwise. */
async function subsetPdfPages(bytes: Uint8Array, pages: number[] | null): Promise<Uint8Array> {
  if (!pages || pages.length === 0) return bytes;
  const src = await PDFDocument.load(bytes);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(
    src,
    pages.map((p) => p - 1).filter((i) => i >= 0 && i < src.getPageCount())
  );
  copied.forEach((page) => out.addPage(page));
  return out.save();
}

const CLAUDE_IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const EXT_TO_MEDIA_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Some email clients send image attachments with a generic/incorrect
 * Content-Type (observed live: real .jpeg attachments stored with
 * mime='application/octet-stream' by Step 8's ingest, which stores
 * whatever Content-Type the message itself declared) — Claude's
 * vision API only accepts image/jpeg|png|gif|webp and correctly
 * rejects anything else with a 400. Falls back to the filename
 * extension when the stored mime isn't one of those four; returns
 * null (skip this attachment) if neither the mime nor the extension
 * resolve to a real image type, rather than sending something Claude
 * will reject.
 */
function resolveImageMediaType(mime: string | null, filename: string | null): string | null {
  if (mime && CLAUDE_IMAGE_MEDIA_TYPES.has(mime)) return mime;
  const ext = filename?.split(".").pop()?.toLowerCase();
  return (ext && EXT_TO_MEDIA_TYPE[ext]) ?? null;
}

async function buildVisionBlocks(
  supabase: SupabaseClient,
  attachments: ExtractionAttachment[]
): Promise<ClaudeContentBlock[]> {
  const blocks: ClaudeContentBlock[] = [];
  for (const att of attachments) {
    if (!att.needs_vision || !att.storage_ref || !att.mime) continue;
    const { data, error } = await supabase.storage.from(ASSET_BUCKET).download(att.storage_ref);
    if (error || !data) {
      console.error("extraction: failed to download attachment", att.id, error?.message);
      continue;
    }
    const bytes = new Uint8Array(await data.arrayBuffer());

    if (att.mime === "application/pdf") {
      blocks.push({ type: "text", text: `<attachment id="${att.id}" filename="${att.filename ?? ""}">` });
      const subset = await subsetPdfPages(bytes, att.kept_pages);
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: Buffer.from(subset).toString("base64") },
      });
      blocks.push({ type: "text", text: `</attachment>` });
    } else {
      const mediaType = resolveImageMediaType(att.mime, att.filename);
      if (!mediaType) {
        console.error("extraction: unrecognized image type, skipping attachment", att.id, att.mime, att.filename);
        continue;
      }
      blocks.push({ type: "text", text: `<attachment id="${att.id}" filename="${att.filename ?? ""}">` });
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: Buffer.from(bytes).toString("base64") },
      });
      blocks.push({ type: "text", text: `</attachment>` });
    }
  }
  return blocks;
}

export async function extractEmail(
  supabase: SupabaseClient,
  email: { id: string; from_addr: string; subject: string | null; clean_text: string | null },
  attachments: ExtractionAttachment[]
): Promise<{ result: ExtractionResult; usage: Record<string, unknown> }> {
  const visionBlocks = await buildVisionBlocks(supabase, attachments);

  const content: ClaudeContentBlock[] = [
    {
      type: "text",
      text: `From: ${email.from_addr}\nSubject: ${email.subject ?? "(no subject)"}\n\n${email.clean_text ?? "(no body text)"}`,
    },
    ...visionBlocks,
  ];

  const { toolInput, usage } = await callClaude({
    model: EXTRACTION_MODEL,
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    tool: EXTRACTION_TOOL,
    maxTokens: 4096,
  });

  return { result: toolInput as ExtractionResult, usage };
}
