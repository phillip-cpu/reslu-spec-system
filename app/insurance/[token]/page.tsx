import type { Metadata } from "next";
import Image from "next/image";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { InsuranceUploadPortal } from "@/components/contacts/InsuranceUploadPortal";
import {
  INSURANCE_REQUEST_KIND_LABEL,
  isInsuranceRequestAvailable,
  loadInsuranceRequestPortalData,
} from "@/lib/insurance-requests";
import { rateLimit } from "@/lib/rate-limit";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Upload insurance documents · RESLU",
  robots: { index: false, follow: false },
};

export default async function InsuranceRequestPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const headerList = await headers();
  const clientIp =
    headerList.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!rateLimit(`insurance-page:${token}:${clientIp}`, 40, 60_000).ok) notFound();

  const supabase = createServiceRoleClient();
  const documentRequest = await loadInsuranceRequestPortalData(supabase, token);
  if (!documentRequest) notFound();

  const available = isInsuranceRequestAvailable(
    documentRequest.status,
    documentRequest.expires_at
  );

  if (available && documentRequest.status === "requested") {
    const openedAt = new Date().toISOString();
    await supabase
      .from("contact_document_requests")
      .update({ status: "opened", opened_at: openedAt })
      .eq("id", documentRequest.id)
      .eq("status", "requested");
    documentRequest.status = "opened";
    documentRequest.opened_at = openedAt;
  }

  return (
    <div className="min-h-screen bg-cream">
      <header className="border-b border-[#dcd6cc] px-6 py-7">
        <div className="mx-auto max-w-2xl">
          <Image
            src="/reslu-logo.png"
            alt="RESLU"
            width={130}
            height={57}
            priority
            className="h-12 w-auto"
          />
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-5 py-10 sm:px-6 sm:py-14">
        {!available && documentRequest.status !== "completed" ? (
          <section className="border border-[#dcd6cc] bg-offwhite p-7">
            <p className="label-caps text-sand">Link unavailable</p>
            <h1 className="mt-2 font-display text-section text-nearblack">
              This request has expired
            </h1>
            <p className="mt-3 text-body text-charcoal/70">
              Please reply to the RESLU email or contact Phillip for a new secure
              upload link.
            </p>
          </section>
        ) : (
          <>
            <p className="label-caps text-sand">Trade documentation</p>
            <h1 className="mt-2 font-display text-section text-nearblack">
              Upload your documents
            </h1>
            <p className="mt-3 text-body text-charcoal/70">
              Hi {documentRequest.contact_name?.split(/\s+/)[0] || "there"}, please
              provide the current documents below for {documentRequest.company}.
              Files are stored securely in RESLU’s trade register.
            </p>
            <ul className="my-7 space-y-1 border-y border-[#dcd6cc] py-5">
              {documentRequest.requested_kinds.map((kind) => (
                <li key={kind} className="flex gap-2 text-body text-charcoal/70">
                  <span className="text-sand">—</span>
                  <span>{INSURANCE_REQUEST_KIND_LABEL[kind]}</span>
                </li>
              ))}
            </ul>
            <InsuranceUploadPortal
              token={token}
              company={documentRequest.company}
              requestedKinds={documentRequest.requested_kinds}
              initialUploadedKinds={documentRequest.uploaded_kinds}
            />
            <p className="mt-6 text-caption text-charcoal/50">
              Need help? Reply to the request email and the RESLU team will assist.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
