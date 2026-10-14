-- 0007 — venda em lote entre lojas (PJ→PJ).
-- Cada aparelho é uma transação pj_pj normal (protocolo, certificado e elo próprios).
-- O lote só junta o ACEITE da loja compradora: um link e um código para o conjunto.
-- A impressão digital (fingerprint) cobre transação + hash dos termos de cada item:
-- se qualquer item mudar depois do envio, o link deixa de valer.

create table if not exists registry_batches (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references stores(id) on delete restrict,
  buyer_party_id uuid not null references registry_parties(id) on delete restrict,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists registry_batches_store_idx on registry_batches(store_id, created_at desc);

create table if not exists registry_batch_items (
  id             uuid primary key default gen_random_uuid(),
  batch_id       uuid not null references registry_batches(id) on delete cascade,
  transaction_id uuid not null references registry_transactions(id) on delete restrict,
  unique (transaction_id)                       -- uma transação só pertence a um lote
);
create index if not exists registry_batch_items_batch_idx on registry_batch_items(batch_id);

create table if not exists registry_batch_invites (
  id                 uuid primary key default gen_random_uuid(),
  batch_id           uuid not null references registry_batches(id) on delete cascade,
  party_id           uuid not null references registry_parties(id) on delete restrict,
  token_hash         text not null unique,
  fingerprint        text not null,
  transaction_ids    uuid[] not null,           -- quem entrou neste convite (itens liberados na consulta)
  destination_masked text not null,
  otp_hash           text,
  otp_expires_at     timestamptz,
  otp_attempts       integer not null default 0,
  otp_sent_count     integer not null default 0,
  expires_at         timestamptz not null,
  consumed_at        timestamptz,
  revoked_at         timestamptz,
  revoked_reason     text,
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now()
);
create index if not exists registry_batch_invites_batch_idx on registry_batch_invites(batch_id, created_at desc);

alter table registry_batches        enable row level security;
alter table registry_batch_items    enable row level security;
alter table registry_batch_invites  enable row level security;
-- Sem policies: só a service role (Edge Functions) lê e escreve.
revoke all on registry_batches, registry_batch_items, registry_batch_invites from anon, authenticated;

-- Conclusão com a dispensa de fotos para lote PJ→PJ (o resto é igual à 0004).
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
  v_lote        boolean;
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
  select coalesce((tt.payload->'declaracoes'->>'origem') = 'comunicacao_de_venda', false),
         coalesce((tt.payload->'declaracoes'->>'origem') = 'lote_pj', false)
    into v_comunicacao, v_lote
    from registry_transaction_terms tt where tt.transaction_id = t.id and tt.version = t.current_terms_version;
  -- Dispensa: comunicação de venda PF→PF, e lote PJ→PJ (a loja vendedora é a titular registrada).
  if not ((coalesce(v_comunicacao, false) and t.kind = 'pf_pf') or (coalesce(v_lote, false) and t.kind = 'pj_pj')) then
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
