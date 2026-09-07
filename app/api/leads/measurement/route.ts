import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getUserRole } from '@/lib/auth';
import { REVIEW_STATUSES } from '@/lib/lead-measurement';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (info.role !== 'admin') return NextResponse.json({ error: 'Only admins can review enquiries' }, { status: 403 });
  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || !UUID.test(body.lead_id ?? '') || !REVIEW_STATUSES.includes(body.status) || typeof body.reason !== 'string' || body.reason.trim().length < 5 || body.reason.length > 1000) {
    return NextResponse.json({ error: 'Choose a category and give a reason (5–1,000 characters).' }, { status: 400 });
  }
  const { data: lead, error: leadError } = await supabase.from('leads').select('id').eq('id', body.lead_id).eq('source', 'WEBSITE').maybeSingle();
  if (leadError) return NextResponse.json({ error: 'Could not load enquiry' }, { status: 500 });
  if (!lead) return NextResponse.json({ error: 'Website enquiry not found' }, { status: 404 });
  const duplicateOf = body.status === 'duplicate' ? body.duplicate_of : null;
  if (body.status === 'duplicate') {
    if (!UUID.test(duplicateOf ?? '') || duplicateOf === body.lead_id) return NextResponse.json({ error: 'Select the original enquiry.' }, { status: 400 });
    const { data: original, error: originalError } = await supabase.from('leads').select('id').eq('id', duplicateOf).eq('source', 'WEBSITE').maybeSingle();
    const { data: review, error: reviewError } = await supabase.from('lead_measurement_reviews').select('status').eq('lead_id', duplicateOf).order('id', { ascending: false }).limit(1).maybeSingle();
    if (originalError || reviewError) return NextResponse.json({ error: 'Could not check the original enquiry' }, { status: 500 });
    if (!original || !review || !['genuine', 'qualified'].includes(review.status)) return NextResponse.json({ error: 'Review the original as genuine or qualified first.' }, { status: 400 });
  }
  const { error } = await supabase.from('lead_measurement_reviews').insert({ lead_id: body.lead_id, status: body.status, reason: body.reason.trim(), duplicate_of: duplicateOf, reviewed_by: info.userId });
  if (error) return NextResponse.json({ error: 'Could not save review. Please try again.' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
