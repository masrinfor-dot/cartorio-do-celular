-- 0006 — LGPD: registro de quem viu documento/selfie e expurgo por prazo.
--
-- O QUE FICA para sempre: o elo (quem, quando, protocolo) e o SHA-256 da foto
-- (prova de que existiu, sem a imagem). O QUE SAI depois do prazo: o arquivo
-- de documento e de selfie. O prazo (padrão 5 anos) está em core/prazos.ts e
-- precisa ser confirmado no parecer jurídico — está marcado como pendente.

alter table registry_device_media add column if not exists purged_at timestamptz;

create table if not exists registry_access_log (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid references stores(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_party_id uuid references registry_parties(id) on delete set null,   -- pessoa física vendo o próprio registro
  subject_type  text not null check (subject_type in ('media','nota_compra','nota_venda')),
  subject_id    uuid not null,
  detail        jsonb not null default '{}'::jsonb,                          -- ex.: {"slot":"documento"} — nunca o conteúdo
  created_at    timestamptz not null default now()
);
create index if not exists registry_access_log_subject_idx on registry_access_log(subject_type, subject_id, created_at desc);

alter table registry_access_log enable row level security;
revoke all on registry_access_log from anon, authenticated;

-- Só se acrescenta: ninguém edita nem apaga o histórico de acessos.
create or replace function registry_access_log_imutavel() returns trigger language plpgsql as $$
begin
  raise exception 'imutavel:O registro de acessos só aceita novas linhas.';
end;
$$;
drop trigger if exists registry_access_log_no_update on registry_access_log;
create trigger registry_access_log_no_update before update or delete on registry_access_log
  for each row execute function registry_access_log_imutavel();
