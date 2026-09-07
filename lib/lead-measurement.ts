export const REVIEW_STATUSES = ['unreviewed', 'genuine', 'qualified', 'test', 'spam', 'duplicate'] as const;
export type ReviewStatus = typeof REVIEW_STATUSES[number];
export type MeasurementReview = { id: number; status: ReviewStatus; reason: string; duplicate_of: string | null; reviewed_at: string };
export type MeasurementLead = {
  id: string; first_name: string | null; surname_project: string; email: string | null;
  received_at: string | null; created_at: string; deleted_at: string | null;
  stage: string; page: string | null; gclid: string | null;
  utm_source: string | null; utm_medium: string | null;
  lead_measurement_reviews: MeasurementReview[];
};

export function latestReview(lead: MeasurementLead): MeasurementReview | undefined {
  return lead.lead_measurement_reviews.reduce<MeasurementReview | undefined>((latest, row) =>
    !latest || row.id > latest.id ? row : latest, undefined);
}

export function adelaideDate(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Adelaide', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find(p => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

// A repeat submission is excluded only after review against a genuine original.
// If that original is subsequently reclassified, the repeat needs review again.
export function reviewedStatus(lead: MeasurementLead, all: MeasurementLead[]): ReviewStatus {
  const review = latestReview(lead);
  if (review?.status !== 'duplicate') return review?.status ?? 'unreviewed';
  const original = all.find(row => row.id === review.duplicate_of && row.id !== lead.id);
  const originalStatus = original && latestReview(original)?.status;
  return originalStatus === 'genuine' || originalStatus === 'qualified' ? 'duplicate' : 'unreviewed';
}

export function measurementSummary(rows: MeasurementLead[], all: MeasurementLead[] = rows) {
  const counts = { raw: rows.length, genuine: 0, qualified: 0, unreviewed: 0, test: 0, spam: 0, duplicate: 0 };
  for (const row of rows) {
    const status = reviewedStatus(row, all);
    counts[status]++;
    if (status === 'qualified') counts.genuine++;
  }
  return counts;
}

export function sourceEvidence(lead: MeasurementLead): string {
  if (lead.gclid?.trim()) return 'Google Ads click ID recorded';
  if (lead.utm_source?.trim()) return [lead.utm_source, lead.utm_medium].filter(Boolean).join(' / ');
  return 'Source not recorded';
}
