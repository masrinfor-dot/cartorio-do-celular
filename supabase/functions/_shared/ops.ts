// Operações de escrita do Cartório, compartilhadas entre as Edge Functions
// (identidade, aparelho, transacao, consulta_procedencia) e a avaliação de
// usados. Uma regra, um lugar: a avaliação fecha o negócio chamando ISTO —
// nunca uma segunda implementação.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  DomainError, INVITE_TTL_MS, LEMBRETE_GARANTIA_DIAS, deveExpirar, garantiaDe, nomeCurto, cifrar, descreverFaltantes, documentoValido, gerarProtocolo, gerarToken, hashDocumento, hashTerms, imeiValido, mascararTelefone, onlyDigits, sha256Hex, simularConsulta,
  type TermsPayload, type TransactionKind,
} from "./core/index.ts";
import { auditar, env, lancarSeErro, traduzirErroBanco } from "./server.ts";
import { buscaAparelho, deviceIdDaTx, deviceView, imeiDoDevice, mudarEstado, obterTx, partyView, statusAceite, telefoneDaParte, termosVigentes, type TxRow } from "./views.ts";
import { enviarWhatsapp } from "./whatsapp.ts";
import { montarCertificado } from "./certificado.ts";

export interface OpCtx { store: { id: string; name: string; party_id: string | null }; user: { id: string }; ip: string | null }
/** Contexto sem loja e sem usuário de loja — portal PF e conclusão automática. */
export interface OpCtxLivre { store: { id: string } | null; user: { id: string } | null; ip: string | null }

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
export async function executarConsulta(admin: SupabaseClient, ctx: OpCtxLivre, t: TxRow) {
  const device_id = await deviceIdDaTx(admin, t.id);
  const imei = await imeiDoDevice(admin, device_id);
  if (!imei) throw new DomainError("imei_pendente", "Este aparelho ainda não tem IMEI. Complete o IMEI antes da consulta.", 409);
  const out = simularConsulta(imei);
  const { error } = await admin.from("registry_device_checks").insert({ device_id, transaction_id: t.id, ...out, created_by: ctx.user?.id ?? null });
  lancarSeErro(error);
  if (t.state === "awaiting_data") await mudarEstado(admin, t, "awaiting_checks");
  if (t.state === "awaiting_checks" || t.state === "under_review") {
    if (out.result === "clear") await mudarEstado(admin, t, "awaiting_seller");
    else if (out.result === "restricted") await mudarEstado(admin, t, "blocked");
    else if (out.result === "inconclusive" && t.state !== "under_review") await mudarEstado(admin, t, "under_review");
  }
  await admin.from("registry_device_events").insert({ device_id, store_id: ctx.store?.id ?? null, type: "check_performed", visibility: "tenant", transaction_id: t.id, payload: { resultado: out.result, fonte: out.provider, data: out.checked_at }, created_by: ctx.user?.id ?? null });
  return out;
}

/** Convite de aceite para uma parte (loja ou portal PF). O link volta UMA vez; o código nasce depois, na rota pública. */
export async function criarConvite(admin: SupabaseClient, ctx: OpCtxLivre, t: TxRow, party_id: string, remetente: string) {
  const terms = await termosVigentes(admin, t);
  if (!terms) throw new DomainError("sem_termos", "Confirme as condições antes de enviar o código.", 409);
  const telefone = await telefoneDaParte(admin, party_id);
  if (!telefone) throw new DomainError("sem_telefone", "Essa pessoa não tem telefone cadastrado — e o código só chega por ele.", 409);
  const agora = new Date();
  const token = gerarToken();
  const token_hash = await sha256Hex(token);
  const { data: vivo } = await admin.from("registry_acceptance_invites").select("id, expires_at")
    .eq("transaction_id", t.id).eq("party_id", party_id).eq("terms_version", terms.version).is("consumed_at", null).is("revoked_at", null).maybeSingle();
  let invite_id: string;
  let reaproveitado = false;
  if (vivo && new Date(vivo.expires_at as string) > agora) {
    const { error } = await admin.from("registry_acceptance_invites").update({ token_hash }).eq("id", vivo.id);
    lancarSeErro(error);
    invite_id = vivo.id as string; reaproveitado = true;
  } else {
    if (vivo) await admin.from("registry_acceptance_invites").update({ revoked_at: agora.toISOString(), revoked_reason: "expirado" }).eq("id", vivo.id);
    const { data, error } = await admin.from("registry_acceptance_invites").insert({
      transaction_id: t.id, party_id, terms_version: terms.version, terms_hash: terms.content_hash, token_hash,
      destination_masked: mascararTelefone(telefone), expires_at: new Date(agora.getTime() + INVITE_TTL_MS).toISOString(), created_by: ctx.user?.id ?? null,
    }).select("id").single();
    lancarSeErro(error);
    invite_id = data!.id as string;
  }
  const link = `${env("PUBLIC_APP_URL").replace(/\/$/, "")}/aceite/${token}`;
  await enviarWhatsapp(telefone, `Cartório do Celular — ${remetente}. Para confirmar, abra o link e informe o código que vai chegar aqui: ${link}`);
  await auditar(admin, ctx.store?.id ?? null, ctx.user?.id ?? null, "invite.sent", "invite", invite_id, { party_id, terms_version: terms.version, reaproveitado }, ctx.ip);
  return { invite_id, link, destino_mascarado: mascararTelefone(telefone), expires_at: new Date(agora.getTime() + INVITE_TTL_MS).toISOString(), reaproveitado };
}

