import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { MarketingDashboard } from "@/components/marketing/MarketingDashboard";
import { defaultMarketingRange } from "@/lib/marketing";

/**
 * /marketing — Marketing performance dashboard (admin-only).
 * Shows Google Ads, Meta Ads, lead pipeline costs, and SEO metrics
 * from Google Search Console — all over a user-selected date range.
 */
export default async function MarketingPage() {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  const isAdmin = info?.role === "admin";
  const initialRange = defaultMarketingRange();

  if (!isAdmin) {
    return (
      <>
        <Header title="Marketing" />
        <main className="flex-1 px-8 py-16">
          <div className="mx-auto max-w-md border border-[#dcd6cc] bg-offwhite p-8 text-center">
            <p className="label-caps mb-2">Restricted</p>
            <p className="text-body text-charcoal/70">
              This area is restricted to admins.
            </p>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <Header
        title="Marketing"
        subtitle="Google Ads · Meta Ads · SEO · Cost per lead"
      />
      <main className="flex-1 px-4 py-6 sm:px-8 sm:py-8">
        <MarketingDashboard initialFrom={initialRange.from} initialTo={initialRange.to} />
      </main>
    </>
  );
}
