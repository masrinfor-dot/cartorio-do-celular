// Operações de escrita do Cartório, compartilhadas entre as Edge Functions
// (identidade, aparelho, transacao, consulta_procedencia) e a avaliação de
// usados. Uma regra, um lugar: a avaliação fecha o negócio chamando ISTO —
// nunca uma segunda implementação.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  DomainError, cifrar, documentoValido, gerarProtocolo, hashDocumento, hashTerms, imeiValido, onlyDigits, sha256Hex, simularConsulta,
  type TermsPayload, type TransactionKind,
} from "./core/index.ts";
import { auditar, env, lancarSeErro } from "./server.ts";
import { buscaAparelho, deviceIdDaTx, imeiDoDevice, mudarEstado, obterTx, partyView, termosVigentes, type TxRow } from "./views.ts";

export interface OpCtx { store: { id: string; name: string; party_id: string | null }; user: { id: string }; ip: string | null }

const MSG_IMEI = "Esse IMEI não confere. Confira os 15 dígitos — provavelmente há um número trocado.";

export async function criarOuVincularPessoa(admin: SupabaseClient, ctx: OpCtx, d: { documento: string; tipo: "pf" | "pj"; nome: string; telefone: string }) {
  const documento = onlyDigits(d.documento);
  const nome = d.nome.trim();
  const telefone = onlyDigits(d.telefone);
  if (!documentoValido(documento, d.tipo)) throw new DomainError("documento", d.tipo === "pf" ? "Esse CPF não confere. Confira os dígitos." : "Esse CNPJ não confere. Confira os dígitos.");
  if (!nome) throw new DomainError("nome", "Informe o nome.");
  if (telefone.length < 10) throw new DomainError("telefone", "Informe o telefone com DDD — é por ele que o código de aceite chega.");
  const hash = await hashDocumento(env("REGISTRY_PII_PEPPER"), documento);
  let party_id: string;
  const { data: ident } = await admin.from("registry_party_identifiers").select("party_id").eq("value_hash", hash).maybeSingle();
  if (ident) {
    party_id = ident.party_id as string; // pessoa única na plataforma: só o vínculo é novo
  } else {
    const { data: p, error: e1 } = await admin.from("registry_parties").insert({ kind: d.tipo, display_name: nome }).select("id").single();
    lancarSeErro(e1);
    party_id = p!.id as string;
    const { error: e2 } = await admin.from("registry_party_identifiers").insert({ party_id, type: d.tipo === "pf" ? "cpf" : "cnpj", value_hash: hash, value_encrypted: await cifrar(env("REGISTRY_PII_KEY"), documento), key_version: 1 });
    lancarSeErro(e2);
  }
  const { data: telExistente } = await admin.from("registry_party_contacts").select("id").eq("party_id", party_id).eq("kind", "phone").eq("value", telefone).maybeSingle();
  if (!telExistente) await admin.from("registry_party_contacts").insert({ party_id, kind: "phone", value: telefone });
  await admin.from("registry_tenant_party_links").upsert({ store_id: ctx.store.id, party_id }, { onConflict: "store_id,party_id", ignoreDuplicates: true });
  await admin.from("registry_consents").insert({ party_id, store_id: ctx.store.id, purpose: "registro_de_passagem", evidence: { operador: ctx.user.id } });
  await auditar(admin, ctx.store.id, ctx.user.id, "party.linked", "party", party_id, {}, ctx.ip);
  return partyView(admin, party_id);
}

export async function criarAparelho(admin: SupabaseClient, ctx: OpCtx, d: { imei: string; marca?: string; modelo?: string; armazenamento?: string; cor?: string }) {
  const imei = onlyDigits(d.imei);
  if (!imeiValido(imei)) throw new DomainError("imei", MSG_IMEI);
  const { data: ativo } = await admin.from("registry_device_identifiers").select("device_id").eq("type", "imei").eq("value", imei).eq("is_active", true).maybeSingle();
  if (ativo) return { conflito: true as const, existente: await buscaAparelho(admin, ativo.device_id as string, ctx.store) };
  const device_id = await criarAparelhoSemImei(admin, ctx, d, { imei_pendente: false });
  const { error: e2 } = await admin.from("registry_device_identifiers").insert({ device_id, type: "imei", value: imei, is_active: true });
  if (e2) {
    const { data: outro } = await admin.from("registry_device_identifiers").select("device_id").eq("type", "imei").eq("value", imei).eq("is_active", true).maybeSingle();
    if (outro) return { conflito: true as const, existente: await buscaAparelho(admin, outro.device_id as string, ctx.store) };
    lancarSeErro(e2);
  }
  return { conflito: false as const, device_id };
}

