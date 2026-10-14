// Operações do lote PJ→PJ no servidor. Reaproveita as mesmas peças da venda
// unitária (criarTransacao, congelarTermos, executarConsulta, concluir): o lote
// não tem regra de negócio paralela, só junta o aceite.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  DomainError, INVITE_TTL_MS, ORIGEM_LOTE, formatarCentavos, gerarToken, impressaoDigitalLote, itemPodeEntrarNoConvite, mascararTelefone, sha256Hex, validarItensLote,
  type ItemLoteEntrada,
} from "./core/index.ts";
import { auditar, env, lancarSeErro } from "./server.ts";
import { checkDaTx, deviceIdDaTx, deviceView, obterTx, partesDaTx, partyView, statusAceite, telefoneDaParte, termosVigentes, type TxRow } from "./views.ts";
import { enviarWhatsapp } from "./whatsapp.ts";
import { avancarAposAceite, concluir, congelarTermos, criarOuVincularPessoa, criarTransacao, executarConsulta, type OpCtx } from "./ops.ts";

export interface EntradaLote {
  comprador: { documento: string; nome: string; telefone: string };
  itens: ItemLoteEntrada[];
  forma_pagamento: string;
  garantia?: string;
  estado_aparelho?: string;
  idempotency_key: string;
}

async function loteDaLoja(admin: SupabaseClient, store_id: string, batch_id: string) {
  const { data } = await admin.from("registry_batches").select("id, buyer_party_id, created_at, store_id").eq("id", batch_id).eq("store_id", store_id).maybeSingle();
  if (!data) throw new DomainError("lote_inexistente", "Lote não encontrado.", 404);
  return data as { id: string; buyer_party_id: string; created_at: string; store_id: string };
}

export async function criarLote(admin: SupabaseClient, ctx: OpCtx, d: EntradaLote): Promise<string> {
  validarItensLote(d.itens);
  if (!ctx.store.party_id) throw new DomainError("loja_sem_party", "A loja ainda não tem cadastro de pessoa jurídica no Cartório.", 409);
  if (!d.forma_pagamento) throw new DomainError("forma_pagamento", "Informe a forma de pagamento.");
  // Idempotência do lote inteiro.
  const { data: idem } = await admin.from("registry_idempotency_keys").select("response").eq("scope", "lote.create").eq("key", d.idempotency_key).eq("store_id", ctx.store.id).maybeSingle();
  if (idem) return (idem.response as { id: string }).id;

  // Tudo que pode falhar por regra falha ANTES de criar qualquer coisa.
  for (const i of d.itens) {
    const { data: titular } = await admin.from("registry_ownership_periods").select("party_id").eq("device_id", i.device_id).is("ended_at", null).maybeSingle();
    if (!titular || titular.party_id !== ctx.store.party_id) {
      const dv = await deviceView(admin, i.device_id);
      throw new DomainError("nao_titular", `A loja não é a titular de ${[dv?.brand, dv?.model].filter(Boolean).join(" ") || "um dos aparelhos"} (IMEI ${dv?.imei_mascarado ?? "?"}). Não se vende o que não se tem.`, 403);
    }
  }
  const comprador = await criarOuVincularPessoa(admin, ctx, { documento: d.comprador.documento, tipo: "pj", nome: d.comprador.nome, telefone: d.comprador.telefone });
  if (comprador.party_id === ctx.store.party_id) throw new DomainError("mesma_loja", "A loja compradora não pode ser a própria loja vendedora.");

  const { data: lote, error } = await admin.from("registry_batches").insert({ store_id: ctx.store.id, buyer_party_id: comprador.party_id, created_by: ctx.user.id }).select("id").single();
  lancarSeErro(error);
  const batch_id = lote!.id as string;

  for (const i of d.itens) {
    const t = await criarTransacao(admin, ctx, { kind: "pj_pj", device_id: i.device_id, seller_party_id: ctx.store.party_id, buyer_party_id: comprador.party_id, idempotency_key: `${d.idempotency_key}:${i.device_id}` });
    await congelarTermos(admin, ctx, t, {
      valor_centavos: i.valor_centavos, forma_pagamento: d.forma_pagamento, estado_aparelho: d.estado_aparelho ?? "", defeitos: "", garantia: d.garantia ?? "",
      declaracoes: { origem: ORIGEM_LOTE, lote_id: batch_id },
    });
    const { error: eItem } = await admin.from("registry_batch_items").insert({ batch_id, transaction_id: t.id });
    lancarSeErro(eItem);
    try { await executarConsulta(admin, ctx, await obterTx(admin, t.id)); } catch (e) { if (!(e instanceof DomainError)) throw e; /* sem IMEI: fica aguardando dados */ }
  }
  await admin.from("registry_idempotency_keys").insert({ scope: "lote.create", key: d.idempotency_key, store_id: ctx.store.id, request_hash: await sha256Hex(JSON.stringify(d.itens)), response: { id: batch_id } });
  await auditar(admin, ctx.store.id, ctx.user.id, "batch.created", "batch", batch_id, { itens: d.itens.length }, ctx.ip);
  return batch_id;
}