/** Conclusão (os nove passos, no banco) + certificado. Para loja, portal PF e conclusão automática. */
export async function concluir(admin: SupabaseClient, actor_user_id: string | null, t: TxRow) {
  const terms = await termosVigentes(admin, t);
  if (!terms) throw new DomainError("sem_termos", "Confirme as condições antes de concluir.", 409);
  const st = await statusAceite(admin, t);
  if (!st.complete) throw new DomainError("aceite_incompleto", descreverFaltantes(st), 409);
  const { data, error } = await admin.rpc("registry_complete_transaction", { p_transaction_id: t.id, p_actor_user_id: actor_user_id, p_grade: st.grade, p_terms_hash: terms.content_hash });
  if (error) throw traduzirErroBanco(error);
  const r = data as { protocolo: string; grade: string; completed_at: string; repetida: boolean };
  if (!r.repetida) {
    const conteudo = await montarCertificado(admin, t.id);
    await admin.from("registry_certificates").insert({ transaction_id: t.id, protocol: r.protocolo, content_hash: await hashTerms(conteudo) });
  }
  return r;
}

// ───────── Manutenção: expiração de paradas e lembrete de garantia ─────────

/** Expira UMA transação se estiver parada além do prazo. Usa o motor de estados e revoga convites vivos. */
export async function expirarSeParada(admin: SupabaseClient, t: TxRow, agora = new Date()): Promise<boolean> {
  if (!deveExpirar(t.state, t.updated_at, agora)) return false;
  await mudarEstado(admin, t, "expired");
  await admin.from("registry_acceptance_invites").update({ revoked_at: agora.toISOString(), revoked_reason: "expirado" }).eq("transaction_id", t.id).is("consumed_at", null).is("revoked_at", null);
  await auditar(admin, t.store_id, null, "tx.expired", "transaction", t.id, { parada_desde: t.updated_at });
  return true;
}

/** Varre as transações abertas e expira as paradas. Devolve quantas expirou. */
export async function expirarPendentes(admin: SupabaseClient, agora = new Date()): Promise<number> {
  const limite = new Date(agora.getTime() - 7 * 86_400_000).toISOString();
  const { data, error } = await admin.from("registry_transactions").select("*").lt("updated_at", limite)
    .in("state", ["draft", "awaiting_data", "awaiting_checks", "awaiting_seller", "awaiting_buyer", "ready_to_complete", "under_review"]).limit(500);
  lancarSeErro(error);
  let n = 0;
  for (const t of (data ?? []) as TxRow[]) if (await expirarSeParada(admin, t, agora)) n++;
  return n;
}

/**
 * Avisa o COMPRADOR (pelo WhatsApp dele) quando a garantia está para acabar.
 * Uma vez só por transação. Se o WhatsApp falhar, não marca como enviado: tenta
 * de novo na próxima rodada.
 */
export async function lembrarGarantias(admin: SupabaseClient, agora = new Date()): Promise<{ avisados: number; falhas: number }> {
  const desde = new Date(agora.getTime() - 400 * 86_400_000).toISOString();
  const { data, error } = await admin.from("registry_transactions").select("*").eq("state", "completed").gte("completed_at", desde).limit(1000);
  lancarSeErro(error);
  let avisados = 0, falhas = 0;
  for (const t of (data ?? []) as TxRow[]) {
    const terms = await termosVigentes(admin, t);
    const g = terms ? garantiaDe(t.completed_at, terms.payload.garantia, agora) : null;
    if (!g || g.situacao !== "vence_em_breve") continue;
    const { data: ja } = await admin.from("registry_reminders").select("id").eq("transaction_id", t.id).eq("kind", "warranty_expiring").maybeSingle();
    if (ja) continue;
    const { data: partes } = await admin.from("registry_transaction_parties").select("party_id").eq("transaction_id", t.id).eq("role", "buyer").limit(1).maybeSingle();
    if (!partes) continue;
    const tel = await telefoneDaParte(admin, partes.party_id as string);
    if (!tel) continue;
    const dv = await deviceView(admin, await deviceIdDaTx(admin, t.id));
    const nome = [dv?.brand, dv?.model].filter(Boolean).join(" ") || "seu aparelho";
    const quando = new Date(g.ate).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
    try {
      await enviarWhatsapp(tel, `Cartório do Celular: a garantia do ${nome} (${g.texto}) termina em ${quando}, daqui a ${Math.max(g.dias_restantes, 0)} dia(s). Se algo não está bem, procure a loja antes dessa data. Protocolo ${t.public_protocol}.`);
      await admin.from("registry_reminders").insert({ transaction_id: t.id, party_id: partes.party_id, kind: "warranty_expiring" });
      await auditar(admin, t.store_id, null, "reminder.warranty_sent", "transaction", t.id, { dias_restantes: g.dias_restantes });
      avisados++;
    } catch { falhas++; }
  }
  return { avisados, falhas };
}
