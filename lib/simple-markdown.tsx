import { Fragment } from "react";
import clsx from "clsx";
import type { ReactNode } from "react";

/**
 * Tiny, deliberately limited markdown renderer for portal update posts
 * (BUILD-SPEC.md "Week 8 — Client portal expansion": "markdown rendered
 * simply — write a tiny safe renderer for paragraphs/bold/lists, NO
 * dangerouslySetInnerHTML of raw input").
 *
 * Supports exactly: paragraphs (blank-line separated), **bold**, and
 * "- "/"* " bullet lists. Everything else (headings, links, images,
 * raw HTML, etc.) is rendered as literal text — this is intentional:
 * the input is team-authored but still free text reaching a client's
 * browser, so the safest thing is a tiny allowlist of formatting
 * rather than a general markdown-to-HTML pipeline. No HTML is ever
 * parsed or injected; everything goes through React's normal text
 * nodes (this file never touches dangerouslySetInnerHTML).
 */

function safeLinkTarget(value: string) {
  if (value.startsWith("/")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function renderInline(text: string, keyPrefix: string, inverse: boolean): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/|\/)[^)]+\))/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={`${keyPrefix}-${i}`} className={clsx("rounded px-1 py-0.5 font-mono text-[0.9em]", inverse ? "bg-white/15" : "bg-black/[0.07]")}>{part.slice(1, -1)}</code>;
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = safeLinkTarget(link[2]);
      if (href) return <a key={`${keyPrefix}-${i}`} href={href} target={href.startsWith("/") ? undefined : "_blank"} rel={href.startsWith("/") ? undefined : "noreferrer"} className="font-medium underline decoration-current/40 underline-offset-2">{link[1]}</a>;
    }
    return <Fragment key={`${keyPrefix}-${i}`}>{part}</Fragment>;
  });
}

export function SimpleMarkdown({ text, tone = "default" }: { text: string; tone?: "default" | "inverse" }) {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
  const inverse = tone === "inverse";

  return (
    <div className="space-y-3">
      {blocks.map((block, blockIndex) => {
        const trimmed = block.trim();
        if (!trimmed) return null;

        const lines = trimmed.split("\n").map((l) => l.trim());
        const isList = lines.every((l) => l.startsWith("- ") || l.startsWith("* "));
        const isOrderedList = lines.every((l) => /^\d+\.\s/.test(l));

        if (/^#{1,3}\s/.test(trimmed) && lines.length === 1) {
          const level = trimmed.match(/^#+/)?.[0].length ?? 1;
          const content = trimmed.replace(/^#{1,3}\s+/, "");
          const className = clsx("font-semibold leading-snug", level === 1 ? "text-[1.2em]" : "text-[1.08em]");
          return <p key={blockIndex} className={className}>{renderInline(content, `${blockIndex}-heading`, inverse)}</p>;
        }

        if (isList) {
          return (
            <ul key={blockIndex} className="list-disc space-y-1 pl-5">
              {lines.map((line, lineIndex) => (
                <li key={lineIndex}>
                  {renderInline(line.slice(2), `${blockIndex}-${lineIndex}`, inverse)}
                </li>
              ))}
            </ul>
          );
        }

        if (isOrderedList) {
          return (
            <ol key={blockIndex} className="list-decimal space-y-1 pl-5">
              {lines.map((line, lineIndex) => (
                <li key={lineIndex}>{renderInline(line.replace(/^\d+\.\s/, ""), `${blockIndex}-${lineIndex}`, inverse)}</li>
              ))}
            </ol>
          );
        }

        return (
          <p key={blockIndex}>
            {lines.map((line, lineIndex) => (
              <Fragment key={lineIndex}>
                {lineIndex > 0 && <br />}
                {renderInline(line, `${blockIndex}-${lineIndex}`, inverse)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
