-- SPDX-License-Identifier: AGPL-3.0-only
-- Adds the first expanded Surface family. Live Activity persistence is added
-- below in this migration so the API and device capability contract roll out
-- as one schema version.

alter table public.live_surfaces
  drop constraint if exists live_surfaces_type_check;

alter table public.live_surfaces
  add constraint live_surfaces_type_check
  check (type in (
    'stats', 'metrics', 'segmented_progress', 'progress', 'alert', 'timer',
    'status', 'checklist', 'trend'
  ));

alter table public.live_surfaces
  add column if not exists live_activity jsonb;

alter table public.live_surfaces
  drop constraint if exists live_surfaces_live_activity_check;

alter table public.live_surfaces
  add constraint live_surfaces_live_activity_check check (
    live_activity is null or (
      jsonb_typeof(live_activity) = 'object'
      and live_activity ? 'sessionId'
      and live_activity ? 'state'
      and live_activity ->> 'state' in ('active', 'ended')
    )
  );

create table if not exists public.device_live_activity_capabilities (
  device_id uuid primary key references public.devices(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  activities_enabled boolean not null default false,
  auto_start_enabled boolean not null default false,
  push_to_start_token text,
  os_version text not null check (char_length(os_version) between 1 and 32),
  updated_at timestamptz not null default now(),
  check (push_to_start_token is null or push_to_start_token ~ '^[a-f0-9]{32,512}$')
);

create table if not exists public.live_activity_registrations (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  surface_id uuid not null references public.live_surfaces(id) on delete cascade,
  session_id text not null check (char_length(session_id) between 1 and 80),
  activity_id text not null unique check (char_length(activity_id) between 1 and 128),
  update_token text not null check (update_token ~ '^[a-f0-9]{32,512}$'),
  apns_environment text not null check (apns_environment in ('sandbox', 'production')),
  origin text not null check (origin in ('agent', 'manual')),
  last_version integer not null default 0 check (last_version >= 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (device_id, project_id, session_id)
);

create table if not exists public.live_activity_start_requests (
  device_id uuid not null references public.devices(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  surface_id uuid not null references public.live_surfaces(id) on delete cascade,
  session_id text not null check (char_length(session_id) between 1 and 80),
  created_at timestamptz not null default now(),
  primary key (device_id, project_id, session_id)
);

create index if not exists live_activity_registrations_user_device_idx
on public.live_activity_registrations(user_id, device_id, expires_at);

alter table public.device_live_activity_capabilities enable row level security;
alter table public.live_activity_registrations enable row level security;
alter table public.live_activity_start_requests enable row level security;

grant select, insert, update, delete on public.device_live_activity_capabilities to service_role;
grant select, insert, update, delete on public.live_activity_registrations to service_role;
grant select, insert, update, delete on public.live_activity_start_requests to service_role;

drop function if exists public.save_live_surface_version(
  uuid, uuid, text, text, text, text, jsonb, jsonb, integer, timestamptz, timestamptz
);

create function public.save_live_surface_version(
  p_id uuid,
  p_project_id uuid,
  p_surface_key text,
  p_type text,
  p_title text,
  p_subtitle text,
  p_content jsonb,
  p_action jsonb,
  p_live_activity jsonb,
  p_display_order integer,
  p_created_at timestamptz,
  p_updated_at timestamptz
)
returns setof public.live_surfaces
language plpgsql
security definer set search_path = public
as $$
declare
  saved_surface public.live_surfaces%rowtype;
begin
  perform 1 from public.projects where id = p_project_id for update;
  if not found then return; end if;

  update public.live_surfaces
  set type = p_type,
      title = p_title,
      subtitle = p_subtitle,
      content = p_content,
      action = p_action,
      live_activity = p_live_activity,
      version = version + 1,
      updated_at = p_updated_at
  where project_id = p_project_id and surface_key = p_surface_key
  returning * into saved_surface;

  if found then
    return next saved_surface;
    return;
  end if;

  insert into public.live_surfaces (
    id, project_id, surface_key, type, title, subtitle, content, action,
    live_activity, display_order, version, created_at, updated_at
  ) values (
    p_id, p_project_id, p_surface_key, p_type, p_title, p_subtitle, p_content,
    p_action, p_live_activity, p_display_order, 1, p_created_at, p_updated_at
  ) returning * into saved_surface;
  return next saved_surface;
end;
$$;

revoke all on function public.save_live_surface_version(
  uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb, integer,
  timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.save_live_surface_version(
  uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb, integer,
  timestamptz, timestamptz
) to service_role;

drop function if exists public.accept_hosted_surface_signal(
  uuid, uuid, text, text, text, text, jsonb, jsonb, integer,
  timestamptz, timestamptz, text
);

create function public.accept_hosted_surface_signal(
  p_id uuid,
  p_project_id uuid,
  p_surface_key text,
  p_type text,
  p_title text,
  p_subtitle text,
  p_content jsonb,
  p_action jsonb,
  p_live_activity jsonb,
  p_display_order integer,
  p_created_at timestamptz,
  p_updated_at timestamptz,
  p_enforcement_mode text
)
returns table (
  surface_row jsonb,
  created boolean,
  quota_exceeded boolean,
  surface_limit_exceeded boolean,
  plan text,
  accepted_signals bigint,
  signal_limit integer,
  courtesy_limit integer,
  reset_at timestamptz
)
language plpgsql
security definer set search_path = public
as $$
declare
  owner_id uuid;
  project_mode text;
  period_start date := date_trunc('month', p_updated_at at time zone 'UTC')::date;
  current_usage bigint;
  current_surface_count integer;
  resolved_plan text;
  resolved_limit integer;
  resolved_courtesy integer;
  resolved_surface_limit integer;
  saved public.live_surfaces%rowtype;
  surface_exists boolean := false;
begin
  select user_id, delivery_mode into owner_id, project_mode
  from public.projects where id = p_project_id and status = 'active' for update;
  if not found then return; end if;
  if project_mode <> 'hosted' then
    raise exception 'PROJECT_PRIVATE_MODE' using errcode = 'P0001';
  end if;

  select * into saved from public.live_surfaces
  where project_id = p_project_id and surface_key = p_surface_key;
  surface_exists := found;

  resolved_plan := public.resolve_account_plan(owner_id, p_updated_at);
  resolved_limit := case when resolved_plan = 'pro' then 50000 else 5000 end;
  resolved_courtesy := case when resolved_plan = 'pro' then 55000 else 5500 end;
  resolved_surface_limit := case when resolved_plan = 'pro' then null::integer else 3 end;
  select coalesce(usage.accepted_signals, 0) into current_usage
  from (select 1) seed
  left join public.monthly_signal_usage usage
    on usage.user_id = owner_id and usage.month_start = period_start;

  if surface_exists and saved.type = p_type
    and saved.title = p_title
    and saved.subtitle is not distinct from p_subtitle
    and saved.content = p_content
    and saved.action is not distinct from p_action
    and saved.live_activity is not distinct from p_live_activity
  then
    return query select to_jsonb(saved), false, false, false, resolved_plan, current_usage,
      resolved_limit, resolved_courtesy, (period_start + interval '1 month')::timestamptz;
    return;
  end if;

  if not surface_exists then
    select count(*)::integer into current_surface_count
    from public.live_surfaces where project_id = p_project_id;
    if p_enforcement_mode = 'enforce'
      and resolved_surface_limit is not null
      and current_surface_count >= resolved_surface_limit
    then
      return query select null::jsonb, false, false, true, resolved_plan, current_usage,
        resolved_limit, resolved_courtesy, (period_start + interval '1 month')::timestamptz;
      return;
    end if;
  end if;

  insert into public.monthly_signal_usage(user_id, month_start)
  values (owner_id, period_start) on conflict do nothing;
  select usage.accepted_signals into current_usage
  from public.monthly_signal_usage usage
  where usage.user_id = owner_id and usage.month_start = period_start for update;

  if p_enforcement_mode = 'enforce' and current_usage >= resolved_courtesy then
    return query select null::jsonb, false, true, false, resolved_plan, current_usage,
      resolved_limit, resolved_courtesy, (period_start + interval '1 month')::timestamptz;
    return;
  end if;

  if surface_exists then
    update public.live_surfaces
    set type = p_type,
        title = p_title,
        subtitle = p_subtitle,
        content = p_content,
        action = p_action,
        live_activity = p_live_activity,
        version = version + 1,
        updated_at = p_updated_at
    where id = saved.id
    returning * into saved;
  else
    insert into public.live_surfaces (
      id, project_id, surface_key, type, title, subtitle, content, action,
      live_activity, display_order, version, created_at, updated_at
    ) values (
      p_id, p_project_id, p_surface_key, p_type, p_title, p_subtitle, p_content,
      p_action, p_live_activity, p_display_order, 1, p_created_at, p_updated_at
    ) returning * into saved;
  end if;

  update public.monthly_signal_usage
  set accepted_signals = monthly_signal_usage.accepted_signals + 1,
      updated_at = p_updated_at
  where user_id = owner_id and month_start = period_start
  returning monthly_signal_usage.accepted_signals into current_usage;

  return query select to_jsonb(saved), true, false, false, resolved_plan, current_usage,
    resolved_limit, resolved_courtesy, (period_start + interval '1 month')::timestamptz;
end;
$$;

revoke all on function public.accept_hosted_surface_signal(
  uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb, integer,
  timestamptz, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.accept_hosted_surface_signal(
  uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb, integer,
  timestamptz, timestamptz, text
) to service_role;

notify pgrst, 'reload schema';
