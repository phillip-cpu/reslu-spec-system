"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ASSET_BUCKET } from "@/lib/storage";
import { INSURANCE_REQUEST_KIND_LABEL } from "@/lib/insurance-requests";
import type { InsuranceRequestKind } from "@/types/insurance-requests";

interface Props {
  token: string;
  company: string;
  requestedKinds: InsuranceRequestKind[];
  initialUploadedKinds: InsuranceRequestKind[];
}

export function InsuranceUploadPortal({
  token,
  company,
  requestedKinds,
  initialUploadedKinds,
}: Props) {
  const [uploadedKinds, setUploadedKinds] =
    useState<InsuranceRequestKind[]>(initialUploadedKinds);
  const [uploadingKind, setUploadingKind] = useState<InsuranceRequestKind | null>(null);
  const [errors, setErrors] = useState<Partial<Record<InsuranceRequestKind, string>>>({});

  const complete = requestedKinds.every((kind) => uploadedKinds.includes(kind));

  async function upload(kind: InsuranceRequestKind, form: HTMLFormElement) {
    const fileInput = form.elements.namedItem("file") as HTMLInputElement | null;
    const expiryInput = form.elements.namedItem("expiry_date") as HTMLInputElement | null;
    const file = fileInput?.files?.[0];
    const expiryDate = expiryInput?.value ?? "";
    if (!file || !expiryDate) return;

    setUploadingKind(kind);
    setErrors((current) => ({ ...current, [kind]: undefined }));
    try {
      const urlResponse = await fetch(`/api/insurance-request/${token}/upload-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, filename: file.name }),
      });
      const urlBody = await urlResponse.json();
      if (!urlResponse.ok) throw new Error(urlBody.error ?? "Could not start the upload.");

      const supabase = createClient();
      const { error: uploadError } = await supabase.storage
        .from(ASSET_BUCKET)
        .uploadToSignedUrl(urlBody.path, urlBody.token, file, {
          contentType: file.type || "application/octet-stream",
        });
      if (uploadError) throw new Error(uploadError.message);

      const saveResponse = await fetch(`/api/insurance-request/${token}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          storage_path: urlBody.path,
          filename: file.name,
          expiry_date: expiryDate,
        }),
      });
      const saveBody = await saveResponse.json();
      if (!saveResponse.ok) throw new Error(saveBody.error ?? "Could not save the document.");

      setUploadedKinds((current) =>
        current.includes(kind) ? current : [...current, kind]
      );
      form.reset();
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [kind]: error instanceof Error ? error.message : "Upload failed. Please try again.",
      }));
    } finally {
      setUploadingKind(null);
    }
  }

  if (complete) {
    return (
      <section className="border border-[#c9c2b4] bg-offwhite px-6 py-8 text-center">
        <p className="label-caps text-sand">Complete</p>
        <h2 className="mt-2 font-display text-section text-nearblack">Thank you</h2>
        <p className="mx-auto mt-3 max-w-md text-body text-charcoal/70">
          All requested documents for {company} have been received. RESLU has been
          notified and there is nothing else you need to do.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      {requestedKinds.map((kind) => {
        const uploaded = uploadedKinds.includes(kind);
        return (
          <section key={kind} className="border border-[#dcd6cc] bg-offwhite p-5 sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="label-caps">Required document</p>
                <h2 className="mt-1 text-subhead text-nearblack">
                  {INSURANCE_REQUEST_KIND_LABEL[kind]}
                </h2>
              </div>
              <span
                className={`border px-2 py-1 text-caption uppercase tracking-wide ${
                  uploaded
                    ? "border-[#66806a] bg-[#edf3ed] text-[#46604a]"
                    : "border-sand text-sand"
                }`}
              >
                {uploaded ? "Received" : "Needed"}
              </span>
            </div>

            {!uploaded && (
              <form
                className="mt-5 space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void upload(kind, event.currentTarget);
                }}
              >
                <label className="block">
                  <span className="label-caps">Expiry date</span>
                  <input
                    type="date"
                    name="expiry_date"
                    required
                    className="mt-1 w-full border border-[#c9c2b4] bg-nearwhite px-3 py-3 text-body focus:border-nearblack focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="label-caps">Document</span>
                  <input
                    type="file"
                    name="file"
                    required
                    accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                    className="mt-1 w-full border border-[#c9c2b4] bg-nearwhite px-3 py-2.5 text-body focus:border-nearblack focus:outline-none"
                  />
                </label>
                {errors[kind] && (
                  <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-caption text-red-700">
                    {errors[kind]}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={uploadingKind !== null}
                  className="w-full bg-nearblack px-4 py-3 text-subhead text-white hover:bg-charcoal disabled:opacity-50"
                >
                  {uploadingKind === kind ? "Uploading…" : "Upload document"}
                </button>
              </form>
            )}
          </section>
        );
      })}
    </div>
  );
}
