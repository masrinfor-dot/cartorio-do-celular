// convite — "criar": gera o link de aceite para a PARTE (nunca para a loja),
// grava só o hash do token, envia pelo WhatsApp DA PARTE e devolve o link uma
// única vez. O código de 6 dígitos nasce depois, na rota pública, e nunca
// aparece em resposta nenhuma.
import { DomainError } from "../_shared/core/index.ts";
import { exigirLoja, servir } from "../_shared/server.ts";
import { obterTx, partesDaTx } from "../_shared/views.ts";
import { criarConvite } from "../_shared/ops.ts";

servir(async (_req, ctx, body) => {
  const { user, store } = exigirLoja(ctx);
  if (body.op !== "criar") throw new DomainError("op", "Operação desconhecida.");
  const t = await obterTx(ctx.admin, String(body.transaction_id ?? ""), store.id);
  const party_id = String(body.party_id ?? "");
  const parte = (await partesDaTx(ctx.admin, t.id)).find((p) => p.party_id === party_id);
  if (!parte) throw new DomainError("parte", "Essa pessoa não faz parte desta transação.", 404);
  if (parte.is_tenant_side) throw new DomainError("convite_loja", "A loja tem canal próprio de aceite; o convite é para a outra parte.", 403);
  return criarConvite(ctx.admin, { store, user, ip: ctx.ip }, t, party_id, `${store.name} registrou a passagem do seu aparelho`);
});
