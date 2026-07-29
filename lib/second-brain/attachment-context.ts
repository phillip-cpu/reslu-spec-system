export type ExtractedAttachmentText = {
  id: string;
  filename: string | null;
  extracted_text: string | null;
  extraction_method: string | null;
};

export type AttachmentTextBlock = {
  type: "text";
  text: string;
};

const MAX_ATTACHMENT_TEXT_CHARS = 60_000;

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Turns text recovered by the Mac ingest worker (pdftotext/OCR) into Claude
 * content blocks. Readable PDFs are deliberately not marked needs_vision, so
 * this text handoff is the only way their invoice contents reach extraction.
 */
export function buildExtractedAttachmentTextBlocks(
  attachments: ExtractedAttachmentText[]
): AttachmentTextBlock[] {
  return attachments.flatMap((attachment) => {
    const sourceText = attachment.extracted_text?.trim();
    if (!sourceText) return [];

    const truncated = sourceText.length > MAX_ATTACHMENT_TEXT_CHARS;
    const text = truncated
      ? `${sourceText.slice(0, MAX_ATTACHMENT_TEXT_CHARS)}\n[truncated after ${MAX_ATTACHMENT_TEXT_CHARS} characters]`
      : sourceText;
    const id = escapeAttribute(attachment.id);
    const filename = escapeAttribute(attachment.filename ?? "");
    const method = escapeAttribute(attachment.extraction_method ?? "pre-extracted");

    return [
      {
        type: "text" as const,
        text:
          `<attachment_text id="${id}" filename="${filename}" extraction_method="${method}">\n` +
          `${text}\n` +
          `</attachment_text>`,
      },
    ];
  });
}

