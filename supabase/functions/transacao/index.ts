// transacao — criar (idempotente), obter, listar, mudar_estado, congelar_termos, estoque.
import { DomainError, type TransactionKind, type TransactionState } from "../_shared/core/index.ts";
import { exigirLoja, servir } from "../_shared/server.ts";
import { deviceView, mudarEstado, obterTx, txView, type TxRow } from "../_shared/views.ts";
import { congelarTermos, criarTransacao } from "../_shared/ops.ts";

const KINDS: TransactionKind[] = ["pf_pj", "pj_pf", "pf_pf", "pj_pj"];

servir(async (req, ctx, body) => {
  const { user, store } = exigirLoja(ctx);
  const admin = ctx.admin;
  const op = String(body.op ?? "");

  if (op === "listar") {
    const { data } = await admin.from("registry_transactions").select("*").eq("store_id", store.id).order("created_at", { ascending: false }).limit(200);
    return Promise.all((data ?? []).map((t) => txView(admin, t as TxRow)));
  }

  if (op === "estoque") {
    if (!store.party_id) return [];
    const { data } = await admin.from("registry_ownership_periods").select("device_id, started_at, transaction_id").eq("party_id", store.party_id).is("ended_at", null).order("started_at", { ascending: false });
    return Promise.all((data ?? []).map(async (o) => {
      const { data: t } = o.transaction_id ? await admin.from("registry_transactions").select("public_protocol").eq("id", o.transaction_id).maybeSingle() : { data: null };
      return { device: await deviceView(admin, o.device_id as string), desde: o.started_at, protocolo_entrada: t?.public_protocol ?? null };
    }));
  }

  if (op === "criar") {
    const key = req.headers.get("Idempotency-Key") ?? "";
    if (!key) throw new DomainError("idempotencia", "Falta o cabeçalho Idempotency-Key.");
    const kind = body.kind as TransactionKind;
    if (!KINDS.includes(kind)) throw new DomainError("kind", "Modalidade inválida.");
    const tx = await criarTransacao(admin, { store, user, ip: ctx.ip }, { kind, device_id: String(body.device_id ?? ""), seller_party_id: String(body.seller_party_id ?? ""), buyer_party_id: String(body.buyer_party_id ?? ""), idempotency_key: key });
    return txView(admin, tx);
  }

  const t = await obterTx(admin, String(body.transaction_id ?? ""), store.id);

  if (op === "obter") return txView(admin, t);

  if (op === "mudar_estado") {
    await mudarEstado(admin, t, body.novo_estado as TransactionState);
    return txView(admin, t);
  }

  if (op === "congelar_termos") {
    return congelarTermos(admin, { store, user, ip: ctx.ip }, t, {
      valor_centavos: Number(body.valor_centavos), forma_pagamento: String(body.forma_pagamento ?? ""), estado_aparelho: String(body.estado_aparelho ?? ""),
      defeitos: String(body.defeitos ?? ""), garantia: String(body.garantia ?? ""), declaracoes: (body.declaracoes as Record<string, string>) ?? {},
    });
  }

  throw new DomainError("op", "Operação desconhecida.");
});
