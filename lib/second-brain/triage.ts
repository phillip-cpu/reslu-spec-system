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

const TRIAGE_SYSTEM_PROMPT = `You are the mail triage step for RESLU, an interior design and design-build studio in Adelaide, South Australia. You will be given a batch of inbound emails (each with an id, sender, subject, and cleaned body text with quoted history and signatures already stripped). For every email, assign exactly one label from this fixed list, plus a confidence score from 0.0 to 1.0.

Label definitions:

- "supplier_quote" — a trade or supplier has sent a formal quote, quotation, or costed proposal for goods or services (e.g. a joinery quote, a tapware supplier's pricing sheet, a trade's costed scope of works). Distinct from price_update (a supplier telling you an EXISTING product's price has changed) — supplier_quote is usually a NEW quote for a NEW request.

- "price_update" — a supplier or trade is notifying that the price of one or more specific, already-known products or services has changed (e.g. "our laminate range increases 4% from 1 August", "Polytec Ravine is now $136/m², up from $128"). Often proactive, not in response to a specific request.

- "lead_time_update" — a supplier or trade is notifying about lead time / delivery time / availability changes for a product or service (e.g. "stock delayed until October", "our current lead time on custom joinery is now 6 weeks").

- "client_rfi" — a client (not a supplier/trade) is asking a question, requesting information, or requesting a change/decision about their own project (RFI = request for information). Includes client questions about selections, timelines, budget, or scope.

- "approval" — someone (client or internal) is explicitly approving, signing off on, or confirming acceptance of something previously proposed (a quote, a selection, a schedule, a scope change).

- "follow_up" — a routine check-in, reminder, or "just following up on my last email" message with no new substantive information — the ORIGINAL email (if visible in context) would carry the real label; this reply itself adds nothing new to act on.

- "fyi" — informational only, no action needed and nothing to extract: a courtesy copy, a status update with no facts to record, a "thanks!" or acknowledgement, an internal newsletter or update the studio subscribes to that isn't a real newsletter/marketing blast but also isn't actionable.

- "noise" — newsletters, marketing blasts, automated notifications, out-of-office auto-replies, spam, or anything from a noreply/no-reply sender that carries no project-relevant content at all. NOTE: the ingest pipeline already hard-rule-skips obvious newsletters/auto-replies/noreply senders before this triage step ever sees them — you will mostly see borderline cases here, not obvious spam.

Only supplier_quote, price_update, lead_time_update, client_rfi, and approval typically warrant the extraction step that follows triage. follow_up sometimes does (if it restates a fact). fyi and noise never do — be decisive rather than defaulting to a "safe" actionable label when an email is genuinely just informational.

Call the triage_batch tool exactly once with one entry per email in the batch, in any order, using the exact email_id given.`;

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
