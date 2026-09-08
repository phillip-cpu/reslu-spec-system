"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ChatContent } from "./ChatContent";
import { useDialogFocusBoundary } from "@/lib/use-dialog-focus-boundary";

export type ChatReaderDocument = { title: string; author: string; text?: string; url?: string };

export function ChatReader({ document, onClose }: { document: ChatReaderDocument; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = window.document.body;
    const previousOverflow = body.style.overflow;
    const siblings = [...body.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== ref.current);
    const inertStates = siblings.map(element => element.inert);
    for (const element of siblings) element.inert = true;
    body.style.overflow = "hidden";
    return () => {
      siblings.forEach((element, index) => { element.inert = inertStates[index]; });
      body.style.overflow = previousOverflow;
    };
  }, []);
  useDialogFocusBoundary({ active: true, containerRef: ref, onEscape: onClose });
  return createPortal(<div className="chat-reader conversation-accessible" ref={ref} role="dialog" aria-modal="true" aria-labelledby="chat-reader-title" tabIndex={-1}>
    <header>
      <div><p>Shared by {document.author}</p><h2 id="chat-reader-title">{document.title}</h2></div>
      {document.url && <a href={document.url} target="_blank" rel="noreferrer">Open original ↗</a>}
      <button type="button" onClick={onClose} aria-label="Close reader">Close ×</button>
    </header>
    {document.url ? <div className="chat-reader-pdf">
      <p>If your browser cannot preview this PDF, use <a href={document.url} target="_blank" rel="noreferrer">Open original</a>.</p>
      <iframe src={document.url} title={document.title} />
    </div> : <div className="chat-reader-scroll"><article><ChatContent text={document.text ?? ""} /></article></div>}
  </div>, window.document.body);
}
