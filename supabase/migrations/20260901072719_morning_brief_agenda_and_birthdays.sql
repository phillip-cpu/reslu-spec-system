-- Birthdays deliberately store month + day only. RESLU needs the recurring
-- occasion, not a sensitive year of birth or inferred age.
alter table public.profiles add column if not exists birthday text;
alter table public.contacts add column if not exists birthday text;

alter table public.profiles
  drop constraint if exists profiles_birthday_check;
alter table public.profiles
  add constraint profiles_birthday_check check (
    case
      when birthday is null then true
      when birthday ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' then
        split_part(birthday, '-', 2)::integer <= case split_part(birthday, '-', 1)::integer
          when 2 then 29 when 4 then 30 when 6 then 30 when 9 then 30 when 11 then 30 else 31 end
      else false
    end
  );

alter table public.contacts
  drop constraint if exists contacts_birthday_check;
alter table public.contacts
  add constraint contacts_birthday_check check (
    case
      when birthday is null then true
      when birthday ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' then
        split_part(birthday, '-', 2)::integer <= case split_part(birthday, '-', 1)::integer
          when 2 then 29 when 4 then 30 when 6 then 30 when 9 then 30 when 11 then 30 else 31 end
      else false
    end
  );

create index if not exists profiles_birthday_idx on public.profiles (birthday) where birthday is not null;
create index if not exists contacts_birthday_idx on public.contacts (birthday) where birthday is not null and deleted_at is null;

comment on column public.profiles.birthday is 'Recurring team birthday in MM-DD format; the year is intentionally not collected.';
comment on column public.contacts.birthday is 'Recurring contact birthday in MM-DD format; the year is intentionally not collected.';

alter table public.daily_brief_items
  drop constraint if exists daily_brief_items_source_check;
alter table public.daily_brief_items
  add constraint daily_brief_items_source_check
    check (source in (
      'booking', 'ordering', 'lead', 'trade', 'email', 'invoice',
      'manual', 'aria', 'proposal', 'calendar', 'birthday'
    ));

comment on column public.daily_brief_items.source is
  'Operational sources plus calendar (today''s RESLU client events, lead site visits and confirmed/tentative trade visits) and birthday (month/day-only team/contact occasions).';

notify pgrst, 'reload schema';
