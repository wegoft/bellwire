-- SPDX-License-Identifier: AGPL-3.0-only
-- Shared website waitlist migration already applied to the Bellwire Supabase project.

create table public.bellwire_waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  language text not null default 'en' check (language in ('en', 'zh')),
  source text not null default 'website',
  created_at timestamptz not null default now(),
  constraint bellwire_waitlist_email_length check (char_length(email) between 3 and 254),
  constraint bellwire_waitlist_email_unique unique (email)
);

comment on table public.bellwire_waitlist is 'Early-access signups collected by bellwire.app.';
comment on column public.bellwire_waitlist.email is 'Normalized lowercase email address.';

alter table public.bellwire_waitlist enable row level security;

revoke all on table public.bellwire_waitlist from anon, authenticated;
grant all on table public.bellwire_waitlist to service_role;

insert into supabase_migrations.schema_migrations (version, statements, name)
values (
  '20260722132000',
  array['create isolated Bellwire waitlist table'],
  'bellwire_waitlist'
)
on conflict (version) do nothing;
