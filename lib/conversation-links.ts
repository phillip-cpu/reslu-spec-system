export type ConversationTextPart =
  | { type: "text"; text: string }
  | { type: "link"; text: string; href: string };

const LINK_PATTERN = /\[([^\]\n]+)\]\(((?:https?:\/\/|www\.)[^\s)]+)\)|((?:https?:\/\/|www\.)[^\s<]+)/gi;
const TRAILING_URL_PUNCTUATION = /[.,!?;:]+$/;

export function normalizeConversationLink(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /[\s<>]/.test(trimmed)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Parses only explicit Markdown web links and bare HTTP(S)/www addresses.
 * It never parses HTML, and callers render the returned values as React text
 * nodes and anchors so message content cannot inject markup.
 */
export function conversationTextParts(text: string): ConversationTextPart[] {
  const parts: ConversationTextPart[] = [];
  let cursor = 0;

  for (const match of text.matchAll(LINK_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ type: "text", text: text.slice(cursor, index) });

    const markdownLabel = match[1];
    const rawUrl = match[2] ?? match[3] ?? "";
    const punctuation = markdownLabel ? "" : rawUrl.match(TRAILING_URL_PUNCTUATION)?.[0] ?? "";
    const displayUrl = punctuation ? rawUrl.slice(0, -punctuation.length) : rawUrl;
    const href = normalizeConversationLink(displayUrl);

    if (href) {
      parts.push({ type: "link", text: markdownLabel ?? displayUrl, href });
      if (punctuation) parts.push({ type: "text", text: punctuation });
    } else {
      parts.push({ type: "text", text: match[0] });
    }
    cursor = index + match[0].length;
  }

  if (cursor < text.length) parts.push({ type: "text", text: text.slice(cursor) });
  return parts.length > 0 ? parts : [{ type: "text", text }];
}

export function insertConversationLink(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  label: string,
  url: string,
): { text: string; cursor: number } | null {
  const href = normalizeConversationLink(url);
  if (!href) return null;
  const safeLabel = label.trim().replace(/[\[\]]/g, "") || url.trim();
  const link = `[${safeLabel}](${href})`;
  const start = Math.max(0, Math.min(selectionStart, text.length));
  const end = Math.max(start, Math.min(selectionEnd, text.length));
  return {
    text: `${text.slice(0, start)}${link}${text.slice(end)}`,
    cursor: start + link.length,
  };
}