export async function criarAparelhoSemImei(admin: SupabaseClient, ctx: OpCtx, d: { marca?: string; modelo?: string; armazenamento?: string; cor?: string }, extra: Record<string, unknown> = { imei_pendente: true }) {
  const { data, error } = await admin.from("registry_devices").insert({ brand: d.marca || null, model: d.modelo || null, storage: d.armazenamento || null, color: d.cor || null }).select("id").single();
  lancarSeErro(error);
  const device_id = data!.id as string;
  await admin.from("registry_device_events").insert({ device_id, store_id: ctx.store.id, type: "device_created", visibility: "public", payload: { marca: d.marca ?? null, modelo: d.modelo ?? null, ...extra }, created_by: ctx.user.id });
  await auditar(admin, ctx.store.id, ctx.user.id, "device.created", "device", device_id, {}, ctx.ip);
  return device_id;
}

/** Acrescenta o IMEI a um aparelho que nasceu sem identificador (compra com IMEI pendente). */
export async function completarImeiDoAparelho(admin: SupabaseClient, ctx: OpCtx, device_id: string, imeiRaw: string, transaction_id: string | null) {
  const imei = onlyDigits(imeiRaw);
  if (!imeiValido(imei)) throw new DomainError("imei", MSG_IMEI);
  if (await imeiDoDevice(admin, device_id)) throw new DomainError("imei_ja", "Este aparelho já tem IMEI. Para corrigir, abra uma contestação.", 409);
  const { data: ativo } = await admin.from("registry_device_identifiers").select("device_id").eq("type", "imei").eq("value", imei).eq("is_active", true).maybeSingle();
  if (ativo) throw new DomainError("imei_conflito", "Este IMEI já está cadastrado em outro aparelho do Cartório. Confira o número — se estiver certo, a compra precisa ser refeita apontando para o aparelho existente.", 409);
  const { error } = await admin.from("registry_device_identifiers").insert({ device_id, type: "imei", value: imei, is_active: true });
  lancarSeErro(error);
  await admin.from("registry_device_events").insert({ device_id, store_id: ctx.store.id, type: "imei_completed", visibility: "tenant", transaction_id, payload: { por: ctx.user.id }, created_by: ctx.user.id });
}

export async function criarTransacao(admin: SupabaseClient, ctx: OpCtx, d: { kind: TransactionKind; device_id: string; seller_party_id: string; buyer_party_id: string; idempotency_key: string }): Promise<TxRow> {
  const request_hash = await sha256Hex(JSON.stringify({ kind: d.kind, device_id: d.device_id, seller_party_id: d.seller_party_id, buyer_party_id: d.buyer_party_id }));
  const { data: idem } = await admin.from("registry_idempotency_keys").select("request_hash, response").eq("scope", "tx.create").eq("key", d.idempotency_key).eq("store_id", ctx.store.id).maybeSingle();
  if (idem) {
    if (idem.request_hash !== request_hash) throw new DomainError("idempotencia_conflito", "Esta chave já foi usada com dados diferentes.", 409);
    return obterTx(admin, (idem.response as { id: string }).id, ctx.store.id);
  }
  if (d.kind === "pj_pf") {
    const { data: titular } = await admin.from("registry_ownership_periods").select("party_id").eq("device_id", d.device_id).is("ended_at", null).maybeSingle();
    if (!titular || titular.party_id !== ctx.store.party_id) throw new DomainError("nao_titular", "A loja não é a titular atual deste aparelho. Não se vende o que não se tem.", 403);
  }
  const { data: t, error: e1 } = await admin.from("registry_transactions").insert({ store_id: ctx.store.id, kind: d.kind, state: "awaiting_data", public_protocol: gerarProtocolo(), created_by: ctx.user.id }).select("*").single();
  lancarSeErro(e1);
  const tx = t as TxRow;
  const { error: e2 } = await admin.from("registry_transaction_parties").insert([
    { transaction_id: tx.id, party_id: d.seller_party_id, role: "seller", is_tenant_side: d.seller_party_id === ctx.store.party_id },
    { transaction_id: tx.id, party_id: d.buyer_party_id, role: "buyer", is_tenant_side: d.buyer_party_id === ctx.store.party_id },
  ]);
  lancarSeErro(e2);
  const { error: e3 } = await admin.from("registry_transaction_devices").insert({ transaction_id: tx.id, device_id: d.device_id });
  lancarSeErro(e3);
  await admin.from("registry_idempotency_keys").insert({ scope: "tx.create", key: d.idempotency_key, store_id: ctx.store.id, request_hash, response: { id: tx.id } });
  await auditar(admin, ctx.store.id, ctx.user.id, "tx.created", "transaction", tx.id, { kind: d.kind }, ctx.ip);
  return tx;
}

