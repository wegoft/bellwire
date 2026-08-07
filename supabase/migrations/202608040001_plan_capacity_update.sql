-- SPDX-License-Identifier: AGPL-3.0-only
-- Free: one active project and three Surfaces per project. Pro: unlimited Surfaces per project.

create or replace function public.account_entitlement_snapshot(
  p_user_id uuid,
  p_now timestamptz default clock_timestamp()
)
returns table (
  plan text,
  status text,
  product_id text,
  expires_at timestamptz,
  downgrade_deadline timestamptz,
  active_projects integer,
  active_devices integer,
  month_start date,
  month_end timestamptz,
  accepted_signals bigint,
  active_project_limit integer,
  active_device_limit integer,
  monthly_signal_limit integer,
  courtesy_signal_limit integer,
  ingest_per_minute integer,
  hosted_retention_days integer,
  surfaces_per_project integer
)
language plpgsql
stable
security definer set search_path = public
as $$
declare
  resolved_plan text := public.resolve_account_plan(p_user_id, p_now);
  resolved_month date := date_trunc('month', p_now at time zone 'UTC')::date;
begin
  return query
  select
    resolved_plan,
    coalesce(e.status, 'active'),
    e.product_id,
    e.expires_at,
    e.downgrade_deadline,
    (select count(*)::integer from public.projects p
      where p.user_id = p_user_id and p.status = 'active'),
    (select count(*)::integer from public.devices d
      where d.user_id = p_user_id and d.push_enabled),
    resolved_month,
    (resolved_month + interval '1 month')::timestamptz,
    coalesce(u.accepted_signals, 0),
    case when resolved_plan = 'pro' then 20 else 1 end,
    case when resolved_plan = 'pro' then 3 else 1 end,
    case when resolved_plan = 'pro' then 50000 else 5000 end,
    case when resolved_plan = 'pro' then 55000 else 5500 end,
    case when resolved_plan = 'pro' then 300 else 60 end,
    case when resolved_plan = 'pro' then 90 else 7 end,
    case when resolved_plan = 'pro' then null::integer else 3 end
  from (select 1) seed
  left join public.billing_entitlements e on e.user_id = p_user_id
  left join public.monthly_signal_usage u
    on u.user_id = p_user_id and u.month_start = resolved_month;
end;
$$;

create or replace function public.accept_hosted_surface_signal(
  p_id uuid,
  p_project_id uuid,
  p_surface_key text,
  p_type text,
  p_title text,
  p_subtitle text,
  p_content jsonb,
  p_action jsonb,
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
        version = version + 1,
        updated_at = p_updated_at
    where id = saved.id
    returning * into saved;
  else
    insert into public.live_surfaces(
      id, project_id, surface_key, type, title, subtitle, content, action,
      display_order, version, created_at, updated_at
    ) values (
      p_id, p_project_id, p_surface_key, p_type, p_title, p_subtitle, p_content,
      p_action, p_display_order, 1, p_created_at, p_updated_at
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

revoke all on function public.account_entitlement_snapshot(uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function public.accept_hosted_surface_signal(
  uuid, uuid, text, text, text, text, jsonb, jsonb, integer,
  timestamptz, timestamptz, text
) from public, anon, authenticated;

grant execute on function public.account_entitlement_snapshot(uuid, timestamptz)
  to service_role;
grant execute on function public.accept_hosted_surface_signal(
  uuid, uuid, text, text, text, text, jsonb, jsonb, integer,
  timestamptz, timestamptz, text
) to service_role;
