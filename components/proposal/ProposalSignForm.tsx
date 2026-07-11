"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SignatureCanvas } from "@/components/portal/SignatureCanvas";

/**
 * The proposal's sign-to-accept form (BUILD-SPEC.md §"Fee proposal
 * phase (r23)" item 4: "reuse existing e-signature machinery (draw/
 * type)"). Reuses components/portal/SignatureCanvas.tsx's own plain-
 * <canvas> draw capture verbatim (a general-purpose component, not tied
 * to signature_requests) — the surrounding form/submit logic here is a
 * NEW, proposal-specific component rather than reusing
 * components/portal/SigningForm.tsx, because that component's submit
 * target/body shape and "must open the document first" gating are
 * wired specifically to the signature_requests/portal flow (see
 * migration 051's own column comment on why proposals capture their
 * own self-contained signature evidence rather than reusing that
 * table). Both a drawn signature AND a typed full name are required
 * here (unlike that flow's "draw AND/OR type") — see
 * app/api/proposal/[token]/accept/route.ts's own doc comment.
 */
export function ProposalSignForm({ token }: { token: string }) {
  const router = useRouter();
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const [typedName, setTypedName] = useState("");
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const canSubmit = !!signatureDataUrl && typedName.trim().length > 0 && consent && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/proposal/${token}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          drawn_data_url: signatureDataUrl,
          typed_name: typedName.trim(),
          consent,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not record your signature.");
      setDone(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="border border-sand bg-offwhite p-6 text-center">
        <p className="text-subhead text-nearblack">Thank you — your signature has been recorded.</p>
        <p className="mt-2 text-body text-charcoal/60">
          A signed copy is on its way to your inbox.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <label className="label-caps mb-2 block">Draw your signature</label>
        <SignatureCanvas onChange={setSignatureDataUrl} />
      </div>

      <div>
        <label className="label-caps mb-2 block">Full name</label>
        <input
          type="text"
          value={typedName}
          onChange={(e) => setTypedName(e.target.value)}
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
        <span>I have read this proposal and its terms, and I agree this electronic signature is binding.</span>
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
        {submitting ? "Submitting…" : "Sign & accept"}
      </button>
    </div>
  );
}
