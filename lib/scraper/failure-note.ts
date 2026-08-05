const FAILURE_NOTE = "Auto-fetch failed — open the product page or add details manually";

/**
 * Converts low-level fetch failures into guidance that is useful in the
 * product register. A 403 is not treated as a retryable parsing failure: the
 * supplier rejected the server request before any product HTML was returned.
 */
export function friendlyFailureNote(note: string): string {
  if (/abort|timed?\s*out|timeout/i.test(note)) {
    return "The supplier page took too long to respond — retry or open it manually";
  }
  const upstream = /Upstream returned (\d{3})/i.exec(note);
  if (upstream?.[1] === "403") {
    return "The supplier blocked automatic server access (403) — open the product page and enter the price/details manually";
  }
  if (upstream) {
    return `The supplier page returned error ${upstream[1]} — open it manually or retry later`;
  }
  if (/response too large/i.test(note)) {
    return "The supplier page was too large to read safely — open it manually";
  }
  if (
    /did not return an HTML page|disallowed address|host did not resolve|item not found/i.test(
      note
    )
  ) {
    return note.replace(/\.$/, "");
  }
  return FAILURE_NOTE;
}
