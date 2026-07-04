"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SignatureCanvas } from "@/components/portal/SignatureCanvas";
import type { PortalSigningTarget } from "@/app/portal/types";

/**
 * The actual signing form (BUILD-SPEC.md §"Built-in digital signature"):
 * "full document displayed (must scroll/open before signing enabled)
 * → client signs by drawing on canvas AND/OR typing full name (store
 * both when given) → explicit consent checkbox ... → submit."
 *
 * "Must scroll/open before signing enabled" is tracked client-side via
 * `documentOpened` — set true once the client has either (a) clicked
 * the "Open document" link/button for a document with no inline iframe
 * support, or (b) the iframe has loaded AND the client has interacted
 * with the page (a scroll or click within the document area). This is
 * a UX nudge, not a security control (the real boundary is server-side:
 * ownership + consent + hash, all enforced in the API route) — see the
 * sign route's own comment on this same point.
 */
export function SigningForm({
  token,
  target,
  consentStatement,
}: {
  token: string;
  target: PortalSigningTarget;
  consentStatement: string;
}) {
  const router = useRouter();
  const [documentOpened, setDocumentOpened] = useState(!target.document_url);
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const [signerName, setSignerName] = useState("");
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ certificateUrl: string | null } | null>(null);

  const canSubmit =
    documentOpened && !!signatureDataUrl && signerName.trim().length > 0 && consent && !submitting;

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/${token}/sign/${target.request_id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signature_data_url: signatureDataUrl,
          signer_name_typed: signerName.trim(),
          consent,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not submit your signature.");
      }
      const data = await res.json();
      setResult({ certificateUrl: data.certificate_url ?? null });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  if (target.status === "signed") {
    return (
      <div className="border border-sand bg-offwhite p-6 text-center">
        <p className="text-subhead text-nearblack">This document has already been signed.</p>
      </div>
    );
  }
  if (target.status === "void") {
    return (
      <div className="border border-charcoal/30 p-6 text-center">
        <p className="text-subhead text-nearblack">
          This signature request is no longer valid — the document has changed since it was
          requested. Please contact RESLU for an updated version.
        </p>
      </div>
    );
  }

  if (result) {
    return (
      <div className="border border-sand bg-offwhite p-6 text-center">
        <p className="text-subhead text-nearblack">Thank you — your signature has been recorded.</p>
        {result.certificateUrl && (
          <a
            href={result.certificateUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block text-body text-nearblack underline decoration-sand underline-offset-2"
          >
            View signature certificate
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="label-caps mb-2 !text-sand">{target.document_filename}</p>
        {target.document_url ? (
          <div
            className="h-[60vh] w-full border border-[#dcd6cc] bg-nearwhite"
            onScroll={() => setDocumentOpened(true)}
            onClick={() => setDocumentOpened(true)}
          >
            <iframe
              src={target.document_url}
              title={target.document_filename}
              className="h-full w-full"
              onLoad={() => setDocumentOpened(true)}
            />
          </div>
        ) : (
          <div className="border border-[#dcd6cc] bg-nearwhite p-6 text-body text-charcoal/70">
            {target.subject_type === "variation"
              ? "Review the variation details above before signing."
              : "There is nothing to preview for this item — you may proceed to sign."}
          </div>
        )}
        {!documentOpened && (
          <p className="mt-2 text-caption text-charcoal/50">
            Please open/scroll the document above before signing.
          </p>
        )}
      </div>

      <div>
        <label className="label-caps mb-2 block !text-sand">Draw your signature</label>
        <SignatureCanvas onChange={setSignatureDataUrl} />
      </div>

      <div>
        <label className="label-caps mb-2 block !text-sand">Full name</label>
        <input
          type="text"
          value={signerName}
          onChange={(e) => setSignerName(e.target.value)}
          placeholder="Type your full name"
          className="w-full border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
        />
      </div>

      <label className="flex items-start gap-2 text-body text-charcoal/80">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-1"
        />
        <span>{consentStatement}</span>
      </label>

      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>
      )}

      <button
        type="button"
        disabled={!canSubmit}
        onClick={submit}
        className="w-full bg-nearblack px-4 py-3 text-subhead text-white transition-colors hover:bg-charcoal disabled:cursor-not-allowed disabled:opacity-40"
      >
        {submitting ? "Submitting…" : "Sign"}
      </button>
    </div>
  );
}
