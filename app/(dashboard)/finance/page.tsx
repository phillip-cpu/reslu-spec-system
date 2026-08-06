import { Header } from "@/components/layout/Header";
import { FinanceCockpit } from "@/components/finance/FinanceCockpit";
import { getUserRole } from "@/lib/auth";
import { financeFoundationEnabled } from "@/lib/finance/feature-flags";
import { hasFinanceCapability } from "@/lib/finance/permissions";
import { createClient } from "@/lib/supabase/server";

function Unavailable({ title, message }: { title: string; message: string }) {
  return (
    <>
      <Header title="Finance" subtitle="Company cash and construction exposure" />
      <main className="flex-1 px-4 py-10 md:px-8">
        <div className="mx-auto max-w-xl border border-charcoal/20 bg-offwhite p-8 text-center">
          <p className="label-caps">Finance unavailable</p>
          <h1 className="mt-3 font-display text-section text-nearblack">{title}</h1>
          <p className="mt-3 text-body text-charcoal/60">{message}</p>
        </div>
      </main>
    </>
  );
}

export default async function FinancePage() {
  if (!financeFoundationEnabled()) {
    return (
      <Unavailable
        title="The finance kill switch is off"
        message="Apply migration 080 and complete the permission checks before enabling FINANCE_FOUNDATION_ENABLED."
      />
    );
  }
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  if (!user) return <Unavailable title="Sign in required" message="Sign in to access the finance cockpit." />;
  const permission = await hasFinanceCapability(supabase, "finance.view_company");
  if (permission.error) {
    return <Unavailable title="Finance is not configured" message={permission.error} />;
  }
  if (!permission.allowed) {
    return <Unavailable title="Company finance is restricted" message="Ask a finance administrator for company-view access." />;
  }

  return (
    <>
      <Header title="Finance" subtitle="Company cash and construction exposure" />
      <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
        <FinanceCockpit />
      </main>
    </>
  );
}
