// Bounded acquisition evidence, not inferred source or an automatic qualification.
const text = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) || null;
};
export function websiteAttribution(body: Record<string, unknown>) {
  const captured = text(body.attribution_captured_at, 40);
  const timestamp = captured ? Date.parse(captured) : NaN;
  const landing = text(body.attribution_landing_page, 200)?.split(/[?#]/)[0];
  return {
    gbraid: text(body.gbraid, 200),
    wbraid: text(body.wbraid, 200),
    utm_term: text(body.utm_term, 150),
    attribution_landing_page: landing?.startsWith('/') && !landing.startsWith('//') ? landing : null,
    attribution_captured_at: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
    rooms: Array.isArray(body.rooms) ? [...new Set(body.rooms.slice(0, 12).map(v => text(v, 60)).filter((v): v is string => !!v))] : [],
  };
}
