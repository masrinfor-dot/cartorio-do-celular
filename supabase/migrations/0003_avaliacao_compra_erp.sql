-- ============================================================================
-- 0003 — Avaliação de usados / compra (portada do Sheik CRM), configurações
-- por loja, dados extras do vendedor (cifrados), integração ERP e os valores
-- de enum previstos pelo benchmark da Carteira Digital de Trânsito.
-- Idempotente.
-- ============================================================================

-- Slots de foto: + comprovante de pagamento. (CHECK inline recebe nome automático.)
alter table registry_device_media drop constraint if exists registry_device_media_slot_check;
alter table registry_device_media add constraint registry_device_media_slot_check
  check (slot in ('frente_ligada','traseira','tela_imei','laterais','avarias','documento','selfie','comprovante'));

-- Canal de aceite: + govbr (assinatura eletrônica gov.br — canal superior ao OTP).
-- Só ACRESCENTA valor: a tabela é append-only e nenhum registro antigo muda.
alter table registry_transaction_acceptances drop constraint if exists registry_transaction_acceptances_channel_check;
alter table registry_transaction_acceptances add constraint registry_transaction_acceptances_channel_check
  check (channel in ('otp_whatsapp','portal','operator_pj','presencial_assistido','govbr'));

-- Grau de identidade da parte (separado do grau do aceite).
alter table registry_parties add column if not exists identity_level text not null default 'cadastrada'
  check (identity_level in ('cadastrada','verificada','govbr_prata','govbr_ouro'));

-- ----------------------------------------------------------------------------
-- Dados extras do vendedor para a nota de compra — CIFRADOS. Só Edge Function lê.
-- ----------------------------------------------------------------------------
create table if not exists registry_party_details (
  party_id           uuid primary key references registry_parties(id) on delete cascade,
  rg_encrypted       text,
  endereco_encrypted text,
  bairro_encrypted   text,
  key_version        smallint not null default 1,
  updated_at         timestamptz not null default now()
);
alter table registry_party_details enable row level security;
-- sem política: nada sai pelo client.

-- ----------------------------------------------------------------------------
-- Configurações por loja (margens, questionário, formas de pagamento, valores base, erp)
-- ----------------------------------------------------------------------------
create table if not exists store_settings (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references stores(id) on delete cascade,
  key        text not null,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (store_id, key)
);
alter table store_settings enable row level security;
drop policy if exists store_settings_select on store_settings;
-- A loja lê as próprias configurações, EXCETO a do ERP (tem token) — essa só a Edge Function lê.
create policy store_settings_select on store_settings for select using (store_id = current_store_id() and key <> 'erp');

-- ----------------------------------------------------------------------------
-- Avaliações de usados (orçamento → compra). Cada avaliação fechada é uma compra
-- e aponta para a transação PF→PJ do Cartório que ela gerou.
-- ----------------------------------------------------------------------------
create table if not exists trade_in_evaluations (
  id                   uuid primary key default gen_random_uuid(),
  store_id             uuid not null references stores(id) on delete cascade,
  user_id              uuid references auth.users(id) on delete set null,
  source               text not null default 'staff',
  brand                text not null,
  model                text not null,
  memory               text,
  color                text,
  device               text not null,
  customer_name        text,
  answers              jsonb not null default '{}'::jsonb,
  estimativa           jsonb,
  margem_tabela        smallint not null default 2 check (margem_tabela in (1,2,3)),
  -- fechamento
  closed_at            timestamptz,
  final_price_centavos integer,
  payment_method       text,
  pix_key_encrypted    text,          -- chave Pix pode ser CPF/telefone: cifrada
  pix_key_holder       text,
  seller_party_id      uuid references registry_parties(id) on delete restrict,
  device_id            uuid references registry_devices(id) on delete restrict,
  transaction_id       uuid references registry_transactions(id) on delete set null,
  store_name           text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists trade_in_evaluations_store_idx on trade_in_evaluations(store_id, created_at desc);
create index if not exists trade_in_evaluations_tx_idx on trade_in_evaluations(transaction_id);
alter table trade_in_evaluations enable row level security;
drop policy if exists trade_in_select on trade_in_evaluations;
create policy trade_in_select on trade_in_evaluations for select using (store_id = current_store_id());

-- ----------------------------------------------------------------------------
-- Envios ao ERP (compra/venda concluída → Sheik Company ERP, que emite a NF-e)
-- ----------------------------------------------------------------------------
create table if not exists erp_dispatches (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references stores(id) on delete cascade,
  transaction_id uuid not null references registry_transactions(id) on delete cascade,
  tipo           text not null check (tipo in ('compra','venda')),
  status         text not null check (status in ('enviado','erro','simulado')),
  erp_ref        text,
  nfe_status     text,
  mensagem       text,
  payload        jsonb not null default '{}'::jsonb,
  response       jsonb,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists erp_dispatches_tx_idx on erp_dispatches(transaction_id, created_at desc);
alter table erp_dispatches enable row level security;
drop policy if exists erp_dispatches_select on erp_dispatches;
create policy erp_dispatches_select on erp_dispatches for select using (store_id = current_store_id());

-- Evento de IMEI completado depois da compra (aparelho que nasceu sem IMEI).
-- Não precisa de schema: registry_device_events aceita qualquer type.
