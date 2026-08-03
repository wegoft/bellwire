-- SPDX-License-Identifier: AGPL-3.0-only
-- Idempotent, device-scoped Direct manifest recovery and release diagnostics.

alter table public.devices
  add column if not exists build_number text,
  add column if not exists notification_authorization text;

alter table public.devices
  drop constraint if exists devices_notification_authorization_check;

alter table public.devices
  add constraint devices_notification_authorization_check
  check (
    notification_authorization is null or notification_authorization in (
      'unknown', 'not_determined', 'denied', 'authorized', 'provisional', 'ephemeral'
    )
  );

drop function if exists public.register_device(
  uuid, uuid, uuid, text, text, text, text, timestamptz, boolean, timestamptz
);

create function public.register_device(
  p_id uuid,
  p_user_id uuid,
  p_installation_id uuid,
  p_name text,
  p_apns_token text,
  p_apns_environment text,
  p_app_version text,
  p_build_number text,
  p_notification_authorization text,
  p_last_active_at timestamptz,
  p_push_enabled boolean,
  p_created_at timestamptz
)
returns setof public.devices
language plpgsql
security invoker
set search_path = ''
as $$
declare
  saved public.devices;
begin
  update public.devices
  set user_id = p_user_id,
      installation_id = p_installation_id,
      name = p_name,
      platform = 'ios',
      apns_environment = p_apns_environment,
      app_version = p_app_version,
      build_number = p_build_number,
      notification_authorization = p_notification_authorization,
      last_active_at = p_last_active_at,
      push_enabled = p_push_enabled
  where apns_token = p_apns_token
  returning * into saved;

  if found then
    return next saved;
    return;
  end if;

  update public.devices
  set name = p_name,
      platform = 'ios',
      apns_token = p_apns_token,
      apns_environment = p_apns_environment,
      app_version = p_app_version,
      build_number = p_build_number,
      notification_authorization = p_notification_authorization,
      last_active_at = p_last_active_at,
      push_enabled = p_push_enabled
  where user_id = p_user_id
    and installation_id = p_installation_id
  returning * into saved;

  if found then
    return next saved;
    return;
  end if;

  insert into public.devices (
    id,
    user_id,
    installation_id,
    name,
    platform,
    apns_token,
    apns_environment,
    app_version,
    build_number,
    notification_authorization,
    last_active_at,
    push_enabled,
    created_at
  ) values (
    p_id,
    p_user_id,
    p_installation_id,
    p_name,
    'ios',
    p_apns_token,
    p_apns_environment,
    p_app_version,
    p_build_number,
    p_notification_authorization,
    p_last_active_at,
    p_push_enabled,
    p_created_at
  )
  returning * into saved;

  return next saved;
end;
$$;

revoke all on function public.register_device(
  uuid, uuid, uuid, text, text, text, text, text, text,
  timestamptz, boolean, timestamptz
) from public, anon, authenticated;

grant execute on function public.register_device(
  uuid, uuid, uuid, text, text, text, text, text, text,
  timestamptz, boolean, timestamptz
) to service_role;

create unique index if not exists projects_id_user_unique
  on public.projects(id, user_id);

alter table public.device_keys
  drop constraint if exists device_keys_user_id_installation_id_key;

create index if not exists device_keys_user_installation_idx
  on public.device_keys(user_id, installation_id);

create unique index if not exists device_keys_user_id_installation_reference_unique
  on public.device_keys(user_id, id, installation_id);

create table public.direct_connection_recovery_requests (
  project_id uuid not null,
  device_key_id text not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  installation_id uuid not null,
  app_version text check (app_version is null or char_length(app_version) between 1 and 40),
  build_number text check (build_number is null or char_length(build_number) between 1 and 40),
  notification_authorization text check (
    notification_authorization is null or notification_authorization in (
      'unknown', 'not_determined', 'denied', 'authorized', 'provisional', 'ephemeral'
    )
  ),
  requested_at timestamptz not null default now(),
  primary key (project_id, device_key_id),
  foreign key (project_id, user_id)
    references public.projects(id, user_id) on delete cascade,
  foreign key (user_id, device_key_id, installation_id)
    references public.device_keys(user_id, id, installation_id) on delete cascade
);

create index direct_connection_recovery_requests_user_idx
  on public.direct_connection_recovery_requests(user_id, requested_at);

alter table public.direct_connection_recovery_requests enable row level security;

create policy "direct_connection_recovery_requests_own"
on public.direct_connection_recovery_requests
for select to authenticated
using (user_id = auth.uid());

grant select, insert, delete on public.direct_connection_recovery_requests to service_role;

comment on table public.direct_connection_recovery_requests is
  'Control-plane requests for an Agent to re-encrypt a Direct v2 manifest for one acknowledged device. Contains no manifest plaintext or private payload.';

comment on column public.devices.build_number is
  'CFBundleVersion reported by the current iOS installation.';

comment on column public.devices.notification_authorization is
  'Current UNAuthorizationStatus diagnostic reported by iOS.';

notify pgrst, 'reload schema';
