/** Parse a deliberately small, text-only Markdown subset. No raw HTML or images. */
export type ChatBlock =
  | { kind: "paragraph" | "heading" | "quote"; text: string }
  | { kind: "list"; ordered: boolean; items: string[]; start: number }
  | { kind: "code"; text: string; language: string }
  | { kind: "table"; headers: string[]; rows: string[][] };

export function chatLinkTarget(value: string): string | null {
  if (/^\/(?!\/)/.test(value) && !/[\\\u0000-\u0020]/.test(value)) return value;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function tableCells(line: string) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, "|"));
}

export function parseChatContent(text: string): ChatBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ChatBlock[] = [];
  const special = (line: string) => /^(?:#{1,6}\s|```|>\s?|[-*+]\s|\d+[.)]\s)/.test(line);
  for (let i = 0; i < lines.length;) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push({ kind: "code", language, text: code.join("\n") });
    } else if (line.includes("|") && i + 1 < lines.length && tableCells(lines[i + 1]).every(cell => /^:?-{3,}:?$/.test(cell))) {
      const headers = tableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(tableCells(lines[i++]));
      blocks.push({ kind: "table", headers, rows });
    } else if (/^#{1,6}\s/.test(line)) {
      blocks.push({ kind: "heading", text: line.replace(/^#{1,6}\s+/, "") }); i++;
    } else if (/^>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>/.test(lines[i].trim())) quote.push(lines[i++].trim().replace(/^>\s?/, ""));
      blocks.push({ kind: "quote", text: quote.join("\n") });
    } else if (/^(?:[-*+]\s|\d+[.)]\s)/.test(line)) {
      const ordered = /^\d/.test(line);
      const start = ordered ? parseInt(line, 10) : 1;
      const pattern = ordered ? /^\d+[.)]\s+/ : /^[-*+]\s+/;
      const items: string[] = [];
      while (i < lines.length && pattern.test(lines[i].trim())) {
        items.push(lines[i++].trim().replace(pattern, ""));
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !special(lines[i].trim())) items[items.length - 1] += `\n${lines[i++].trim()}`;
      }
      blocks.push({ kind: "list", ordered, start, items });
    } else {
      const paragraph = [lines[i++]];
      while (i < lines.length && lines[i].trim() && !special(lines[i].trim())) {
        if (lines[i].includes("|") && i + 1 < lines.length && tableCells(lines[i + 1]).every(cell => /^:?-{3,}:?$/.test(cell))) break;
        paragraph.push(lines[i++]);
      }
      blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    }
  }
  return blocks;
}

export function isAgentInterruption(message: { kind: string; metadata: Record<string, unknown>; body: string }) {
  return message.kind === "system" && (
    message.metadata.source === "agent_job_failure"
    || message.metadata.source === "agent_failure"
    || /I could not finish that turn|agent.*(?:timed out|interrupted)/i.test(message.body)
  );
}
