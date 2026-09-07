create table public.lead_measurement_reviews (
  id bigint generated always as identity primary key,
  lead_id uuid not null references public.leads(id),
  status text not null check (status in ('unreviewed','genuine','qualified','test','spam','duplicate')),
  reason text not null check (char_length(trim(reason)) between 5 and 1000),
  duplicate_of uuid references public.leads(id),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz not null default now(),
  check ((status = 'duplicate' and duplicate_of is not null and duplicate_of <> lead_id) or (status <> 'duplicate' and duplicate_of is null))
);
create index lead_measurement_reviews_lead_idx on public.lead_measurement_reviews(lead_id, id desc);
create index lead_measurement_reviews_duplicate_idx on public.lead_measurement_reviews(duplicate_of);
create index lead_measurement_reviews_reviewer_idx on public.lead_measurement_reviews(reviewed_by);
alter table public.lead_measurement_reviews enable row level security;
revoke all on public.lead_measurement_reviews from anon, authenticated;
grant select, insert on public.lead_measurement_reviews to authenticated;
grant usage, select on sequence public.lead_measurement_reviews_id_seq to authenticated;
grant all on public.lead_measurement_reviews to service_role;
grant usage, select on sequence public.lead_measurement_reviews_id_seq to service_role;
create policy measurement_admin_read on public.lead_measurement_reviews for select to authenticated
using (exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin'));
create policy measurement_admin_insert on public.lead_measurement_reviews for insert to authenticated
with check (reviewed_by = (select auth.uid()) and exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin'));
notify pgrst, 'reload schema';
