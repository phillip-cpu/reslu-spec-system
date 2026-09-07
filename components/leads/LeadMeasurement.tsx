"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { adelaideDate, latestReview, measurementSummary, reviewedStatus, sourceEvidence, REVIEW_STATUSES, type MeasurementLead, type ReviewStatus } from '@/lib/lead-measurement';

const labels: Record<ReviewStatus, string> = { unreviewed: 'Unreviewed', genuine: 'Genuine enquiry', qualified: 'Qualified opportunity', test: 'Test', spam: 'Spam', duplicate: 'Repeat enquiry' };

function ReviewEditor({ lead, leads }: { lead: MeasurementLead; leads: MeasurementLead[] }) {
  const router = useRouter();
  const review = latestReview(lead);
  const [status, setStatus] = useState<ReviewStatus>(reviewedStatus(lead, leads));
  const [reason, setReason] = useState('');
  const [original, setOriginal] = useState(review?.duplicate_of ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const originals = leads.filter(row => row.id !== lead.id && ['genuine', 'qualified'].includes(reviewedStatus(row, leads)));

  async function save() {
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/leads/measurement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lead_id: lead.id, status, reason, duplicate_of: original }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save review');
      setReason(''); setMessage('Review saved.'); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save review'); }
    finally { setBusy(false); }
  }

  return <details className="mt-4 border-t border-[#dcd6cc] pt-3">
    <summary className="cursor-pointer underline">Review classification</summary>
    <div className="mt-3 grid gap-3">
      <label>Category<select className="mt-1 block w-full border p-2" value={status} onChange={e => setStatus(e.target.value as ReviewStatus)}>{REVIEW_STATUSES.map(value => <option key={value} value={value}>{labels[value]}</option>)}</select></label>
      {status === 'duplicate' && <label>Original enquiry<select className="mt-1 block w-full border p-2" value={original} onChange={e => setOriginal(e.target.value)}><option value="">Choose the original</option>{originals.map(row => <option key={row.id} value={row.id}>{row.first_name} {row.surname_project} · {adelaideDate(row.received_at || row.created_at)}</option>)}</select></label>}
      <label>Reason<textarea className="mt-1 block w-full border p-2" value={reason} onChange={e => setReason(e.target.value)} maxLength={1000} placeholder="What confirms this classification?" /></label>
      <button type="button" disabled={busy || reason.trim().length < 5 || (status === 'duplicate' && !original)} onClick={save} className="justify-self-start bg-nearblack px-4 py-2 text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save review'}</button>
      <p role="status">{message}</p>
      {lead.lead_measurement_reviews.length > 0 && <details><summary className="cursor-pointer">Review history</summary><ul className="mt-2 space-y-2">{[...lead.lead_measurement_reviews].sort((a,b) => b.id-a.id).map(item => <li key={item.id}><strong>{labels[item.status]}</strong> · {adelaideDate(item.reviewed_at)}<p>{item.reason}</p></li>)}</ul></details>}
    </div>
  </details>;
}

export function LeadMeasurement({ leads }: { leads: MeasurementLead[] }) {
  const [end, setEnd] = useState(() => adelaideDate(new Date().toISOString()));
  const [start, setStart] = useState(() => adelaideDate(new Date(Date.now() - 27*86400000).toISOString()));
  const valid = !!start && !!end && start <= end;
  const rows = valid ? leads.filter(row => { const date = adelaideDate(row.received_at || row.created_at); return date >= start && date <= end; }) : [];
  const totals = measurementSummary(rows, leads);
  const cards = [['Raw submissions', totals.raw], ['Genuine unique enquiries', totals.genuine], ['Qualified opportunities', totals.qualified], ['Unreviewed', totals.unreviewed], ['Tests', totals.test], ['Spam', totals.spam], ['Repeat submissions', totals.duplicate]] as const;
  return <div className="space-y-6">
    <p>Website submissions received in the selected period. Dates use Adelaide time. Archived submissions remain visible for reconciliation.</p>
    <div className="flex flex-wrap gap-4"><label>From<input type="date" className="ml-2 border p-2" value={start} onChange={e => setStart(e.target.value)} /></label><label>To<input type="date" className="ml-2 border p-2" value={end} onChange={e => setEnd(e.target.value)} /></label></div>
    {!valid ? <p role="alert">Choose a valid date range.</p> : <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{cards.map(([label, count]) => <div key={label} className="border border-[#dcd6cc] bg-offwhite p-4"><p className="text-sm">{label}</p><p className="mt-2 text-3xl">{count}</p></div>)}</div>
      <p className="text-sm text-charcoal/80">Genuine enquiries include qualified opportunities. Qualification requires a review confirming that the project suits RESLU and is ready for an agreed next step. A form submission or booked visit alone does not qualify it. Sales stages are shown separately.</p>
      <p className="text-sm text-charcoal/80">Source labels show the evidence saved with the form. Missing tracking is shown as “Source not recorded”, rather than assumed to be direct or organic. This report does not change Google Analytics or Ads conversion settings.</p>
      {rows.length === 0 && <p>No website submissions in this period.</p>}
      <div className="grid gap-4 lg:grid-cols-2">{rows.map(lead => {
        const review = latestReview(lead);
        const status = reviewedStatus(lead, leads);
        const similar = lead.email && leads.some(other => other.id !== lead.id && other.email?.trim().toLowerCase() === lead.email?.trim().toLowerCase());
        return <article key={lead.id} className="min-w-0 border border-[#dcd6cc] p-4 sm:p-6">
          <h2 className="text-xl">{lead.first_name} {lead.surname_project.replace(/_.*$/, '')}</h2>
          <p className="mt-2 font-semibold">{labels[status]}</p>
          <p>{adelaideDate(lead.received_at || lead.created_at)} · {lead.stage}{lead.deleted_at ? ' · Archived' : ''}</p>
          <p className="mt-2 break-words">{sourceEvidence(lead)} · {lead.page || 'Page not recorded'}</p>
          {review && <p className="mt-2 text-sm">{review.reason}</p>}
          {similar && status === 'unreviewed' && <p className="mt-2 text-sm">Another submission uses this email. Check whether it is the same project before counting it separately.</p>}
          <ReviewEditor key={`${lead.id}-${review?.id ?? 0}`} lead={lead} leads={leads} />
        </article>;
      })}</div>
    </>}
  </div>;
}
