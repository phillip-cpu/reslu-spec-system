import type { Metadata } from "next";
import Image from "next/image";
import { createClient } from "@/lib/supabase/server";
import { CaptureWorkspace } from "@/components/capture/CaptureWorkspace";

/**
 * /capture — Site capture + mobile QoL round (r21), BUILD-SPEC.md
 * item 1a. Authenticated (team/Phillip), NOT under the (dashboard)
 * route group — deliberately outside the desktop Sidebar shell so the
 * whole viewport is available for a mobile, save-to-homescreen,
 * "point camera at thing, tap once" flow. Middleware auth still
 * applies (this path is absent from lib/supabase/middleware.ts's
 * public allowlist, so an unauthenticated request is redirected to
 * /login exactly like every other authenticated route) — no
 * middleware change needed or made here.
 *
 * PWA: this route gets its OWN manifest (public/manifest-capture.json,
 * start_url "/capture", name "RESLU Site"), distinct from the shared
 * app-wide public/manifest.json (name "RESLU Spec System", start_url
 * "/") that a prior "mobile pass" round already shipped and links from
 * app/layout.tsx. Overriding `manifest`/`appleWebApp`/`icons` here
 * (Next.js metadata merges parent+child objects key-by-key, so setting
 * these three keys on this page's own `metadata` export fully replaces
 * the root layout's values for requests under /capture, without
 * touching app/layout.tsx at all) means "Add to Home Screen" from this
 * page installs its own icon/name that launches straight back into
 * /capture — while the main dashboard's existing install experience
 * (from any other page) is completely unaffected. Icons are the SAME
 * existing PNGs already in public/ (icon-192.png / icon-512.png /
 * apple-touch-icon.png) — no new binary asset was generated for this.
 */
export const metadata: Metadata = {
  title: "RESLU Site Capture",
  description: "Capture site photos, notes, and voice recordings for RESLU jobs.",
  manifest: "/manifest-capture.json",
  robots: { index: false, follow: false },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "RESLU Site",
  },
};

export default async function CapturePage() {
  const supabase = await createClient();

  // "job picker at top (active projects)" — BUILD-SPEC.md item 1a.
  // Same trust tier as every other project list in this app (team_all
  // RLS) — no admin gating, financial fields are never selected here.
  const { data: projects } = await supabase
    .from("projects")
    .select("id,name,client_name")
    .eq("status", "active")
    .order("name", { ascending: true });

  return (
    <div className="min-h-screen bg-cream">
      <header className="border-b border-[#dcd6cc] bg-cream px-4 py-6">
        <Image src="/reslu-logo.png" alt="RESLU" width={130} height={57} priority className="h-10 w-auto" />
        <p className="label-caps mt-2 text-sand">Site capture</p>
      </header>
      <main className="mx-auto max-w-md px-4 py-5">
        <CaptureWorkspace projects={projects ?? []} />
      </main>
    </div>
  );
}
