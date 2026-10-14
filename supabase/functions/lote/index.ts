// lote — venda em lote entre lojas (PJ→PJ). Sessão da loja.
//   criar · enviar · obter · listar · concluir
import { DomainError } from "../_shared/core/index.ts";
import { exigirLoja, servir } from "../_shared/server.ts";
import { concluirLote, criarLote, enviarLote, listarLotes, viewLote } from "../_shared/lote.ts";

servir(async (req, ctx, body) => {
  const { user, store } = exigirLoja(ctx);
  const admin = ctx.admin;
  const op = String(body.op ?? "");
  const oc = { store, user, ip: ctx.ip };
  const id = String(body.id ?? "");

  if (op === "criar") {
    const key = req.headers.get("Idempotency-Key") ?? "";
    if (!key) throw new DomainError("idempotencia", "Falta o cabeçalho Idempotency-Key.");
    const c = (body.comprador ?? {}) as Record<string, string>;
    const batch_id = await criarLote(admin, oc, {
      comprador: { documento: String(c.documento ?? ""), nome: String(c.nome ?? ""), telefone: String(c.telefone ?? "") },
      itens: ((body.itens ?? []) as Array<{ device_id: string; valor_centavos: number }>).map((i) => ({ device_id: String(i.device_id ?? ""), valor_centavos: Math.round(Number(i.valor_centavos)) })),
      forma_pagamento: String(body.forma_pagamento ?? ""), garantia: String(body.garantia ?? ""), estado_aparelho: String(body.estado_aparelho ?? ""), idempotency_key: key,
    });
    return viewLote(admin, store.id, batch_id);
  }
  if (op === "listar") return listarLotes(admin, store.id);
  if (op === "obter") return viewLote(admin, store.id, id);
  if (op === "enviar") { const r = await enviarLote(admin, oc, id); return { ...r, lote: await viewLote(admin, store.id, id) }; }
  if (op === "concluir") { const resultados = await concluirLote(admin, oc, id); return { resultados, lote: await viewLote(admin, store.id, id) }; }
  throw new DomainError("op", "Operação desconhecida.");
});
