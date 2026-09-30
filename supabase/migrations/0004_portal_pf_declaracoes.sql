-- ============================================================================
-- 0004 — Portal da pessoa física ("Meus aparelhos"), adaptado da Carteira
-- Digital de Trânsito: sessão própria da PF, declarações do titular (venda
-- comunicada, ocorrência de furto/roubo/perda) e o gate correspondente na
-- conclusão. Idempotente.
-- ============================================================================

-- Códigos de acesso do portal PF (um por CPF; só hash).
create table if not exists pf_otps (
  cpf_hash   text primary key,
  phone      text not null,
  nome       text,
  otp_hash   text not null,
  expires_at timestamptz not null,
  attempts   integer not null default 0,
  created_at timestamptz not null default now()
);
alter table pf_otps enable row level security; -- sem política: só a Edge Function

-- Sessões do portal PF (token só em hash; 30 dias).
create table if not exists pf_sessions (
  id         uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  party_id   uuid not null references registry_parties(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists pf_sessions_party_idx on pf_sessions(party_id);
alter table pf_sessions enable row level security; -- sem política

-- Declarações do titular sobre o aparelho. Hoje: theft_declared (furto/roubo/perda).
create table if not exists registry_device_flags (
  id                   uuid primary key default gen_random_uuid(),
  device_id            uuid not null references registry_devices(id) on delete restrict,
  kind                 text not null check (kind in ('theft_declared')),
  tipo                 text check (tipo in ('furto','roubo','perda')),
  declared_by_party_id uuid not null references registry_parties(id) on delete restrict,
  bo_numero            text,
  bo_data              date,
  cidade               text,
  uf                   char(2),
  active               boolean not null default true,
  withdrawn_at         timestamptz,
  withdrawn_reason     text,
  created_at           timestamptz not null default now()
);
-- Uma declaração ATIVA por aparelho.
create unique index if not exists registry_device_flags_active_unique
  on registry_device_flags(device_id, kind) where active;
alter table registry_device_flags enable row level security;
drop policy if exists device_flags_select on registry_device_flags;
-- A loja vê a situação (sem quem declarou) dos aparelhos que tocou.
create policy device_flags_select on registry_device_flags for select using (exists (
  select 1 from registry_transaction_devices td join registry_transactions t on t.id = td.transaction_id
  where td.device_id = device_id and t.store_id = current_store_id()));

-- Ocorrência ativa de um aparelho, sem PII (usada pelo passaporte e pelos gates).
create or replace function device_active_flag(p_device_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when f.id is null then null else jsonb_build_object(
    'tipo', f.tipo, 'bo_numero', f.bo_numero, 'bo_data', f.bo_data, 'cidade', f.cidade, 'uf', f.uf, 'declarada_em', f.created_at)
  end
  from (select * from registry_device_flags where device_id = p_device_id and kind = 'theft_declared' and active limit 1) f
  right join (select 1) x on true
  limit 1;
$$;

-- Passaporte público: inclui a ocorrência ativa.
create or replace function public_device_passport(p_imei text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_device_id uuid;
  v_events    jsonb;
  v_elos      integer;
begin
  select device_id into v_device_id from registry_device_identifiers where value = p_imei and is_active limit 1;
  if v_device_id is null then
    return jsonb_build_object('encontrado', false,
      'aviso', 'Este aparelho ainda não tem registro no Cartório. Isso não significa que ele tenha problema — significa que ninguém registrou a passagem dele por aqui.');
  end if;
  select count(*) into v_elos from registry_ownership_periods where device_id = v_device_id;
  select coalesce(jsonb_agg(jsonb_build_object('tipo', type, 'data', created_at, 'dados', payload) order by created_at), '[]'::jsonb)
    into v_events from registry_device_events where device_id = v_device_id and visibility = 'public';
  return jsonb_build_object(
    'encontrado', true,
    'imei_mascarado', left(p_imei,4) || '****' || right(p_imei,4),
    'elos', v_elos,
    'linha_do_tempo', v_events,
    'ocorrencia_ativa', device_active_flag(v_device_id),
    'limites', 'O Cartório registra passagens declaradas e verificadas na data indicada. Não é órgão público e não substitui boletim de ocorrência, nota fiscal ou vistoria técnica.');
end;
$$;

-- Conclusão: + gate de ocorrência ativa; fotos dispensadas na comunicação de
-- venda entre pessoas (o aparelho já não está com o vendedor); ator pode ser nulo (portal PF).
create or replace function registry_complete_transaction(
  p_transaction_id uuid,
  p_actor_user_id  uuid,
  p_grade          text,
  p_terms_hash     text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t            registry_transactions%rowtype;
  v_device_id  uuid;
  v_seller     uuid;
  v_buyer      uuid;
  v_open       registry_ownership_periods%rowtype;
  v_check      registry_device_checks%rowtype;
  v_flag       jsonb;
  v_now        timestamptz := now();
  v_missing    text[];
  v_comunicacao boolean;
begin
  select * into t from registry_transactions where id = p_transaction_id for update;
  if not found then raise exception 'tx_inexistente:Transação não encontrada.'; end if;
  if t.state = 'completed' then
    return jsonb_build_object('protocolo', t.public_protocol, 'grade', p_grade, 'completed_at', t.completed_at, 'repetida', true);
  end if;
  if t.state not in ('ready_to_complete','awaiting_buyer','awaiting_seller') then
    raise exception 'transicao_invalida:Não dá para concluir uma transação em estado "%".', t.state;
  end if;

  select device_id into v_device_id from registry_transaction_devices where transaction_id = t.id limit 1;
  select party_id into v_seller from registry_transaction_parties where transaction_id = t.id and role = 'seller';
  select party_id into v_buyer  from registry_transaction_parties where transaction_id = t.id and role = 'buyer';

  -- 0. declaração de furto/roubo/perda ativa pelo titular registrado
  v_flag := device_active_flag(v_device_id);
  if v_flag is not null then
    raise exception 'ocorrencia_ativa:Consta declaração de % pelo titular registrado. Enquanto a declaração estiver ativa, esta transação não pode ser concluída.', v_flag->>'tipo';
  end if;

  -- 1. gate de procedência
  select * into v_check from registry_device_checks where transaction_id = t.id order by checked_at desc limit 1;
  if not found then raise exception 'procedencia_nao_liberada:Ainda não foi feita a consulta de procedência deste aparelho.'; end if;
  if v_check.result <> 'clear' then raise exception 'procedencia_nao_liberada:A consulta de procedência não liberou este aparelho (resultado: %).', v_check.result; end if;
  if v_check.valid_until is not null and v_check.valid_until < v_now then raise exception 'procedencia_nao_liberada:A consulta de procedência venceu. Consulte de novo antes de concluir.'; end if;

  -- 2. fotos obrigatórias (exceção: comunicação de venda entre pessoas)
  select coalesce((tt.payload->'declaracoes'->>'origem') = 'comunicacao_de_venda', false) into v_comunicacao
    from registry_transaction_terms tt where tt.transaction_id = t.id and tt.version = t.current_terms_version;
  if not coalesce(v_comunicacao, false) or t.kind <> 'pf_pf' then
    select array_agg(s) into v_missing
    from unnest(array['frente_ligada','traseira','tela_imei']) s
    where not exists (select 1 from registry_device_media m where m.transaction_id = t.id and m.slot = s);
    if v_missing is not null then raise exception 'fotos:Faltam fotos obrigatórias: %.', array_to_string(v_missing, ', '); end if;
  end if;

  -- 3. aceites das duas partes na versão VIGENTE
  if t.current_terms_version = 0 then raise exception 'sem_termos:Confirme as condições antes de concluir.'; end if;
  if not exists (select 1 from registry_transaction_acceptances a where a.transaction_id = t.id and a.party_id = v_seller and a.terms_version = t.current_terms_version and a.terms_hash = p_terms_hash) then
    raise exception 'aceite_incompleto:Ainda falta o vendedor aceitar.'; end if;
  if not exists (select 1 from registry_transaction_acceptances a where a.transaction_id = t.id and a.party_id = v_buyer and a.terms_version = t.current_terms_version and a.terms_hash = p_terms_hash) then
    raise exception 'aceite_incompleto:Ainda falta o comprador aceitar.'; end if;

  -- 5. fecha o período do titular anterior
  select * into v_open from registry_ownership_periods where device_id = v_device_id and ended_at is null for update;
  if found then
    if v_open.party_id <> v_seller then
      if t.kind <> 'pf_pj' then raise exception 'titular_divergente:O titular atual registrado não é o vendedor desta transação.'; end if;
      insert into registry_device_events (device_id, store_id, type, visibility, transaction_id, payload, created_by)
      values (v_device_id, t.store_id, 'chain_gap', 'public', t.id,
              jsonb_build_object('aviso', 'O vendedor desta passagem não era o último titular registrado. Houve ao menos uma passagem sem registro no Cartório entre as duas.'), p_actor_user_id);
    end if;
    update registry_ownership_periods set ended_at = v_now where id = v_open.id;
  end if;

  -- 6. abre o período do novo titular
  insert into registry_ownership_periods (device_id, party_id, transaction_id, started_at) values (v_device_id, v_buyer, t.id, v_now);

  -- 7. evento público
  insert into registry_device_events (device_id, store_id, type, visibility, transaction_id, payload, created_by)
  values (v_device_id, t.store_id, 'transfer_completed', 'public', t.id,
          jsonb_build_object('protocolo', t.public_protocol, 'modalidade', t.kind, 'aceite', p_grade, 'termos_hash', p_terms_hash,
                             'consulta', jsonb_build_object('resultado', v_check.result, 'fonte', v_check.provider, 'data', v_check.checked_at)), p_actor_user_id);

  -- 8. outbox
  insert into registry_outbox_events (topic, store_id, payload)
  values ('registry.transfer_completed', t.store_id, jsonb_build_object('transaction_id', t.id, 'device_id', v_device_id, 'protocolo', t.public_protocol, 'kind', t.kind, 'aceite', p_grade));

  -- 9. estado
  update registry_transactions set state = 'completed', completed_at = v_now, updated_at = v_now where id = t.id;
  insert into registry_audit_events (store_id, actor_user_id, action, subject_type, subject_id, metadata)
  values (t.store_id, p_actor_user_id, 'tx.completed', 'transaction', t.id, jsonb_build_object('grade', p_grade));

  return jsonb_build_object('protocolo', t.public_protocol, 'grade', p_grade, 'completed_at', v_now, 'repetida', false);
end;
$$;
revoke all on function registry_complete_transaction(uuid, uuid, text, text) from public;
