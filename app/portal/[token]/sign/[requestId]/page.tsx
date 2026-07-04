import type { Metadata } from "next";
import Image from "next/image";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/storage";
import { rateLimit } from "@/lib/rate-limit";
import { SIGNATURE_CONSENT_STATEMENT } from "@/lib/signatures";
import { SigningForm } from "@/components/portal/SigningForm";
import type { PortalSigningTarget } from "@/app/portal/types";

/**
 * /portal/[token]/sign/[requestId] — the dedicated signing page
 * (BUILD-SPEC.md §"Built-in digital signature"). Token-gated,
 * rate-limited, noindex, same trust model as every other portal page.
 * Server-fetches the signing target directly (rather than round-
 * tripping through the GET API route) to avoid an extra request on
 * first paint; the client-side SigningForm still calls the API route
 * for the actual POST /sign.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

async function resolveSubjectFilename(
  supabase: ReturnType<typeof createServiceRoleClient>,
  subjectType: string,
  subjectId: string
): Promise<string> {
  if (subjectType === "project_file") {
    const { data } = await supabase.from("project_files").select("filename").eq("id", subjectId).single();
    return data?.filename ?? "Document";
  }
  if (subjectType === "variation") {
    const { data } = await supabase.from("variations").select("var_number").eq("id", subjectId).single();
    return data ? `Variation ${data.var_number}` : "Variation";
  }
  return "Scope of Works";
}

export default async function SignPage({
  params,
}: {
  params: Promise<{ token: string; requestId: string }>;
}) {
  const { token, requestId } = await params;

  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",")[0]?.trim() || "unknown";
  const limit = rateLimit(`portal-sign-page:${token}:${clientIp}`);
  if (!limit.ok) {
    notFound();
  }

  const supabase = createServiceRoleClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id,name")
    .eq("client_token", token)
    .single();
  if (!project) notFound();

  const { data: signatureRequest } = await supabase
    .from("signature_requests")
    .select("id,project_id,subject_type,subject_id,status")
    .eq("id", requestId)
    .eq("project_id", project.id)
    .single();
  if (!signatureRequest) notFound();

  const filename = await resolveSubjectFilename(
    supabase,
    signatureRequest.subject_type,
    signatureRequest.subject_id
  );

  let documentUrl: string | null = null;
  if (signatureRequest.subject_type === "project_file") {
    const { data: file } = await supabase
      .from("project_files")
      .select("storage_path")
      .eq("id", signatureRequest.subject_id)
      .single();
    if (file) {
      const { data: signed } = await supabase.storage
        .from(ASSET_BUCKET)
        .createSignedUrl(file.storage_path, SIGNED_URL_TTL_SECONDS);
      documentUrl = signed?.signedUrl ?? null;
    }
  }

  const target: PortalSigningTarget = {
    request_id: signatureRequest.id,
    project_id: signatureRequest.project_id,
    subject_type: signatureRequest.subject_type,
    subject_id: signatureRequest.subject_id,
    status: signatureRequest.status,
    document_filename: filename,
    document_url: documentUrl,
  };

  return (
    <div className="min-h-screen bg-cream">
      <header className="border-b border-[#dcd6cc] bg-cream px-6 py-8">
        <div className="mx-auto max-w-2xl">
          <Image src="/reslu-logo.png" alt="RESLU" width={130} height={57} priority className="h-12 w-auto" />
          <h1 className="mt-6 font-display text-section text-nearblack">{project.name}</h1>
          <p className="mt-1 text-body text-charcoal/70">Review and sign</p>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-6 py-8">
        <SigningForm token={token} target={target} consentStatement={SIGNATURE_CONSENT_STATEMENT} />
      </main>

      <footer className="mx-auto max-w-2xl px-6 py-10 text-caption text-charcoal/40">
        RESLU · This is a private link. Please don&apos;t share it.
      </footer>
    </div>
  );
}