export async function viewLote(admin: SupabaseClient, store_id: string, batch_id: string) {
  const lote = await loteDaLoja(admin, store_id, batch_id);
  const { data: its } = await admin.from("registry_batch_items").select("transaction_id").eq("batch_id", batch_id);
  const { data: inv } = await admin.from("registry_batch_invites").select("id, transaction_ids, destination_masked, expires_at, consumed_at, revoked_at, created_at").eq("batch_id", batch_id).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const itens = [];
  let total = 0;
  for (const r of its ?? []) {
    const t = await obterTx(admin, r.transaction_id as string);
    const terms = await termosVigentes(admin, t);
    const st = await statusAceite(admin, t);
    const ck = await checkDaTx(admin, t.id);
    const dv = await deviceView(admin, await deviceIdDaTx(admin, t.id));
    const valor = terms?.payload.valor_centavos ?? 0;
    total += valor;
    itens.push({
      transaction_id: t.id, protocolo: t.public_protocol, device: dv!, valor_centavos: valor, state: t.state,
      loja_aceitou: st.accepted.some((p) => p.role === "seller"), comprador_aceitou: st.accepted.some((p) => p.role === "buyer"),
      consulta: ck ? ck.result : null,
      no_convite: !!inv && (inv.transaction_ids as string[]).includes(t.id),
    });
  }
  const convite = inv ? {
    destino_mascarado: inv.destination_masked as string, expires_at: inv.expires_at as string, enviado_em: inv.created_at as string,
    aceito: !!inv.consumed_at, valido: !inv.consumed_at && !inv.revoked_at && new Date(inv.expires_at as string) > new Date(),
  } : null;
  return {
    id: lote.id, criado_em: lote.created_at, comprador: await partyView(admin, lote.buyer_party_id), itens, total_centavos: total, convite,
    pode_enviar: itens.some((i) => itemPodeEntrarNoConvite(i.state) && !i.comprador_aceitou) && !(convite?.aceito),
    pode_concluir: itens.some((i) => i.state === "ready_to_complete"),
    concluidos: itens.filter((i) => i.state === "completed").length,
  };
}

export async function listarLotes(admin: SupabaseClient, store_id: string) {
  const { data } = await admin.from("registry_batches").select("id, created_at, buyer_party_id").eq("store_id", store_id).order("created_at", { ascending: false }).limit(100);
  const out = [];
  for (const b of data ?? []) {
    const { data: its } = await admin.from("registry_batch_items").select("transaction_id").eq("batch_id", b.id);
    let concluidos = 0, total = 0;
    for (const r of its ?? []) {
      const t = await obterTx(admin, r.transaction_id as string);
      if (t.state === "completed") concluidos++;
      total += (await termosVigentes(admin, t))?.payload.valor_centavos ?? 0;
    }
    out.push({ id: b.id as string, criado_em: b.created_at as string, comprador: (await partyView(admin, b.buyer_party_id as string)).display_name, itens: (its ?? []).length, concluidos, total_centavos: total });
  }
  return out;
}

