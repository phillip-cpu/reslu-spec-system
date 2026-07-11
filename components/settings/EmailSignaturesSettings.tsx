"use client";

import { useState } from "react";
import { renderSignatureHtml, type SignaturePerson } from "@/lib/email-signatures";

interface Props {
  people: SignaturePerson[];
}

const FONT_HREF = "https://fonts.googleapis.com/css2?family=Caveat:wght@500;600&display=swap";

/**
 * Wraps the (locked, untouched) signature markup in a standalone HTML
 * document for the preview <iframe srcDoc>. BUILD-SPEC.md item 1: the
 * preview must be isolated (iframe or sandboxed div) "so its fonts/
 * styles don't leak" into the rest of Settings — this wrapper only adds
 * page-level cosmetics (background, font import) OUTSIDE the signature
 * markup itself, never inside it.
 */
function previewDocument(signatureHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><link href="${FONT_HREF}" rel="stylesheet"><style>body{margin:0;padding:20px 16px;background:#EDE8DE;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;}</style></head><body>${signatureHtml}</body></html>`;
}

/** Plain-text clipboard fallback line for the ClipboardItem write — never shown, just accompanies the rich HTML for apps that only accept text/plain. */
function plainTextFallback(person: SignaturePerson): string {
  return [person.name, person.title, person.phone, "reslu.com.au"].filter(Boolean).join("\n");
}

/**
 * Email signatures — Settings section (BUILD-SPEC.md "Email signatures
 * page (r22)"). One card per person: an isolated live preview, a
 * "Copy signature" button (rich-text clipboard, same technique as
 * emails/signatures/reference-signature-phillip.html's own copySig(),
 * upgraded to try the modern ClipboardItem API first with that
 * selection-based technique as the fallback), and a "Download Mac
 * installer" link to GET /api/signatures/installer/[id].
 *
 * Visible to every team member, no admin gate (item 5: "visible to all
 * users, no secrets") — this page.tsx section is intentionally NOT
 * wrapped in an isAdmin check, unlike Bank details above it.
 */
export function EmailSignaturesSettings({ people }: Props) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {people.map((person) => (
          <SignatureCard key={person.id} person={person} />
        ))}
      </div>
      <InstallInstructions />
    </div>
  );
}

