import { Fragment } from "react";
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

function renderInlineBold(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>;
    }
    return <Fragment key={`${keyPrefix}-${i}`}>{part}</Fragment>;
  });
}

export function SimpleMarkdown({ text }: { text: string }) {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/);

  return (
    <div className="space-y-3">
      {blocks.map((block, blockIndex) => {
        const trimmed = block.trim();
        if (!trimmed) return null;

        const lines = trimmed.split("\n").map((l) => l.trim());
        const isList = lines.every((l) => l.startsWith("- ") || l.startsWith("* "));

        if (isList) {
          return (
            <ul key={blockIndex} className="list-disc space-y-1 pl-5">
              {lines.map((line, lineIndex) => (
                <li key={lineIndex} className="text-body text-charcoal/80">
                  {renderInlineBold(line.slice(2), `${blockIndex}-${lineIndex}`)}
                </li>
              ))}
            </ul>
          );
        }

        return (
          <p key={blockIndex} className="text-body text-charcoal/80">
            {lines.map((line, lineIndex) => (
              <Fragment key={lineIndex}>
                {lineIndex > 0 && <br />}
                {renderInlineBold(line, `${blockIndex}-${lineIndex}`)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
