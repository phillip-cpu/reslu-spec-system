-- ============================================================
-- RESLU Spec System — Trade-booking delivery tracking (Phase 3A)
--
-- Adds durable evidence for the question the booking UI previously
-- could not answer: was the request queued, accepted by Resend,
-- accepted by the recipient's mail server, opened/clicked, or acted
-- on through the tokened booking page?
--
-- `email_sends.status` deliberately remains the transport queue state
-- (pending|sent|skipped). Provider events live in their own columns so
-- existing guards/flushers keep their established semantics.
-- ============================================================

alter table email_sends
  add column if not exists provider_message_id text;
alter table email_sends
  add column if not exists provider_status text;
alter table email_sends
  add column if not exists provider_last_event_at timestamptz;
alter table email_sends
  add column if not exists delivered_at timestamptz;
alter table email_sends
  add column if not exists opened_at timestamptz;
alter table email_sends
  add column if not exists clicked_at timestamptz;
alter table email_sends
  add column if not exists bounced_at timestamptz;
alter table email_sends
  add column if not exists failed_at timestamptz;
alter table email_sends
  add column if not exists delivery_delayed_at timestamptz;
alter table email_sends
  add column if not exists complained_at timestamptz;
alter table email_sends
  add column if not exists suppressed_at timestamptz;

create unique index if not exists idx_email_sends_provider_message_id
  on email_sends(provider_message_id)
  where provider_message_id is not null;

comment on column email_sends.provider_message_id is
  'Resend email id returned by POST /emails. Used to join signed webhook events back to this durable send record.';
comment on column email_sends.delivered_at is
  'Resend email.delivered timestamp: the receiving mail server accepted the message. This is not proof that a human read it.';
comment on column email_sends.opened_at is
  'First Resend email.opened timestamp. Open tracking is useful evidence but not definitive proof of a human read because privacy tools and image proxies can affect it.';

alter table trade_booking_requests
  add column if not exists viewed_at timestamptz;

comment on column trade_booking_requests.viewed_at is
  'First non-preview load of the public tokened booking page. Stronger engagement evidence than an email-open pixel; stamped once by /trade-request/[token].';

create table if not exists resend_webhook_events (
  event_id            text primary key,
  provider_message_id text,
  event_type          text not null,
  event_at            timestamptz not null,
  payload             jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

create index if not exists idx_resend_webhook_events_message
  on resend_webhook_events(provider_message_id, event_at desc);

alter table resend_webhook_events enable row level security;

comment on table resend_webhook_events is
  'Signed Resend webhook receipts, keyed by Svix event id for at-least-once delivery dedupe. Service-role only; no authenticated-client RLS policy is required.';

-- One atomic event recorder handles both webhook dedupe and
-- out-of-order delivery. Event-specific timestamps preserve every
-- piece of evidence; provider_status only advances to the newest
-- event by provider event time.
create or replace function record_resend_email_event(
  p_event_id text,
  p_provider_message_id text,
  p_event_type text,
  p_event_at timestamptz,
  p_payload jsonb
)
returns integer
language plpgsql
as $$
declare
  v_updated integer := 0;
begin
  insert into resend_webhook_events (
    event_id, provider_message_id, event_type, event_at, payload
  ) values (
    p_event_id, p_provider_message_id, p_event_type, p_event_at, coalesce(p_payload, '{}'::jsonb)
  )
  on conflict (event_id) do nothing;

  update email_sends
  set
    provider_status = case
      when provider_last_event_at is null or p_event_at >= provider_last_event_at then p_event_type
      else provider_status
    end,
    provider_last_event_at = greatest(coalesce(provider_last_event_at, p_event_at), p_event_at),
    delivered_at = case when p_event_type = 'email.delivered' then coalesce(delivered_at, p_event_at) else delivered_at end,
    opened_at = case when p_event_type = 'email.opened' then coalesce(opened_at, p_event_at) else opened_at end,
    clicked_at = case when p_event_type = 'email.clicked' then coalesce(clicked_at, p_event_at) else clicked_at end,
    bounced_at = case when p_event_type = 'email.bounced' then coalesce(bounced_at, p_event_at) else bounced_at end,
    failed_at = case when p_event_type = 'email.failed' then coalesce(failed_at, p_event_at) else failed_at end,
    delivery_delayed_at = case when p_event_type = 'email.delivery_delayed' then coalesce(delivery_delayed_at, p_event_at) else delivery_delayed_at end,
    complained_at = case when p_event_type = 'email.complained' then coalesce(complained_at, p_event_at) else complained_at end,
    suppressed_at = case when p_event_type = 'email.suppressed' then coalesce(suppressed_at, p_event_at) else suppressed_at end
  where provider_message_id = p_provider_message_id;

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

comment on function record_resend_email_event(text, text, text, timestamptz, jsonb) is
  'Phase 3A. Idempotently records signed Resend webhook events and attaches them to email_sends by provider_message_id, preserving out-of-order event evidence.';

-- Very rarely, a webhook can arrive in the milliseconds between
-- Resend returning its id and email_sends being written. Reconcile any
-- already-stored events whenever provider_message_id first lands, so
-- that race cannot lose delivery evidence.
create or replace function reconcile_resend_events_for_email_send()
returns trigger
language plpgsql
as $$
begin
  if new.provider_message_id is null then
    return new;
  end if;

  new.provider_status := coalesce((
    select event_type from resend_webhook_events
    where provider_message_id = new.provider_message_id
    order by event_at desc limit 1
  ), new.provider_status);
  new.provider_last_event_at := coalesce((
    select event_at from resend_webhook_events
    where provider_message_id = new.provider_message_id
    order by event_at desc limit 1
  ), new.provider_last_event_at);

  new.delivered_at := coalesce((select min(event_at) from resend_webhook_events where provider_message_id = new.provider_message_id and event_type = 'email.delivered'), new.delivered_at);
  new.opened_at := coalesce((select min(event_at) from resend_webhook_events where provider_message_id = new.provider_message_id and event_type = 'email.opened'), new.opened_at);
  new.clicked_at := coalesce((select min(event_at) from resend_webhook_events where provider_message_id = new.provider_message_id and event_type = 'email.clicked'), new.clicked_at);
  new.bounced_at := coalesce((select min(event_at) from resend_webhook_events where provider_message_id = new.provider_message_id and event_type = 'email.bounced'), new.bounced_at);
  new.failed_at := coalesce((select min(event_at) from resend_webhook_events where provider_message_id = new.provider_message_id and event_type = 'email.failed'), new.failed_at);
  new.delivery_delayed_at := coalesce((select min(event_at) from resend_webhook_events where provider_message_id = new.provider_message_id and event_type = 'email.delivery_delayed'), new.delivery_delayed_at);
  new.complained_at := coalesce((select min(event_at) from resend_webhook_events where provider_message_id = new.provider_message_id and event_type = 'email.complained'), new.complained_at);
  new.suppressed_at := coalesce((select min(event_at) from resend_webhook_events where provider_message_id = new.provider_message_id and event_type = 'email.suppressed'), new.suppressed_at);
  return new;
end;
$$;

drop trigger if exists trg_email_sends_reconcile_resend_events on email_sends;
create trigger trg_email_sends_reconcile_resend_events
  before insert or update of provider_message_id on email_sends
  for each row
  when (new.provider_message_id is not null)
  execute function reconcile_resend_events_for_email_send();

notify pgrst, 'reload schema';
