-- 0005 — expiração de transações paradas e lembrete de garantia.
-- A expiração em si é feita pela Edge Function `manutencao` (usa o motor de
-- estados, então nenhuma transição proibida passa). Esta migration só guarda
-- o registro de lembretes enviados, para nunca avisar duas vezes.

create table if not exists registry_reminders (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references registry_transactions(id) on delete cascade,
  party_id       uuid not null references registry_parties(id) on delete restrict,
  kind           text not null check (kind in ('warranty_expiring')),
  sent_at        timestamptz not null default now(),
  unique (transaction_id, kind)
);

alter table registry_reminders enable row level security;
-- Sem policies: só a service role (Edge Functions) lê e escreve.
revoke all on registry_reminders from anon, authenticated;

-- Agendamento (rode UMA vez, depois de publicar a função `manutencao` e definir
-- CRON_SECRET nos segredos). Exige as extensões pg_cron e pg_net:
--
--   select cron.schedule('cartorio-manutencao', '0 9 * * *', $$
--     select net.http_post(
--       url     := 'https://<PROJETO>.supabase.co/functions/v1/manutencao',
--       headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'),
--       body    := '{}'::jsonb);
--   $$);
