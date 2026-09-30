// transacao — criar (idempotente), obter, listar, mudar_estado, congelar_termos, estoque.
import { DomainError, gerarProtocolo, hashTerms, sha256Hex, type TermsPayload, type TransactionKind, type TransactionState } from "../_shared/core/index.ts";
import { auditar, exigirLoja, lancarSeErro, servir } from "../_shared/server.ts";
import { deviceView, mudarEstado, obterTx, termosVigentes, txView, type TxRow } from "../_shared/views.ts";

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
    const kind = body.kind as TransactionKind;
    const device_id = String(body.device_id ?? "");
    const seller_party_id = String(body.seller_party_id ?? "");
    const buyer_party_id = String(body.buyer_party_id ?? "");
    if (!KINDS.includes(kind)) throw new DomainError("kind", "Modalidade inválida.");
    const key = req.headers.get("Idempotency-Key") ?? "";
    if (!key) throw new DomainError("idempotencia", "Falta o cabeçalho Idempotency-Key.");
    const request_hash = await sha256Hex(JSON.stringify({ kind, device_id, seller_party_id, buyer_party_id }));
    const { data: idem } = await admin.from("registry_idempotency_keys").select("request_hash, response").eq("scope", "tx.create").eq("key", key).eq("store_id", store.id).maybeSingle();
    if (idem) {
      if (idem.request_hash !== request_hash) throw new DomainError("idempotencia_conflito", "Esta chave já foi usada com dados diferentes.", 409);
      return txView(admin, await obterTx(admin, (idem.response as { id: string }).id, store.id));
    }
    if (kind === "pj_pf") {
      const { data: titular } = await admin.from("registry_ownership_periods").select("party_id").eq("device_id", device_id).is("ended_at", null).maybeSingle();
      if (!titular || titular.party_id !== store.party_id) throw new DomainError("nao_titular", "A loja não é a titular atual deste aparelho. Não se vende o que não se tem.", 403);
    }
    const { data: t, error: e1 } = await admin.from("registry_transactions").insert({ store_id: store.id, kind, state: "awaiting_data", public_protocol: gerarProtocolo(), created_by: user.id }).select("*").single();
    lancarSeErro(e1);
    const tx = t as TxRow;
    const { error: e2 } = await admin.from("registry_transaction_parties").insert([
      { transaction_id: tx.id, party_id: seller_party_id, role: "seller", is_tenant_side: seller_party_id === store.party_id },
      { transaction_id: tx.id, party_id: buyer_party_id, role: "buyer", is_tenant_side: buyer_party_id === store.party_id },
    ]);
    lancarSeErro(e2);
    const { error: e3 } = await admin.from("registry_transaction_devices").insert({ transaction_id: tx.id, device_id });
    lancarSeErro(e3);
    await admin.from("registry_idempotency_keys").insert({ scope: "tx.create", key, store_id: store.id, request_hash, response: { id: tx.id } });
    await auditar(admin, store.id, user.id, "tx.created", "transaction", tx.id, { kind }, ctx.ip);
    return txView(admin, tx);
  }

  const t = await obterTx(admin, String(body.transaction_id ?? ""), store.id);

  if (op === "obter") return txView(admin, t);

  if (op === "mudar_estado") {
    await mudarEstado(admin, t, body.novo_estado as TransactionState);
    return txView(admin, t);
  }

  if (op === "congelar_termos") {
    if (["completed", "cancelled", "expired", "disputed", "blocked"].includes(t.state)) throw new DomainError("tx_encerrada", "Esta transação não aceita mais mudanças.", 409);
    const valor = Number(body.valor_centavos);
    if (!(valor > 0)) throw new DomainError("valor", "Informe o valor.");
    if (!body.forma_pagamento) throw new DomainError("forma_pagamento", "Informe a forma de pagamento.");
    const payload: TermsPayload = {
      valor_centavos: Math.round(valor), forma_pagamento: String(body.forma_pagamento), estado_aparelho: String(body.estado_aparelho ?? ""),
      defeitos: String(body.defeitos ?? ""), garantia: String(body.garantia ?? ""), declaracoes: (body.declaracoes as Record<string, string>) ?? {},
    };
    const content_hash = await hashTerms(payload);
    const vig = await termosVigentes(admin, t);
    if (vig && vig.content_hash === content_hash) return { version: vig.version, content_hash, unchanged: true };
    const version = t.current_terms_version + 1;
    const { error: e1 } = await admin.from("registry_transaction_terms").insert({ transaction_id: t.id, version, payload, content_hash, created_by: user.id });
    lancarSeErro(e1);
    const { error: e2 } = await admin.from("registry_transactions").update({ current_terms_version: version, updated_at: new Date().toISOString() }).eq("id", t.id);
    lancarSeErro(e2);
    // Revoga convites das versões anteriores. Os aceites antigos simplesmente deixam de contar.
    await admin.from("registry_acceptance_invites").update({ revoked_at: new Date().toISOString(), revoked_reason: "termos_alterados" })
      .eq("transaction_id", t.id).lt("terms_version", version).is("consumed_at", null).is("revoked_at", null);
    t.current_terms_version = version;
    if (t.state === "awaiting_buyer" || t.state === "ready_to_complete") await mudarEstado(admin, t, "awaiting_seller");
    await auditar(admin, store.id, user.id, "tx.terms_frozen", "transaction", t.id, { version }, ctx.ip);
    return { version, content_hash, unchanged: false };
  }

  throw new DomainError("op", "Operação desconhecida.");
});
