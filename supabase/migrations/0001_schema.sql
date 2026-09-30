-- ============================================================================
-- CARTÓRIO DO CELULAR — schema completo para Supabase (Postgres)
-- ============================================================================
-- Rode este arquivo inteiro no SQL Editor do Supabase (ou `supabase db push`)
-- ANTES de publicar qualquer Edge Function. As travas SÃO o produto.
-- Tudo aqui é idempotente: rodar duas vezes não quebra nada.
-- ============================================================================

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

-- ============================================================================
-- 0. LOJAS E OPERADORES
-- ============================================================================
create table if not exists stores (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  cnpj          text not null unique,
  city          text,
  state         char(2),
  tier          text not null default 'cadastrada'
                check (tier in ('cadastrada','verificada','fundadora')),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table if not exists store_members (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references stores(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'operator' check (role in ('operator','manager','owner')),
  created_at timestamptz not null default now(),
  unique (store_id, user_id)
);
create index if not exists store_members_user_idx on store_members(user_id);

create or replace function current_store_id()
returns uuid language sql stable security definer set search_path = public as $$
  select store_id from store_members where user_id = auth.uid() limit 1;
$$;

-- ============================================================================
-- 1. TRAVA GERAL: TABELAS APPEND-ONLY
-- ============================================================================
create or replace function registry_block_mutation()
returns trigger language plpgsql as $$
begin
  raise exception
    'A tabela % é append-only. Corrija por um novo registro, nunca alterando ou apagando o anterior.',
    tg_table_name;
end;
$$;

-- ============================================================================
-- 2. IDENTIDADE (pessoa canônica nacional)
-- ============================================================================
create table if not exists registry_parties (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('pf','pj')),
  display_name text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- CPF/CNPJ NUNCA em texto claro e NUNCA pesquisável por LIKE.
create table if not exists registry_party_identifiers (
  id              uuid primary key default gen_random_uuid(),
  party_id        uuid not null references registry_parties(id) on delete restrict,
  type            text not null check (type in ('cpf','cnpj')),
  value_encrypted text not null,
  value_hash      text not null,
  key_version     smallint not null default 1,
  created_at      timestamptz not null default now(),
  unique (type, value_hash)
);

create table if not exists registry_party_contacts (
  id          uuid primary key default gen_random_uuid(),
  party_id    uuid not null references registry_parties(id) on delete cascade,
  kind        text not null check (kind in ('phone','email')),
  value       text not null,
  verified_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists registry_party_contacts_party_idx on registry_party_contacts(party_id);

create table if not exists registry_tenant_party_links (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references stores(id) on delete cascade,
  party_id   uuid not null references registry_parties(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (store_id, party_id)
);

create table if not exists registry_consents (
  id         uuid primary key default gen_random_uuid(),
  party_id   uuid not null references registry_parties(id) on delete cascade,
  store_id   uuid references stores(id) on delete set null,
  purpose    text not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  evidence   jsonb not null default '{}'::jsonb
);

-- ============================================================================
-- 3. APARELHO (entidade permanente) — a chave é o UUID, não o IMEI
-- ============================================================================
create table if not exists registry_devices (
  id         uuid primary key default gen_random_uuid(),
  brand      text,
  model      text,
  storage    text,
  color      text,
  created_at timestamptz not null default now()
);

create table if not exists registry_device_identifiers (
  id         uuid primary key default gen_random_uuid(),
  device_id  uuid not null references registry_devices(id) on delete restrict,
  type       text not null check (type in ('imei','imei2','serial','eid')),
  value      text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- Um identificador ATIVO não pode pertencer a dois aparelhos.
create unique index if not exists registry_device_identifiers_active_unique
  on registry_device_identifiers(type, value) where is_active;

create table if not exists registry_device_media (
  id             uuid primary key default gen_random_uuid(),
  device_id      uuid not null references registry_devices(id) on delete restrict,
  store_id       uuid references stores(id) on delete set null,
  transaction_id uuid,
  slot           text not null check (slot in
                   ('frente_ligada','traseira','tela_imei','laterais','avarias','documento','selfie')),
  storage_key    text not null,
  sha256         text not null,
  mime           text not null,
  bytes          integer not null,
  created_at     timestamptz not null default now()
);
create index if not exists registry_device_media_device_idx on registry_device_media(device_id);
create index if not exists registry_device_media_tx_idx on registry_device_media(transaction_id);

-- 'unavailable' NÃO libera o fluxo.
create table if not exists registry_device_checks (
  id             uuid primary key default gen_random_uuid(),
  device_id      uuid not null references registry_devices(id) on delete restrict,
  transaction_id uuid,
  provider       text not null,
  result         text not null check (result in
                   ('clear','restricted','inconclusive','unavailable','expired')),
  raw            jsonb not null default '{}'::jsonb,
  checked_at     timestamptz not null default now(),
  valid_until    timestamptz,
  created_by     uuid references auth.users(id) on delete set null
);
create index if not exists registry_device_checks_device_idx on registry_device_checks(device_id, checked_at desc);
create index if not exists registry_device_checks_tx_idx on registry_device_checks(transaction_id, checked_at desc);

-- A linha do tempo do aparelho — o "passaporte". APPEND-ONLY.
create table if not exists registry_device_events (
  id             uuid primary key default gen_random_uuid(),
  device_id      uuid not null references registry_devices(id) on delete restrict,
  store_id       uuid references stores(id) on delete set null,
  type           text not null,
  visibility     text not null default 'tenant' check (visibility in ('public','tenant','private')),
  transaction_id uuid,
  payload        jsonb not null default '{}'::jsonb,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists registry_device_events_device_idx on registry_device_events(device_id, created_at);
drop trigger if exists registry_device_events_append_only on registry_device_events;
create trigger registry_device_events_append_only
  before update or delete on registry_device_events
  for each row execute function registry_block_mutation();

-- ============================================================================
-- 4. TRANSAÇÃO — as quatro modalidades nascem aqui
-- ============================================================================
create table if not exists registry_transactions (
  id                    uuid primary key default gen_random_uuid(),
  store_id              uuid references stores(id) on delete set null,
  kind                  text not null check (kind in ('pf_pj','pj_pf','pf_pf','pj_pj')),
  state                 text not null default 'draft' check (state in (
                          'draft','awaiting_data','awaiting_checks','awaiting_seller',
                          'awaiting_buyer','ready_to_complete','completed',
                          'under_review','blocked','cancelled','expired','disputed')),
  origin                text not null default 'balcao',
  public_protocol       text not null unique,
  current_terms_version integer not null default 0,
  external_ref          text,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  completed_at          timestamptz,
  expires_at            timestamptz
);

create table if not exists registry_transaction_parties (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references registry_transactions(id) on delete cascade,
  party_id       uuid not null references registry_parties(id) on delete restrict,
  role           text not null check (role in ('seller','buyer','representative','witness')),
  is_tenant_side boolean not null default false,
  unique (transaction_id, party_id, role)
);

create table if not exists registry_transaction_devices (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references registry_transactions(id) on delete cascade,
  device_id      uuid not null references registry_devices(id) on delete restrict,
  unique (transaction_id, device_id)
);

-- Termos versionados, APPEND-ONLY.
create table if not exists registry_transaction_terms (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references registry_transactions(id) on delete cascade,
  version        integer not null,
  payload        jsonb not null,
  content_hash   text not null,
  frozen_at      timestamptz not null default now(),
  created_by     uuid references auth.users(id) on delete set null,
  unique (transaction_id, version)
);
drop trigger if exists registry_transaction_terms_append_only on registry_transaction_terms;
create trigger registry_transaction_terms_append_only
  before update or delete on registry_transaction_terms
  for each row execute function registry_block_mutation();

-- O ACEITE. Append-only. Aceite assistido exige motivo, operador e convite.
create table if not exists registry_transaction_acceptances (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references registry_transactions(id) on delete cascade,
  party_id       uuid not null references registry_parties(id) on delete restrict,
  terms_version  integer not null,
  terms_hash     text not null,
  channel        text not null check (channel in
                   ('otp_whatsapp','portal','operator_pj','presencial_assistido')),
  ip             text,
  user_agent     text,
  evidence       jsonb not null default '{}'::jsonb,
  accepted_at    timestamptz not null default now(),
  constraint registry_acceptances_assisted_chk check (
    channel <> 'presencial_assistido'
    or (evidence ? 'reason'
        and length(trim(evidence->>'reason')) >= 10
        and evidence ? 'operator_user_id'
        and evidence ? 'invite_id')
  )
);
create unique index if not exists registry_acceptances_unique
  on registry_transaction_acceptances(transaction_id, party_id, terms_version);
create index if not exists registry_acceptances_assisted_idx
  on registry_transaction_acceptances(accepted_at) where channel = 'presencial_assistido';
drop trigger if exists registry_acceptances_append_only on registry_transaction_acceptances;
create trigger registry_acceptances_append_only
  before update or delete on registry_transaction_acceptances
  for each row execute function registry_block_mutation();

-- Convite de aceite: token e código só em hash.
create table if not exists registry_acceptance_invites (
  id                 uuid primary key default gen_random_uuid(),
  transaction_id     uuid not null references registry_transactions(id) on delete cascade,
  party_id           uuid not null references registry_parties(id) on delete cascade,
  terms_version      integer not null,
  terms_hash         text not null,
  token_hash         text not null,
  otp_hash           text,
  otp_expires_at     timestamptz,
  otp_attempts       integer not null default 0,
  otp_sent_count     integer not null default 0,
  channel            text not null default 'otp_whatsapp' check (channel in ('otp_whatsapp','portal')),
  destination_masked text,
  expires_at         timestamptz not null,
  consumed_at        timestamptz,
  revoked_at         timestamptz,
  revoked_reason     text,
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now()
);
create unique index if not exists registry_invites_token_unique on registry_acceptance_invites(token_hash);
create unique index if not exists registry_invites_live_unique
  on registry_acceptance_invites(transaction_id, party_id, terms_version)
  where consumed_at is null and revoked_at is null;

-- TITULARIDADE. Dois donos ao mesmo tempo é impossível — pelo Postgres.
create table if not exists registry_ownership_periods (
  id             uuid primary key default gen_random_uuid(),
  device_id      uuid not null references registry_devices(id) on delete restrict,
  party_id       uuid not null references registry_parties(id) on delete restrict,
  transaction_id uuid references registry_transactions(id) on delete set null,
  started_at     timestamptz not null default now(),
  ended_at       timestamptz
);
do $$
begin
  alter table registry_ownership_periods
    add constraint registry_ownership_no_overlap
    exclude using gist (
      device_id with =,
      tstzrange(started_at, coalesce(ended_at, 'infinity'::timestamptz)) with &&
    );
exception
  when duplicate_object then null;
  when duplicate_table then null;
end $$;
create index if not exists registry_ownership_device_idx on registry_ownership_periods(device_id, started_at desc);

create table if not exists registry_certificates (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references registry_transactions(id) on delete cascade,
  protocol       text not null,
  content_hash   text not null,
  storage_key    text,
  issued_at      timestamptz not null default now()
);

-- ============================================================================
-- 5. OPERAÇÃO
-- ============================================================================
create table if not exists registry_audit_events (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid references stores(id) on delete set null,
  actor_user_id  uuid references auth.users(id) on delete set null,
  actor_party_id uuid references registry_parties(id) on delete set null,
  action         text not null,
  subject_type   text not null,
  subject_id     uuid,
  metadata       jsonb not null default '{}'::jsonb,
  ip             text,
  created_at     timestamptz not null default now()
);
create index if not exists registry_audit_subject_idx on registry_audit_events(subject_type, subject_id, created_at desc);
drop trigger if exists registry_audit_append_only on registry_audit_events;
create trigger registry_audit_append_only
  before update or delete on registry_audit_events
  for each row execute function registry_block_mutation();

create table if not exists registry_idempotency_keys (
  id           uuid primary key default gen_random_uuid(),
  scope        text not null,
  key          text not null,
  store_id     uuid references stores(id) on delete cascade,
  request_hash text not null,
  response     jsonb,
  created_at   timestamptz not null default now(),
  unique (scope, key, store_id)
);

create table if not exists registry_outbox_events (
  id           uuid primary key default gen_random_uuid(),
  topic        text not null,
  store_id     uuid references stores(id) on delete set null,
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  processed_at timestamptz,
  attempts     integer not null default 0,
  last_error   text
);
create index if not exists registry_outbox_pending_idx on registry_outbox_events(created_at) where processed_at is null;

-- ============================================================================
-- 6. RLS — tudo ligado, padrão negar. Escrita de lastro só por Edge Function.
-- ============================================================================
alter table stores                            enable row level security;
alter table store_members                     enable row level security;
alter table registry_parties                  enable row level security;
alter table registry_party_identifiers        enable row level security;
alter table registry_party_contacts           enable row level security;
alter table registry_tenant_party_links       enable row level security;
alter table registry_consents                 enable row level security;
alter table registry_devices                  enable row level security;
alter table registry_device_identifiers       enable row level security;
alter table registry_device_media             enable row level security;
alter table registry_device_checks            enable row level security;
alter table registry_device_events            enable row level security;
alter table registry_transactions             enable row level security;
alter table registry_transaction_parties      enable row level security;
alter table registry_transaction_devices      enable row level security;
alter table registry_transaction_terms        enable row level security;
alter table registry_transaction_acceptances  enable row level security;
alter table registry_acceptance_invites       enable row level security;
alter table registry_ownership_periods        enable row level security;
alter table registry_certificates             enable row level security;
alter table registry_audit_events             enable row level security;
alter table registry_idempotency_keys         enable row level security;
alter table registry_outbox_events            enable row level security;

drop policy if exists stores_select on stores;
create policy stores_select on stores for select using (id = current_store_id());

drop policy if exists store_members_select on store_members;
create policy store_members_select on store_members for select using (store_id = current_store_id());

drop policy if exists tx_select on registry_transactions;
create policy tx_select on registry_transactions for select using (store_id = current_store_id());

drop policy if exists tx_parties_select on registry_transaction_parties;
create policy tx_parties_select on registry_transaction_parties for select using (exists (
  select 1 from registry_transactions t where t.id = transaction_id and t.store_id = current_store_id()));

drop policy if exists tx_devices_select on registry_transaction_devices;
create policy tx_devices_select on registry_transaction_devices for select using (exists (
  select 1 from registry_transactions t where t.id = transaction_id and t.store_id = current_store_id()));

drop policy if exists tx_terms_select on registry_transaction_terms;
create policy tx_terms_select on registry_transaction_terms for select using (exists (
  select 1 from registry_transactions t where t.id = transaction_id and t.store_id = current_store_id()));

drop policy if exists tx_acc_select on registry_transaction_acceptances;
create policy tx_acc_select on registry_transaction_acceptances for select using (exists (
  select 1 from registry_transactions t where t.id = transaction_id and t.store_id = current_store_id()));

drop policy if exists invites_select on registry_acceptance_invites;
create policy invites_select on registry_acceptance_invites for select using (exists (
  select 1 from registry_transactions t where t.id = transaction_id and t.store_id = current_store_id()));

drop policy if exists parties_select on registry_parties;
create policy parties_select on registry_parties for select using (exists (
  select 1 from registry_tenant_party_links l where l.party_id = id and l.store_id = current_store_id()));

drop policy if exists party_contacts_select on registry_party_contacts;
create policy party_contacts_select on registry_party_contacts for select using (exists (
  select 1 from registry_tenant_party_links l where l.party_id = party_id and l.store_id = current_store_id()));

drop policy if exists links_select on registry_tenant_party_links;
create policy links_select on registry_tenant_party_links for select using (store_id = current_store_id());

-- registry_party_identifiers: NENHUMA política, de propósito.

drop policy if exists devices_select on registry_devices;
create policy devices_select on registry_devices for select using (exists (
  select 1 from registry_transaction_devices td join registry_transactions t on t.id = td.transaction_id
  where td.device_id = id and t.store_id = current_store_id()));

drop policy if exists device_ids_select on registry_device_identifiers;
create policy device_ids_select on registry_device_identifiers for select using (exists (
  select 1 from registry_transaction_devices td join registry_transactions t on t.id = td.transaction_id
  where td.device_id = device_id and t.store_id = current_store_id()));

drop policy if exists media_select on registry_device_media;
create policy media_select on registry_device_media for select using (store_id = current_store_id());

drop policy if exists checks_select on registry_device_checks;
create policy checks_select on registry_device_checks for select using (exists (
  select 1 from registry_transaction_devices td join registry_transactions t on t.id = td.transaction_id
  where td.device_id = device_id and t.store_id = current_store_id()));

drop policy if exists events_select on registry_device_events;
create policy events_select on registry_device_events for select using (visibility = 'public' or store_id = current_store_id());

drop policy if exists ownership_select on registry_ownership_periods;
create policy ownership_select on registry_ownership_periods for select using (exists (
  select 1 from registry_transaction_devices td join registry_transactions t on t.id = td.transaction_id
  where td.device_id = device_id and t.store_id = current_store_id()));

drop policy if exists audit_select on registry_audit_events;
create policy audit_select on registry_audit_events for select using (store_id = current_store_id());

-- ============================================================================
-- 7. CONSULTA PÚBLICA — o passaporte do aparelho (sem PII)
-- ============================================================================
create or replace function public_device_passport(p_imei text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_device_id uuid;
  v_events    jsonb;
  v_elos      integer;
begin
  select device_id into v_device_id
  from registry_device_identifiers
  where value = p_imei and is_active
  limit 1;

  if v_device_id is null then
    return jsonb_build_object(
      'encontrado', false,
      'aviso', 'Este aparelho ainda não tem registro no Cartório. Isso não significa que ele tenha problema — significa que ninguém registrou a passagem dele por aqui.');
  end if;

  select count(*) into v_elos from registry_ownership_periods where device_id = v_device_id;

  select coalesce(jsonb_agg(jsonb_build_object('tipo', type, 'data', created_at, 'dados', payload) order by created_at), '[]'::jsonb)
    into v_events
  from registry_device_events
  where device_id = v_device_id and visibility = 'public';

  return jsonb_build_object(
    'encontrado', true,
    'imei_mascarado', left(p_imei,4) || '****' || right(p_imei,4),
    'elos', v_elos,
    'linha_do_tempo', v_events,
    'limites', 'O Cartório registra passagens declaradas e verificadas na data indicada. Não é órgão público e não substitui boletim de ocorrência, nota fiscal ou vistoria técnica.');
end;
$$;
revoke all on function public_device_passport(text) from public;
grant execute on function public_device_passport(text) to anon, authenticated;

-- ============================================================================
-- 8. VALIDAÇÃO DE IMEI (Luhn) — no banco, para ninguém esquecer
-- ============================================================================
create or replace function imei_valido(p text)
returns boolean language plpgsql immutable as $$
declare
  s integer := 0; d integer; i integer; dobra boolean := false;
begin
  if p !~ '^[0-9]{15}$' then return false; end if;
  for i in reverse 15..1 loop
    d := substr(p, i, 1)::integer;
    if dobra then
      d := d * 2;
      if d > 9 then d := d - 9; end if;
    end if;
    s := s + d;
    dobra := not dobra;
  end loop;
  return s % 10 = 0;
end;
$$;

do $$
begin
  alter table registry_device_identifiers
    add constraint registry_device_imei_luhn
    check (type not in ('imei','imei2') or imei_valido(value));
exception when duplicate_object then null;
end $$;
