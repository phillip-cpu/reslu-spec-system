-- ============================================================
-- RESLU Spec System — Health + web push (r26)
-- BUILD-SPEC.md §"Health + web push (r26)" item 1, verbatim column
-- lists (5 tables): health_heartbeats, health_channels,
-- health_diagnostics, push_subscriptions, notifications.
--
-- Phillip 2026-07-13: "Mini can't be reached from Vercel -> mini
-- heartbeats OUT; diagnostics = queued request the mini picks up.
-- Monitoring must burn zero AI credits (dumb scripts + timestamp
-- comparisons); Claude Code repair sessions run ONLY on explicit
-- button press." None of these five tables are ever read/written by an
-- LLM call path — every route this migration backs is a plain CRUD
-- read/write + a timestamp comparison (see app/api/health/*,
-- lib/push.ts, lib/health.ts). The MCP tools that wrap some of these
-- routes (post_heartbeat, report_channel_status,
-- get_pending_diagnostics, complete_diagnostic — mcp/src/index.mjs)
-- exist so Aria CAN call them conversationally, but the mini's actual
-- automated heartbeat/diagnostics loop (docs/MINI-HEALTH-HANDOFF.md)
-- is a plain bash+curl script hitting the REST routes directly — no
-- model in that loop at all.
--
-- Conventions carried over from every prior migration (051 most
-- recently):
--   - uuid pks via gen_random_uuid()
--   - text + CHECK instead of a Postgres enum (house style)
--   - idempotent throughout (create table if not exists / drop+recreate
--     policy) so a partial apply converges cleanly on re-run
--   - RLS: single permissive "team_all" policy (Phase 1 — "no
--     unenforced role theatre"; real enforcement — mini-only write
--     endpoints, admin-only diagnostics trigger, per-user push
--     subscription ownership — happens at the API route layer, exactly
--     like every other table in this schema)
-- ============================================================

-- ============================================================
-- PART 1 — health_heartbeats
-- Mini posts one row roughly every 5 minutes (docs/MINI-HEALTH-
-- HANDOFF.md's launchd heartbeat script). "keep latest + prune >7
-- days" (item 1) — this migration does NOT add a cron-side prune job
-- (no pg_cron in this schema's existing convention); POST
-- /api/health/heartbeat prunes rows older than 7 days as part of every
-- insert (see that route's own comment) — simplest place to do it
-- since it already runs on the same ~5 min cadence the retention
-- window is measured against.
-- ============================================================
create table if not exists health_heartbeats (
  id              uuid primary key default gen_random_uuid(),
  uptime          text,
  disk_free_gb    numeric(10,2),
  mem_free_gb     numeric(10,2),
  openclaw_up     boolean,
  pending_updates integer,
  -- Anything the mini's heartbeat script wants to report that doesn't
  -- warrant its own column yet (e.g. CPU temp, load average) — free-
  -- form, never relied on by any query in this round beyond passthrough
  -- display on the Health page's mini card.
  extra           jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

-- Primary read shape: "the single most recent heartbeat" (Health page
-- mini card, GET /api/health/check's silence comparison).
create index if not exists idx_health_heartbeats_created_at on health_heartbeats(created_at desc);

comment on table health_heartbeats is
  'Health + web push round (r26). Mini (Aria''s Mac mini) posts a row roughly every 5 minutes via POST /api/health/heartbeat — see docs/MINI-HEALTH-HANDOFF.md. Vercel cannot reach the mini directly (no inbound network path), so all mini liveness is inferred from these OUTBOUND posts going quiet (GET /api/health/check, the silence-checker cron) rather than any kind of ping. Rows older than 7 days are pruned by the heartbeat route itself on each insert — "keep latest + prune >7 days" per BUILD-SPEC.md item 1.';
comment on column health_heartbeats.uptime is 'Free text as reported by the mini (e.g. output of `uptime`) — display-only, never parsed for a threshold comparison (created_at is what silence-checking compares against, not this).';
comment on column health_heartbeats.openclaw_up is 'Whether the mini''s own health-check considers the OpenClaw agent process alive. GET /api/health/check treats the latest heartbeat''s openclaw_up=false as its own incident (kind ''openclaw_down''), independent of the heartbeat-silence check.';
comment on column health_heartbeats.pending_updates is 'Count of pending macOS updates as reported by the mini (softwareupdate -l, see docs/MINI-HEALTH-HANDOFF.md). >0 renders an amber warning on the Health page mini card ("macOS update pending — WhatsApp bridge may drop after reboot") — a warning, not a push-worthy incident on its own.';

alter table health_heartbeats enable row level security;

drop policy if exists "team_all" on health_heartbeats;
create policy "team_all" on health_heartbeats
  for all to authenticated using (true) with check (true);

-- ============================================================
-- PART 2 — health_channels
-- One row per monitored channel (whatsapp group id / email / calendar
-- — "channel key" per item 1's own wording), upserted by the mini via
-- POST /api/health/channel-status (report_channel_status MCP tool).
-- ============================================================
create table if not exists health_channels (
  id              uuid primary key default gen_random_uuid(),
  channel         text not null unique,
  label           text,
  status          text not null default 'ok' check (status in ('ok', 'degraded', 'down')),
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  session_valid   boolean,
  note            text,
  updated_at      timestamptz not null default now()
);

comment on table health_channels is
  'Health + web push round (r26). One row per channel the mini monitors (WhatsApp group bridge, email, RESLU calendar — "channel key: whatsapp group id/email/calendar" per BUILD-SPEC.md item 1), upserted (on conflict (channel)) by POST /api/health/channel-status. status degraded/down or session_valid=false fires a deduped incident notification (see lib/push.ts''s notifyAdminsOnce) — "one alert per incident, not per check" (item 5): the incident stays open (unread) until either the channel reports ok again (route auto-resolves) or a human reads the notification.';
comment on column health_channels.channel is 'Stable machine key, e.g. ''whatsapp'', ''email'', ''calendar'' — NOT a display label (see `label`). Upsert key.';
comment on column health_channels.session_valid is 'Whether the channel''s login/session is still valid (e.g. WhatsApp Web QR session not expired) — distinct from `status`, since a channel can be status=''ok'' generally but have session_valid flip false as an early warning before it actually goes down.';

drop trigger if exists trg_health_channels_updated_at on health_channels;
create trigger trg_health_channels_updated_at
  before update on health_channels
  for each row execute function set_updated_at();

alter table health_channels enable row level security;

drop policy if exists "team_all" on health_channels;
create policy "team_all" on health_channels
  for all to authenticated using (true) with check (true);

-- ============================================================
-- PART 3 — health_diagnostics
-- "diagnostics = queued request the mini picks up" — a diagnostics run
-- is requested from the Health page (POST /api/health/diagnostics,
-- admin-only, explicit button press per the standing credits ruling),
-- then picked up + completed by the mini's own poll loop (GET
-- /api/health/diagnostics/pending, POST .../[id]/complete —
-- get_pending_diagnostics/complete_diagnostic MCP tools).
-- ============================================================
create table if not exists health_diagnostics (
  id             uuid primary key default gen_random_uuid(),
  requested_by   uuid references profiles(id) on delete set null,
  requested_at   timestamptz not null default now(),
  status         text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  report         text,
  completed_at   timestamptz
);

create index if not exists idx_health_diagnostics_status on health_diagnostics(status, requested_at);

comment on table health_diagnostics is
  'Health + web push round (r26). A diagnostics/repair run requested by an admin pressing "Run diagnostics & repair" on the Health page (POST /api/health/diagnostics — inserts this row status=''pending'' + a notifications row + push, per BUILD-SPEC.md item 4). The mini''s poll loop claims pending rows (GET /api/health/diagnostics/pending flips them to ''running'' as it returns them) and reports back via POST /api/health/diagnostics/[id]/complete (status done|failed + `report`), which fires a completion push carrying the first ~200 chars of `report` (item 6). This is NOT a Claude Code repair session — those run only on Phillip''s own explicit, separate button press outside this system (standing credits ruling); this queue is the mini''s own dumb repair script (restart WhatsApp bridge, verify session, check softwareupdate -l — see docs/MINI-HEALTH-HANDOFF.md), zero AI credits either side.';
comment on column health_diagnostics.report is 'Free text the mini''s repair script assembles (what it checked, what it restarted, current state) — shown in full on the Health page, truncated to ~200 chars in the completion push body.';

alter table health_diagnostics enable row level security;

drop policy if exists "team_all" on health_diagnostics;
create policy "team_all" on health_diagnostics
  for all to authenticated using (true) with check (true);

-- ============================================================
-- PART 4 — push_subscriptions
-- One row per browser/device push subscription (Settings -> Push
-- notifications toggle). No new npm dependency (web-push is NOT in
-- package.json — see this round's own final report): the payload-less
-- VAPID approach (lib/push.ts) needs only endpoint/p256dh/auth off the
-- PushSubscription object, same three fields any web-push-based
-- implementation would need too.
-- ============================================================
create table if not exists push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_push_subscriptions_user on push_subscriptions(user_id);

comment on table push_subscriptions is
  'Health + web push round (r26). One row per subscribed browser/device (PushSubscription.endpoint is globally unique per browser install, hence the unique constraint — also the natural upsert key for a re-subscribe). p256dh/auth are the subscription''s own encryption keys (base64url, as delivered by the Push API) — unused by the payload-less send path itself (lib/push.ts sends an empty body, so no payload encryption ever happens), kept because they are part of the standard PushSubscriptionJSON shape and cost nothing to store now against a future encrypted-payload upgrade. sendPushToAdmins (lib/push.ts) only ever targets subscriptions whose user_id is an admin profile — a non-admin can still enable push (the Settings toggle is not admin-gated), the row is simply never targeted by any current trigger.';

alter table push_subscriptions enable row level security;

drop policy if exists "team_all" on push_subscriptions;
create policy "team_all" on push_subscriptions
  for all to authenticated using (true) with check (true);

-- ============================================================
-- PART 5 — notifications
-- The row a push wakes the service worker up to go and fetch (GET
-- /api/notifications/latest-unread) — see public/sw.js. Every push
-- trigger in this round inserts one of these FIRST, then calls
-- lib/push.ts's sendPushToAdmins — the push itself carries no payload
-- (item 2: "payload-less push... wakes the service worker, which
-- fetches /api/notifications/latest-unread"), this row is the only
-- place the actual title/body/link ever lives.
-- ============================================================
create table if not exists notifications (
  id         uuid primary key default gen_random_uuid(),
  -- null = all-admins (per item 1's own wording) — every trigger in
  -- this round inserts user_id=null; a genuinely per-user notification
  -- is schema-ready but not populated by any route yet.
  user_id    uuid references profiles(id) on delete cascade,
  kind       text not null,
  title      text not null,
  body       text,
  link_href  text,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);

-- GET /api/notifications/latest-unread's own query shape: "most recent
-- unread row visible to this user" (user_id = me OR user_id is null).
create index if not exists idx_notifications_unread on notifications(read_at, created_at desc);
create index if not exists idx_notifications_user on notifications(user_id, read_at, created_at desc);
-- lib/push.ts's notifyAdminsOnce dedupe query: "is there already an
-- open (unread) notification of this exact kind" — the incident-dedupe
-- mechanism per item 5 ("dedupe: one alert per incident, not per
-- check"), reusing read_at as the open/closed marker rather than a
-- second incident-tracking table.
create index if not exists idx_notifications_kind_unread on notifications(kind, read_at);

comment on table notifications is
  'Health + web push round (r26). user_id null = visible to every admin (the only shape any route in this round populates — trade accept/suggest, proposal signed, health incidents, diagnostics done). kind is a free-text discriminator (not CHECK-constrained — new kinds land without a migration, matching aria_queue.kind''s original pre-widened-constraint looseness before this schema settled on a fixed list for THAT table); see lib/push.ts for the kind values this round actually writes. read_at doubles as both "has anyone seen this" (Health-adjacent UI, if any) AND the incident-dedupe open/closed marker for lib/push.ts''s notifyAdminsOnce — an incident kind stays deduped (no repeat push) for as long as its most recent row of that kind is unread; it auto-resolves (marked read) when the underlying condition clears (see app/api/health/channel-status/route.ts and app/api/health/check/route.ts) or a human reads it.';
comment on column notifications.kind is 'Free-text discriminator, e.g. ''trade_confirmed'', ''trade_suggested'', ''proposal_signed'', ''mini_silent'', ''openclaw_down'', ''channel_down:{channel}'', ''cron_missed:{name}'', ''diagnostics_requested'', ''diagnostics_done''. Kept free text (not CHECK-constrained) since this round''s own incident kinds are dynamically suffixed (channel_down:whatsapp, cron_missed:brief_generate) — a CHECK-in-list would need to enumerate every channel/cron name up front.';
comment on column notifications.link_href is 'Deep link the service worker''s notificationclick handler opens (public/sw.js) — same "deep link to the real thing" role as daily_brief_items.link_href.';

alter table notifications enable row level security;

drop policy if exists "team_all" on notifications;
create policy "team_all" on notifications
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
