// consulta_procedencia — SIMULADOR com contrato de provedor real. Só 'clear'
// libera; 'restricted' bloqueia; 'inconclusive' põe em revisão; 'unavailable'
// NÃO libera. Para trocar por um provedor real, substitua `simularConsulta` em ops.ts.
import { exigirLoja, servir } from "../_shared/server.ts";
import { obterTx } from "../_shared/views.ts";
import { executarConsulta } from "../_shared/ops.ts";

servir(async (_req, ctx, body) => {
  const { user, store } = exigirLoja(ctx);
  const t = await obterTx(ctx.admin, String(body.transaction_id ?? ""), store.id);
  return executarConsulta(ctx.admin, { store, user, ip: ctx.ip }, t);
});
