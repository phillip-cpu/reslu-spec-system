import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getUserRole } from '@/lib/auth';
import { Header } from '@/components/layout/Header';
import { LeadMeasurement } from '@/components/leads/LeadMeasurement';
import type { MeasurementLead } from '@/lib/lead-measurement';

export const dynamic = 'force-dynamic';

export default async function LeadMeasurementPage() {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (info?.role !== 'admin') return <><Header title="Website enquiries" /><main className="p-8">This report is restricted to admins.</main></>;

  const rows: MeasurementLead[] = [];
  let failure = '';
  // Include archived submissions: deleting a test must not erase its audit trail.
  // Explicit pagination prevents the database's default row cap changing totals.
  for (let offset = 0; ; offset += 500) {
    if (offset >= 10000) { failure = 'This report exceeds 10,000 submissions. Narrowing the server query is required before totals can be shown.'; break; }
    const { data, error } = await supabase.from('leads')
      .select('id,first_name,surname_project,email,received_at,created_at,deleted_at,stage,page,gclid,utm_source,utm_medium,lead_measurement_reviews:lead_measurement_reviews!lead_measurement_reviews_lead_id_fkey(id,status,reason,duplicate_of,reviewed_at)')
      .eq('source', 'WEBSITE').order('created_at', { ascending: false }).order('id').range(offset, offset + 499);
    if (error) { failure = 'The enquiry report could not load. Please try again.'; break; }
    rows.push(...(data ?? []) as unknown as MeasurementLead[]);
    if (!data || data.length < 500) break;
  }
  return <><Header title="Website enquiries" subtitle="Review submissions before counting them as opportunities." />
    <main className="flex-1 px-4 py-8 sm:px-8">
      <Link className="mb-6 inline-block underline" href="/leads">Back to leads</Link>
      {failure ? <p role="alert">{failure}</p> : <LeadMeasurement leads={rows} />}
    </main></>;
}
