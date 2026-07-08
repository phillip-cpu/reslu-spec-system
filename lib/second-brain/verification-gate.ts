/**
 * RESLU Second Brain, Step 11 (docs/RESLU-second-brain-build-brief.md).
 * The deterministic verification gate — a script, not a model call,
 * by design: it exists specifically to catch a hallucinated fact
 * regardless of which model (Haiku, Sonnet, vision) produced it, so
 * it cannot itself rely on a model to do the checking.
 *
 * Two independent checks, both must pass:
 *   1. source_quote appears verbatim (after whitespace normalization)
 *      in at least one of the provided source texts (the email's
 *      clean_text, or an attachment's extracted_text).
 *   2. The fact's own numeric value genuinely appears within the
 *      quote itself — catches the narrower hallucination shape where
 *      the quote text is real (check 1 passes) but the extracted
 *      number doesn't actually match what's written in that quote.
 */

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function numbersIn(text: string): number[] {
  const matches = text.match(/[\d,]+\.?\d*/g) ?? [];
  return matches.map((m) => Number(m.replace(/,/g, ""))).filter((n) => !Number.isNaN(n));
}

export type VerificationResult = { passed: boolean; reason?: string };

export function verifyQuote(params: { quote: string; value: number; sourceTexts: (string | null | undefined)[] }): VerificationResult {
  const { quote, value, sourceTexts } = params;

  const normalizedQuote = normalizeWhitespace(quote);
  if (!normalizedQuote) {
    return { passed: false, reason: "source_quote is empty" };
  }

  const foundInSource = sourceTexts.some((text) => text && normalizeWhitespace(text).includes(normalizedQuote));
  if (!foundInSource) {
    return { passed: false, reason: "source_quote does not appear verbatim in clean_text or any attachment's extracted_text" };
  }

  const quoteNumbers = numbersIn(normalizedQuote);
  const valueAppearsInQuote = quoteNumbers.some((n) => Math.abs(n - value) < 0.005);
  if (!valueAppearsInQuote) {
    return { passed: false, reason: `numeric value ${value} does not appear within source_quote` };
  }

  return { passed: true };
}