function SignatureCard({ person }: { person: SignaturePerson }) {
  const [copyLabel, setCopyLabel] = useState("Copy signature");
  const html = renderSignatureHtml(person);
  const copySourceId = `sig-copy-source-${person.id}`;

  async function copySignature() {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && "ClipboardItem" in window) {
        const htmlBlob = new Blob([html], { type: "text/html" });
        const textBlob = new Blob([plainTextFallback(person)], { type: "text/plain" });
        await navigator.clipboard.write([
          new ClipboardItem({ "text/html": htmlBlob, "text/plain": textBlob }),
        ]);
        flashCopied(true);
        return;
      }
    } catch {
      // Clipboard API unavailable, blocked by permissions, or the
      // browser doesn't support the "text/html" mime type — fall
      // through to the selection-based fallback below.
    }

    // Fallback: the reference page's own copySig() technique — select
    // a node holding the exact rendered markup and
    // document.execCommand('copy') it. Uses a dedicated off-screen node
    // (below) rather than the preview <iframe>, since the iframe is
    // sandboxed for style isolation and its contents aren't reachable
    // from here.
    const node = document.getElementById(copySourceId);
    if (node) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      const ok = document.execCommand("copy");
      selection?.removeAllRanges();
      flashCopied(ok);
      return;
    }
    flashCopied(false);
  }

  function flashCopied(ok: boolean) {
    setCopyLabel(ok ? "Copied" : "Could not copy");
    setTimeout(() => setCopyLabel("Copy signature"), 1500);
  }

  return (
    <div className="border border-[#dcd6cc] bg-offwhite p-4">
      <div className="mb-3">
        <p className="text-body text-nearblack">{person.name}</p>
        <p className="text-caption text-charcoal/50">{person.title}</p>
      </div>

      <div className="mb-3 overflow-hidden border border-[#dcd6cc] bg-cream">
        <iframe
          title={`${person.name} signature preview`}
          srcDoc={previewDocument(html)}
          sandbox=""
          className="h-72 w-full"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={copySignature}
          className="bg-nearblack px-4 py-2 text-caption tracking-[2px] text-cream transition-colors hover:bg-charcoal"
        >
          {copyLabel.toUpperCase()}
        </button>
        <a
          href={`/api/signatures/installer/${person.id}`}
          className="border border-[#c9c2b4] px-4 py-2 text-caption tracking-[2px] text-charcoal transition-colors hover:border-nearblack hover:text-nearblack"
        >
          DOWNLOAD MAC INSTALLER
        </a>
      </div>

      {/* Off-screen (not display:none — execCommand('copy') needs a
          rendered selection) copy source for the fallback path above.
          Same exact signature markup as the preview, just outside the
          sandboxed iframe so getSelection()/execCommand can reach it. */}
      <div
        id={copySourceId}
        aria-hidden
        style={{ position: "absolute", left: "-9999px", top: 0, width: "1px", height: "1px", overflow: "hidden" }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/**
 * Collapsible install instructions (BUILD-SPEC.md item 4): Gmail paste,
 * Apple Mail (quit Mail first, run the downloaded script, Full Disk
 * Access note, most-recent-file vs path-argument behaviour), and
 * iPhone/iPad (email-to-self + the shake-to-undo trick). Plain tone, no
 * em dashes, matching the tone rule for user-facing copy.
 */
function InstallInstructions() {
  return (
    <details className="border border-[#dcd6cc] bg-offwhite p-4">
      <summary className="cursor-pointer text-subhead text-nearblack">Install instructions</summary>
      <div className="mt-4 space-y-5 text-body text-charcoal/80">
        <div>
          <p className="label-caps mb-2">Gmail</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>Click &quot;Copy signature&quot; on your card above.</li>
            <li>In Gmail, open Settings, then &quot;See all settings&quot;, then find the Signature section.</li>
            <li>Click &quot;Create new&quot;, give it a name, then paste it into the signature box.</li>
            <li>Scroll down and click &quot;Save Changes&quot;.</li>
          </ol>
        </div>
        <div>
          <p className="label-caps mb-2">Apple Mail (Mac)</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Quit Mail completely first (Cmd+Q). The installer edits the signature file directly,
              and Mail can overwrite it again if it is still open.
            </li>
            <li>
              Click &quot;Download Mac installer&quot; on your card above. It downloads a script
              called install-signature-name.sh to your Downloads folder.
            </li>
            <li>
              Open Terminal and run: <code>bash ~/Downloads/install-signature-name.sh</code>. Left
              on its own it finds your most recently used signature file. To target a specific one
              instead, pass its path as an argument:{" "}
              <code>bash install-signature-name.sh /path/to/file.mailsignature</code>.
            </li>
            <li>
              The script locks the file afterwards so Mail can&apos;t quietly overwrite it again.
              If you ever need to edit that file by hand later, unlock it first with the{" "}
              <code>chflags nouchg</code> command the script prints when it finishes.
            </li>
            <li>Open Mail and check Settings, Signatures, to confirm it looks right.</li>
            <li>
              If macOS blocks Terminal from reading or writing your Mail signatures, grant it Full
              Disk Access: System Settings, Privacy &amp; Security, Full Disk Access, add Terminal,
              then run the script again.
            </li>
          </ol>
        </div>
        <div>
          <p className="label-caps mb-2">iPhone and iPad</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>Email the signature to yourself (or use the copied version) and open it on your iPhone.</li>
            <li>Copy the signature out of that email.</li>
            <li>In Settings, open Mail, then Signature, and paste it in.</li>
            <li>
              If autocorrect changes something while you are pasting or typing, shake the phone.
              That brings up &quot;Undo Typing&quot; and reverts the last change, quicker than
              fixing it by hand.
            </li>
          </ol>
        </div>
      </div>
    </details>
  );
}
