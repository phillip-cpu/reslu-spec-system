import { Fragment, type ReactNode } from "react";
import { chatLinkTarget, parseChatContent } from "@/lib/chat-content";

function inline(text: string): ReactNode[] {
  return text.split(/(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    const href = link && chatLinkTarget(link[2]);
    if (link && href) return <a key={index} href={href} target={href.startsWith("/") ? undefined : "_blank"} rel="noreferrer">{link[1]}</a>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

export function ChatContent({ text }: { text: string }) {
  return <div className="chat-content">{parseChatContent(text).map((block, index) => {
    if (block.kind === "heading") return <h3 key={index}>{inline(block.text)}</h3>;
    if (block.kind === "quote") return <blockquote key={index}>{inline(block.text)}</blockquote>;
    if (block.kind === "code") return <pre key={index} tabIndex={0} aria-label={block.language ? `${block.language} code` : "Code"}><code>{block.text}</code></pre>;
    if (block.kind === "list") {
      const items = block.items.map((item, i) => <li key={i}>{inline(item)}</li>);
      return block.ordered ? <ol key={index} start={block.start}>{items}</ol> : <ul key={index}>{items}</ul>;
    }
    if (block.kind === "table") return <div key={index} className="chat-table-scroll" role="region" aria-label="Response table, scroll horizontally for more columns" tabIndex={0}>
      <table><thead><tr>{block.headers.map((cell, i) => <th key={i} scope="col">{inline(cell)}</th>)}</tr></thead>
        <tbody>{block.rows.map((row, i) => <tr key={i}>{block.headers.map((_, j) => <td key={j}>{inline(row[j] ?? "")}</td>)}</tr>)}</tbody>
      </table>
    </div>;
    return <p key={index}>{inline(block.text)}</p>;
  })}</div>;
}
