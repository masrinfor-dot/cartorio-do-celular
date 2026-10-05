// manutencao — rotina diária (agendada), NÃO chamada pela interface.
// Expira transações paradas e avisa compradores sobre garantia perto do fim.
// Protegida por segredo próprio no cabeçalho X-Cron-Secret.
import { DomainError, iguaisTempoConstante } from "../_shared/core/index.ts";
import { CORS, adminClient, env, json } from "../_shared/server.ts";
import { expirarPendentes, lembrarGarantias } from "../_shared/ops.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const segredo = env("CRON_SECRET");
    const recebido = req.headers.get("X-Cron-Secret") ?? "";
    if (!recebido || !iguaisTempoConstante(recebido, segredo)) throw new DomainError("nao_autorizado", "Não autorizado.", 401);
    const admin = adminClient();
    const expiradas = await expirarPendentes(admin);
    const garantias = await lembrarGarantias(admin);
    return json({ expiradas, garantias });
  } catch (e) {
    if (e instanceof DomainError) return json({ error: { code: e.code, message: e.message } }, e.status);
    console.error("manutencao falhou", e instanceof Error ? e.message : e);
    return json({ error: { code: "erro", message: "Falha na manutenção." } }, 500);
  }
});
