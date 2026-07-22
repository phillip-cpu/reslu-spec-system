# Marketing dashboard

`/marketing` is an admin-only, read-only performance view joining Google Ads,
Meta Ads, Google Search Console and RESLU leads over one date range.

## Reporting rules

- Dates follow the Australia/Adelaide business calendar.
- Ranges are inclusive and capped at 366 days.
- Cost per lead is combined Google + Meta spend divided by RESLU leads received
  in the range.
- `Potential Future Lead` is explicitly excluded from the lead count, matching
  RESLU's rule that it is nurture work rather than active pipeline.
- Missing or failed integrations are shown as `Needs setup` / `Needs attention`;
  they are never presented as genuine zero spend or zero performance.
- The dashboard only reads source systems. It cannot change campaigns, budgets,
  leads, conversions or Search Console data.
- Organic performance separates `/blog/*` articles from the rest of the website
  and ranks both groups by clicks, then impressions.
- Each selected range is compared with the immediately preceding equivalent
  period. The organic opportunity score combines impressions, ranking proximity,
  CTR headroom and negative movement to recommend the next useful action.
- Organic recommendations are directional signals, not guaranteed traffic or
  ranking forecasts. They never modify the website automatically.
- Three or more simultaneous core-page declines are grouped into one site-wide
  diagnostic so indexing, sitemap, redirect, canonical and deployment checks
  happen before duplicate content tasks are created.
- A recommendation becomes work only when an admin clicks `Create action`.
  This creates a linked Marketing task in Office/My Work. The lifecycle is
  New → Approved → In progress → 28-day monitoring → Complete, with dismiss
  and reopen controls.
- `Approve + ask Aria` queues an `organic_review`. Aria can store a technical
  review and draft titles, descriptions, content changes and internal links.
  Neither Aria nor this workflow has a website-publishing route.
- High-opportunity decline signals require meaningful absolute evidence: an
  absolute click loss or a ranking loss backed by sufficient impressions.
  Small low-volume percentage swings are not treated as emergencies.

## Vercel environment variables

Set these for both Production and Preview. Values live in the Mac mini's
existing private Google/Meta environment files; never commit or paste them into
documentation.

```text
GOOGLE_ADS_DEVELOPER_TOKEN
GOOGLE_ADS_REFRESH_TOKEN
GOOGLE_ADS_CLIENT_ID
GOOGLE_ADS_CLIENT_SECRET
GOOGLE_ADS_CUSTOMER_ID
GOOGLE_ADS_LOGIN_CUSTOMER_ID       # optional manager account
GOOGLE_ADS_API_VERSION=v24         # optional explicit upgrade control

META_ACCESS_TOKEN
META_AD_ACCOUNT_ID

GOOGLE_SEARCH_CONSOLE_CLIENT_ID
GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET
GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN
GOOGLE_SEARCH_CONSOLE_SITE_URL=sc-domain:reslu.com.au
```

Adding or changing a Vercel environment variable requires a new deployment.

## Acceptance check

1. Sign in as an admin and open `/marketing`.
2. Confirm all four source pills show the expected state.
3. Compare 30-day Google and Meta spend with each platform's own dashboard.
4. Confirm Google and Meta conversion totals are separate and their sum matches
   the combined conversion card.
5. Confirm a known `Potential Future Lead` does not increase the lead count.
6. Compare Search Console clicks, impressions, CTR and average position using
   the same date range and `Web` search type.
7. Confirm highest-performing webpages and blog articles match Search Console's
   page results for the same range.
8. Spot-check an organic recommendation against the immediately preceding
   equivalent period.
9. Try the 7d, 30d and 90d presets and one custom range.

## Planned extensions

- Campaign budget pacing and conversion trend.
- CSV export.
- A separate campaigns/events/relationships workspace for AGSA donor activity,
  high-net-worth relationship strategy and other non-ad marketing initiatives.
