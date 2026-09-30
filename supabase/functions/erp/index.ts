// erp — envia uma compra/venda CONCLUÍDA ao ERP da loja (Sheik Company ERP),
// que dá entrada no estoque e emite a NF-e. O banco do Cartório fica separado:
// o ERP só recebe o que foi concluído; nada dele escreve aqui.
//   op "enviar" { transaction_id } · op "envios" { transaction_id }
import { DomainError } from "../_shared/core/index.ts";
import { auditar, exigirLoja, lancarSeErro, servir } from "../_shared/server.ts";
import { obterTx, txView } from "../_shared/views.ts";

type ErpCfg = { ativo: boolean; url: string; token: string; enviar_compras: boolean; enviar_vendas: boolean; solicitar_nfe: boolean };

servir(async (_req, ctx, body) => {
  const { user, store } = exigirLoja(ctx);
  const admin = ctx.admin;
  const op = String(body.op ?? "");
  const transaction_id = String(body.transaction_id ?? "");

  if (op === "envios") {
    const { data } = await admin.from("erp_dispatches").select("id, transaction_id, tipo, status, erp_ref, nfe_status, mensagem, created_at").eq("store_id", store.id).eq("transaction_id", transaction_id).order("created_at", { ascending: false });
    return data ?? [];
  }
  if (op !== "enviar") throw new DomainError("op", "Operação desconhecida.");

  const t = await obterTx(admin, transaction_id, store.id);
  if (t.state !== "completed") throw new DomainError("erp", "Só compras e vendas concluídas no Cartório vão para o ERP.", 409);
  const { data: cfgRow } = await admin.from("store_settings").select("value").eq("store_id", store.id).eq("key", "erp").maybeSingle();
  const erp = (cfgRow?.value ?? {}) as Partial<ErpCfg>;
  if (!erp.ativo) throw new DomainError("erp_inativo", "A integração com o ERP está desligada. Ative em Configurações → Integração ERP.", 409);
  if (!erp.url) throw new DomainError("erp_url", "Informe a URL da API do ERP em Configurações.", 409);
  const tipo: "compra" | "venda" = t.kind === "pj_pf" ? "venda" : "compra";
  if (tipo === "compra" && erp.enviar_compras === false) throw new DomainError("erp", "O envio de compras ao ERP está desligado.", 409);
  if (tipo === "venda" && erp.enviar_vendas === false) throw new DomainError("erp", "O envio de vendas ao ERP está desligado.", 409);

  const tv = await txView(admin, t);
  const p = tv.terms!.payload;
  const payload = {
    origem: "cartorio-do-celular", protocolo: tv.public_protocol, tipo, solicitar_nfe: erp.solicitar_nfe !== false,
    aparelho: { device_id: tv.device?.device_id, marca: tv.device?.brand, modelo: tv.device?.model, armazenamento: tv.device?.storage, cor: tv.device?.color, imei_mascarado: tv.device?.imei_mascarado },
    partes: tv.parties.map((x) => ({ party_id: x.party_id, papel: x.role, loja: x.is_tenant_side })),
    valor_centavos: p.valor_centavos, forma_pagamento: p.forma_pagamento, garantia: p.garantia,
    declarado: { estado: p.estado_aparelho, defeitos: p.defeitos, ...(p.declaracoes ?? {}) },
    consulta: tv.check ? { resultado: tv.check.result, fonte: tv.check.provider, data: tv.check.checked_at } : null,
    aceite: tv.aceite.grade, concluido_em: tv.completed_at,
  };

  // POST no ERP com timeout curto. Sucesso ou erro, o envio fica registrado.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  let status: "enviado" | "erro" = "erro";
  let response: unknown = null;
  let erp_ref: string | null = null;
  let nfe_status: string | null = null;
  let mensagem: string | null = null;
  try {
    const url = `${erp.url.replace(/\/$/, "")}/${tipo === "compra" ? "device-purchases" : "device-sales"}`;
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(erp.token ? { Authorization: `Bearer ${erp.token}` } : {}) }, body: JSON.stringify(payload), signal: ctrl.signal });
    response = await res.json().catch(() => ({ status: res.status }));
    if (res.ok) {
      status = "enviado";
      const r = response as Record<string, unknown>;
      erp_ref = (r.id ?? r.ref ?? r.erp_ref ?? null) as string | null;
      nfe_status = (r.nfe_status ?? r.nfe ?? (payload.solicitar_nfe ? "solicitada ao ERP" : "não solicitada")) as string;
      mensagem = "Recebido pelo ERP.";
    } else {
      mensagem = `O ERP respondeu ${res.status}. Confira a URL e o token em Configurações.`;
    }
  } catch {
    mensagem = "O ERP não respondeu em 12 segundos. O registro do Cartório está concluído; tente enviar de novo mais tarde.";
  } finally {
    clearTimeout(timer);
  }
  const { data: envio, error } = await admin.from("erp_dispatches").insert({ store_id: store.id, transaction_id, tipo, status, erp_ref, nfe_status, mensagem, payload, response, created_by: user.id }).select("id, transaction_id, tipo, status, erp_ref, nfe_status, mensagem, created_at").single();
  lancarSeErro(error);
  await admin.from("registry_outbox_events").insert({ topic: `erp.${tipo}.${status}`, store_id: store.id, payload: { transaction_id, erp_ref }, processed_at: new Date().toISOString() });
  await auditar(admin, store.id, user.id, "erp.sent", "transaction", transaction_id, { tipo, status }, ctx.ip);
  if (status === "erro") throw new DomainError("erp_falha", mensagem ?? "Falha ao enviar ao ERP.", 502);
  return envio;
});
