import { callClaude, type ClaudeTool } from "@/lib/second-brain/claude";

/**
 * RESLU Second Brain, Step 9 (docs/RESLU-second-brain-build-brief.md).
 * Triage: Haiku, batched (up to 20 emails per call per the brief),
 * cached system prompt. The label definitions below are written out
 * in full (not just enumerated) specifically so the system prompt
 * comfortably clears Anthropic's cacheable-prefix minimum ("≥1,024
 * tokens" per the brief) — the detail also genuinely improves triage
 * accuracy, it isn't padding for its own sake.
 */

export const TRIAGE_MODEL = "claude-haiku-4-5";

export const TRIAGE_LABELS = [
  "supplier_quote",
  "price_update",
  "lead_time_update",
  "client_rfi",
  "approval",
  "follow_up",
  "fyi",
  "noise",
] as const;

export type TriageLabel = (typeof TRIAGE_LABELS)[number];

export const NON_ACTIONABLE_LABELS: TriageLabel[] = ["fyi", "noise"];

const TRIAGE_SYSTEM_PROMPT = `You are the mail triage step for RESLU, an interior design and design-build studio based in Adelaide, South Australia. RESLU runs full-service residential and light-commercial projects: initial client leads, design development, a spec register of specified FF&E items (furniture, fixtures, fittings — tapware, tiles, joinery hardware, appliances, stone, and similar), a scope-of-works document per project, and construction-phase trade coordination (site visits, bookings, confirmations). The studio deals daily with suppliers (tile houses, tapware brands, joinery/cabinetry makers, stone yards, appliance distributors) and trades (plumbers, electricians, carpenters, tilers) as well as directly with clients.

You will be given a batch of inbound emails (each with an id, sender address, subject, and cleaned body text — quoted reply history and email signatures have already been stripped before you see them, so do not expect to see prior thread context or sign-offs). For every email in the batch, assign exactly one label from the fixed list below, plus a confidence score from 0.0 (pure guess) to 1.0 (certain).

Label definitions, each with the kind of email you should expect to see:

- "supplier_quote" — a trade or supplier has sent a formal quote, quotation, or costed proposal in response to a request RESLU made. Examples: a joinery workshop quoting a costed price for a custom vanity unit; a tapware distributor replying to a pricing enquiry with a line-itemed quote; a tiler quoting labour + supply for a bathroom. The defining feature is that specific dollar figures are being PROPOSED for a SPECIFIC job, usually in direct response to something RESLU asked for. Distinct from price_update below — a supplier_quote is a new, one-off costed proposal tied to a particular project or request, not a blanket notice about an existing product line's price changing for everyone.

- "price_update" — a supplier or trade is proactively notifying that the price of one or more specific, already-known/standard products or services has changed, independent of any particular project. Examples: "our laminate range increases 4% from 1 August"; "Polytec Ravine benchtop laminate is now $136 per square metre, up from $128, effective 1 August 2026"; "please note GST-inclusive pricing on our tapware range has been revised". This is a blanket notice, not a response to a specific quote request.

- "lead_time_update" — a supplier or trade is notifying about lead time, delivery time, dispatch time, or stock availability changes for a product or service. Examples: "stock of this tile is delayed until October due to a shipping issue"; "our current lead time on custom joinery orders has moved out to 6 weeks, was previously 4"; "this item is now back-ordered with no confirmed ETA".

- "client_rfi" — a client (not a supplier or trade) is asking a question, requesting information, or asking RESLU to make or confirm a decision about their own project. RFI stands for "request for information", standard construction-industry shorthand. Examples: a client asking whether a particular tile colour is still available; a client asking about the current program/timeline; a client asking what a line item on their invoice covers; a client asking to swap a selected item for an alternative.

- "approval" — someone (a client, or an internal team member) is explicitly approving, signing off on, confirming acceptance of, or authorising something that was previously proposed to them. Examples: a client replying "yes, happy to proceed with that quote"; a client confirming a selected tile colour; someone confirming a proposed schedule change. The key signal is explicit, affirmative sign-off on something specific — not just a general expression of enthusiasm.

- "follow_up" — a routine check-in, gentle reminder, or "just following up on my last email, did you see this?" message that itself adds no new substantive information. The ORIGINAL email being followed up on (if it happens to also be visible in this batch) would carry whichever real label applies to it — this follow-up reply itself is usually not separately actionable, since it just restates a request already made elsewhere.

- "fyi" — genuinely informational, no action needed, and nothing worth extracting: a courtesy copy of correspondence between other parties; a status update that carries no concrete facts to record; a brief "thanks so much!" or "sounds good" acknowledgement; a routine internal studio update that is not marketing but also is not something that needs a response or contains extractable facts.

- "noise" — newsletters, marketing blasts, automated system notifications, out-of-office auto-replies, spam, or anything from an obviously automated/noreply sender that carries no project-relevant content whatsoever. Note that the mail-ingest pipeline that runs BEFORE this triage step already hard-rule-skips the most obvious cases (clear newsletters, auto-replies, noreply senders) before you ever see them — so what reaches you here will mostly be borderline or ambiguous cases, not obvious bulk spam.

Only supplier_quote, price_update, lead_time_update, client_rfi, and approval typically warrant the extraction step that runs after triage. follow_up sometimes does, if it happens to restate a concrete fact worth recording. fyi and noise never proceed to extraction — be decisive and use these two labels confidently rather than defaulting to a "safer-sounding" actionable label out of caution when an email is genuinely just informational or noise. Getting this triage step right matters: a false negative here (labelling something actionable as fyi/noise) means a real price change, lead-time change, or client request silently never reaches anyone's attention; a false positive (over-labelling routine mail as actionable) wastes the more expensive extraction step downstream on nothing.

Call the triage_batch tool exactly once, providing one entry per email in the batch (any order is fine), using each email's exact id as given.`;

const TRIAGE_TOOL: ClaudeTool = {
  name: "triage_batch",
  description: "Record a triage label and confidence for every email in the batch.",
  input_schema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            email_id: { type: "string" },
            label: { type: "string", enum: [...TRIAGE_LABELS] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["email_id", "label", "confidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  },
};

export type TriageInput = { id: string; from_addr: string; subject: string | null; clean_text: string | null };
export type TriageResult = { email_id: string; label: TriageLabel; confidence: number };

export async function triageEmails(batch: TriageInput[]): Promise<{ results: TriageResult[]; usage: Record<string, unknown> }> {
  const batchText = batch
    .map(
      (e) =>
        `<email id="${e.id}">\nFrom: ${e.from_addr}\nSubject: ${e.subject ?? "(no subject)"}\n\n${e.clean_text ?? "(no body text)"}\n</email>`
    )
    .join("\n\n");

  const { toolInput, usage } = await callClaude({
    model: TRIAGE_MODEL,
    system: TRIAGE_SYSTEM_PROMPT,
    cacheSystemPrompt: true,
    messages: [{ role: "user", content: `Triage this batch of ${batch.length} emails:\n\n${batchText}` }],
    tool: TRIAGE_TOOL,
    maxTokens: 2048,
  });

  const parsed = toolInput as { results: TriageResult[] };
  return { results: parsed.results, usage };
}
