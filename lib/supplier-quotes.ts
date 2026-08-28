import type { SupplierQuoteRequestStatus } from "@/types/supplier-quotes";

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9,
  nov: 10, november: 10, dec: 11, december: 11,
};

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addBusinessDays(start: Date, count: number): Date {
  const result = new Date(start);
  let remaining = Math.max(0, count);
  while (remaining > 0) {
    result.setDate(result.getDate() + 1);
    if (result.getDay() !== 0 && result.getDay() !== 6) remaining -= 1;
  }
  return result;
}

/** Conservative deterministic extraction for common supplier ETA replies. */
export function extractPromisedQuoteDate(text: string, receivedAt: string | Date): string | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const base = new Date(receivedAt);

  const iso = clean.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;

  const au = clean.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](20\d{2})\b/);
  if (au) return `${au[3]}-${au[2].padStart(2, "0")}-${au[1].padStart(2, "0")}`;

  const named = clean.match(/\b(?:by|on|before|ready|quote|quotation)?\s*(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(20\d{2}))?\b/i);
  if (named) {
    const month = MONTHS[named[2].toLowerCase()];
    let year = named[3] ? Number(named[3]) : base.getFullYear();
    let result = new Date(year, month, Number(named[1]));
    if (!named[3] && result.getTime() < base.getTime() - 24 * 60 * 60 * 1000) {
      year += 1;
      result = new Date(year, month, Number(named[1]));
    }
    return isoDate(result);
  }

  if (/\btomorrow\b/i.test(clean)) {
    const result = new Date(base);
    result.setDate(result.getDate() + 1);
    return isoDate(result);
  }

  const businessDays = clean.match(/\b(?:in|within|allow)\s+(\d{1,2})\s+business\s+days?\b/i);
  if (businessDays) return isoDate(addBusinessDays(base, Number(businessDays[1])));

  const relative = clean.match(/\b(?:in|within)\s+(\d{1,2})\s+(days?|weeks?)\b/i);
  if (relative) {
    const result = new Date(base);
    const multiplier = relative[2].toLowerCase().startsWith("week") ? 7 : 1;
    result.setDate(result.getDate() + Number(relative[1]) * multiplier);
    return isoDate(result);
  }

  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const weekdayMatch = clean.match(/\b(?:by|on)?\s*(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (weekdayMatch) {
    const target = weekdays.indexOf(weekdayMatch[2].toLowerCase());
    let delta = (target - base.getDay() + 7) % 7;
    if (delta === 0 || weekdayMatch[1]) delta += 7;
    const result = new Date(base);
    result.setDate(result.getDate() + delta);
    return isoDate(result);
  }

  return null;
}

export function quoteRequestFollowup(input: {
  status: SupplierQuoteRequestStatus;
  sent_at: string | null;
  acknowledgement_due_at: string | null;
  acknowledged_at: string | null;
  promised_quote_at: string | null;
}): { kind: "acknowledgement" | "turnaround" | "quote_due"; due: string | null } | null {
  if (["quote_received", "declined", "selected", "closed", "draft"].includes(input.status)) return null;
  if (!input.acknowledged_at) return { kind: "acknowledgement", due: input.acknowledgement_due_at };
  if (!input.promised_quote_at) return { kind: "turnaround", due: input.acknowledged_at.slice(0, 10) };
  return { kind: "quote_due", due: input.promised_quote_at };
}

export function buildSupplierQuoteEmail(input: {
  requestReference: string;
  projectName: string;
  projectAddress?: string | null;
  packageTitle: string;
  scope?: string | null;
  requestedQuoteDate?: string | null;
  responseUrl: string;
  lines: { description: string; qty: number | null; unit: string | null }[];
  attachmentNames: string[];
}): { subject: string; body: string } {
  const lineText = input.lines.map((line, index) => {
    const quantity = line.qty === null ? "" : ` — ${line.qty}${line.unit ? ` ${line.unit}` : ""}`;
    return `${index + 1}. ${line.description}${quantity}`;
  });
  const attachments = input.attachmentNames.length
    ? ["", "Attached reference files:", ...input.attachmentNames.map((name) => `- ${name}`)]
    : [];
  return {
    subject: `[${input.requestReference}] Quote request — ${input.projectName} — ${input.packageTitle}`,
    body: [
      "Hello,",
      "",
      `Please provide a quotation for ${input.packageTitle} at ${input.projectName}${input.projectAddress ? ` (${input.projectAddress})` : ""}.`,
      input.scope ? `\nScope / notes:\n${input.scope}` : "",
      "",
      "Items to quote:",
      ...lineText,
      "",
      input.requestedQuoteDate ? `Requested quote date: ${input.requestedQuoteDate}` : "Please advise when you can return the quotation.",
      "Please confirm your expected turnaround date, even if you are not ready to submit the quote yet.",
      ...attachments,
      "",
      `View the request, confirm turnaround, or submit your quote: ${input.responseUrl}`,
      "",
      "You can also reply directly to this email. Your reply and attachments will remain linked to this request.",
      "",
      "Regards,",
      "RESLU",
    ].filter((part) => part !== "").join("\n"),
  };
}