export async function congelarTermos(admin: SupabaseClient, ctx: OpCtx, t: TxRow, termos: Partial<TermsPayload> & { valor_centavos: number; forma_pagamento: string }) {
  if (["completed", "cancelled", "expired", "disputed", "blocked"].includes(t.state)) throw new DomainError("tx_encerrada", "Esta transação não aceita mais mudanças.", 409);
  if (!(termos.valor_centavos > 0)) throw new DomainError("valor", "Informe o valor.");
  if (!termos.forma_pagamento) throw new DomainError("forma_pagamento", "Informe a forma de pagamento.");
  const payload: TermsPayload = {
    valor_centavos: Math.round(termos.valor_centavos), forma_pagamento: termos.forma_pagamento, estado_aparelho: termos.estado_aparelho ?? "",
    defeitos: termos.defeitos ?? "", garantia: termos.garantia ?? "", declaracoes: termos.declaracoes ?? {},
  };
  const content_hash = await hashTerms(payload);
  const vig = await termosVigentes(admin, t);
  if (vig && vig.content_hash === content_hash) return { version: vig.version, content_hash, unchanged: true };
  const version = t.current_terms_version + 1;
  const { error: e1 } = await admin.from("registry_transaction_terms").insert({ transaction_id: t.id, version, payload, content_hash, created_by: ctx.user.id });
  lancarSeErro(e1);
  const { error: e2 } = await admin.from("registry_transactions").update({ current_terms_version: version, updated_at: new Date().toISOString() }).eq("id", t.id);
  lancarSeErro(e2);
  await admin.from("registry_acceptance_invites").update({ revoked_at: new Date().toISOString(), revoked_reason: "termos_alterados" })
    .eq("transaction_id", t.id).lt("terms_version", version).is("consumed_at", null).is("revoked_at", null);
  t.current_terms_version = version;
  if (t.state === "awaiting_buyer" || t.state === "ready_to_complete") await mudarEstado(admin, t, "awaiting_seller");
  await auditar(admin, ctx.store.id, ctx.user.id, "tx.terms_frozen", "transaction", t.id, { version }, ctx.ip);
  return { version, content_hash, unchanged: false };
}

/** Consulta de procedência DESTA transação (simulador com contrato de provedor real). */
export async function executarConsulta(admin: SupabaseClient, ctx: OpCtx, t: TxRow) {
  const device_id = await deviceIdDaTx(admin, t.id);
  const imei = await imeiDoDevice(admin, device_id);
  if (!imei) throw new DomainError("imei_pendente", "Este aparelho ainda não tem IMEI. Complete o IMEI antes da consulta.", 409);
  const out = simularConsulta(imei);
  const { error } = await admin.from("registry_device_checks").insert({ device_id, transaction_id: t.id, ...out, created_by: ctx.user.id });
  lancarSeErro(error);
  if (t.state === "awaiting_data") await mudarEstado(admin, t, "awaiting_checks");
  if (t.state === "awaiting_checks" || t.state === "under_review") {
    if (out.result === "clear") await mudarEstado(admin, t, "awaiting_seller");
    else if (out.result === "restricted") await mudarEstado(admin, t, "blocked");
    else if (out.result === "inconclusive" && t.state !== "under_review") await mudarEstado(admin, t, "under_review");
  }
  await admin.from("registry_device_events").insert({ device_id, store_id: ctx.store.id, type: "check_performed", visibility: "tenant", transaction_id: t.id, payload: { resultado: out.result, fonte: out.provider, data: out.checked_at }, created_by: ctx.user.id });
  return out;
}