/** A loja aceita os itens liberados na consulta e envia UM link ao responsável da loja compradora. */
export async function enviarLote(admin: SupabaseClient, ctx: OpCtx, batch_id: string) {
  const lote = await loteDaLoja(admin, ctx.store.id, batch_id);
  const { data: its } = await admin.from("registry_batch_items").select("transaction_id").eq("batch_id", batch_id);
  const elegiveis: TxRow[] = [];
  for (const r of its ?? []) {
    const t = await obterTx(admin, r.transaction_id as string);
    if (!itemPodeEntrarNoConvite(t.state)) continue;
    const terms = await termosVigentes(admin, t);
    if (!terms) continue;
    // aceite da loja (operador logado) — uma vez por versão
    const partes = await partesDaTx(admin, t.id);
    const loja = partes.find((p) => p.is_tenant_side && p.role === "seller");
    if (loja) {
      const { error } = await admin.from("registry_transaction_acceptances").insert({
        transaction_id: t.id, party_id: loja.party_id, terms_version: terms.version, terms_hash: terms.content_hash, channel: "operator_pj", ip: ctx.ip, user_agent: null,
        evidence: { operator_user_id: ctx.user.id, batch_id },
      });
      if (error && !/registry_acceptances_unique/.test(error.message ?? "")) lancarSeErro(error);
      await avancarAposAceite(admin, t);
    }
    elegiveis.push(await obterTx(admin, t.id));
  }
  if (elegiveis.length === 0) throw new DomainError("lote_sem_liberados", "Nenhum aparelho do lote foi liberado na consulta de procedência. Veja o motivo de cada item.", 409);

  const telefone = await telefoneDaParte(admin, lote.buyer_party_id);
  if (!telefone) throw new DomainError("sem_telefone", "A loja compradora não tem telefone de responsável — e o código só chega por ele.", 409);
  const fp = await impressaoDigitalLote(await Promise.all(elegiveis.map(async (t) => ({ transaction_id: t.id, terms_hash: (await termosVigentes(admin, t))!.content_hash }))));
  const agora = new Date();
  await admin.from("registry_batch_invites").update({ revoked_at: agora.toISOString(), revoked_reason: "novo_envio" }).eq("batch_id", batch_id).is("consumed_at", null).is("revoked_at", null);
  const token = gerarToken();
  const { data: inv, error } = await admin.from("registry_batch_invites").insert({
    batch_id, party_id: lote.buyer_party_id, token_hash: await sha256Hex(token), fingerprint: fp, transaction_ids: elegiveis.map((t) => t.id),
    destination_masked: mascararTelefone(telefone), expires_at: new Date(agora.getTime() + INVITE_TTL_MS).toISOString(), created_by: ctx.user.id,
  }).select("id").single();
  lancarSeErro(error);
  const link = `${env("PUBLIC_APP_URL").replace(/\/$/, "")}/aceite-lote/${token}`;
  await enviarWhatsapp(telefone, `Cartório do Celular — ${ctx.store.name} registrou a passagem de ${elegiveis.length} aparelho(s) para a sua loja. Para confirmar o lote, abra o link e informe o código que vai chegar aqui: ${link}`);
  await auditar(admin, ctx.store.id, ctx.user.id, "batch.invite_sent", "batch", batch_id, { invite_id: inv!.id, itens: elegiveis.length }, ctx.ip);
  return { link, destino_mascarado: mascararTelefone(telefone), itens_no_convite: elegiveis.length };
}

/** Conclui cada item pronto, um a um. Um item que falha não derruba os outros. */
export async function concluirLote(admin: SupabaseClient, ctx: OpCtx, batch_id: string) {
  await loteDaLoja(admin, ctx.store.id, batch_id);
  const { data: its } = await admin.from("registry_batch_items").select("transaction_id").eq("batch_id", batch_id);
  const resultados: Array<{ transaction_id: string; protocolo: string; ok: boolean; erro?: string }> = [];
  for (const r of its ?? []) {
    const t = await obterTx(admin, r.transaction_id as string);
    if (t.state === "completed") { resultados.push({ transaction_id: t.id, protocolo: t.public_protocol, ok: true }); continue; }
    if (t.state !== "ready_to_complete") { resultados.push({ transaction_id: t.id, protocolo: t.public_protocol, ok: false, erro: "Ainda não está pronto: falta o aceite ou a liberação na consulta." }); continue; }
    try { await concluir(admin, ctx.user.id, t); resultados.push({ transaction_id: t.id, protocolo: t.public_protocol, ok: true }); }
    catch (e) { resultados.push({ transaction_id: t.id, protocolo: t.public_protocol, ok: false, erro: e instanceof DomainError ? e.message : "Não foi possível concluir este item." }); }
  }
  await auditar(admin, ctx.store.id, ctx.user.id, "batch.completed", "batch", batch_id, { ok: resultados.filter((r) => r.ok).length, falhas: resultados.filter((r) => !r.ok).length }, ctx.ip);
  return resultados;
}

export { formatarCentavos };
