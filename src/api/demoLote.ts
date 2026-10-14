// Demonstração — venda em lote entre lojas (PJ→PJ). Mesmas regras do servidor
// (supabase/functions/_shared/lote.ts): uma transação por aparelho, um aceite para o
// conjunto, impressão digital que derruba o link se qualquer item mudar.
// Compõe as operações da demonstração (identidade, transação, termos, consulta, aceite
// da loja, conclusão) — não tem regra de negócio própria.

import {
  DomainError, INVITE_TTL_MS, ORIGEM_LOTE, OTP_MAX_ATTEMPTS, OTP_TTL_MS, formatarCentavos, gerarOtp, gerarToken, iguaisTempoConstante, impressaoDigitalLote,
  itemPodeEntrarNoConvite, mascararTelefone, onlyDigits, primeiroNome, sha256Hex, validarItensLote,
} from "@core/index.ts";
import type { LoteItemView, LoteResumo, LoteView, RegistryApi, ResumoAceiteLote } from "./types.ts";
import { demoApi, demoInternals as I } from "./demo.ts";

type Db = ReturnType<typeof I.db>;
type Batch = Db["batches"][number];

function loteDaLoja(batch_id: string, store_id: string): Batch {
  const b = I.db().batches.find((x) => x.id === batch_id && x.store_id === store_id);
  if (!b) throw new DomainError("lote_inexistente", "Lote não encontrado.", 404);
  return b;
}

function viewLote(b: Batch): LoteView {
  const db = I.db();
  const inv = db.batch_invites.filter((i) => i.batch_id === b.id).sort((a, c) => c.created_at.localeCompare(a.created_at))[0] ?? null;
  const itens: LoteItemView[] = db.batch_items.filter((x) => x.batch_id === b.id).map((r) => {
    const t = db.transactions.find((x) => x.id === r.transaction_id)!;
    const terms = I.termosVigentes(t.id);
    const st = I.statusAceite(t.id);
    const ck = I.checkVigente(t.id);
    const dev = db.transaction_devices.find((d) => d.transaction_id === t.id)!;
    return {
      transaction_id: t.id, protocolo: t.public_protocol, device: I.deviceView(dev.device_id)!, valor_centavos: terms?.payload.valor_centavos ?? 0, state: t.state,
      loja_aceitou: st.accepted.some((p) => p.role === "seller"), comprador_aceitou: st.accepted.some((p) => p.role === "buyer"),
      consulta: ck ? ck.result : null, no_convite: !!inv && inv.transaction_ids.includes(t.id),
    };
  });
  return {
    id: b.id, criado_em: b.created_at, comprador: I.partyView(b.buyer_party_id), itens, total_centavos: itens.reduce((n, i) => n + i.valor_centavos, 0),
    convite: inv ? { destino_mascarado: inv.destination_masked, expires_at: inv.expires_at, enviado_em: inv.created_at, aceito: !!inv.consumed_at, valido: !inv.consumed_at && !inv.revoked_at && new Date(inv.expires_at).getTime() > Date.now() } : null,
    pode_enviar: itens.some((i) => itemPodeEntrarNoConvite(i.state) && !i.comprador_aceitou) && !inv?.consumed_at,
    pode_concluir: itens.some((i) => i.state === "ready_to_complete"),
    concluidos: itens.filter((i) => i.state === "completed").length,
  };
}

async function inviteDoToken(token: string) {
  if (!token) return null;
  const h = await sha256Hex(token);
  return I.db().batch_invites.find((i) => i.token_hash === h) ?? null;
}

async function itensDoConvite(inv: Db["batch_invites"][number]) {
  const db = I.db();
  const txs = inv.transaction_ids.map((id) => ({ t: db.transactions.find((x) => x.id === id)!, terms: I.termosVigentes(id) }));
  const intacto = txs.every((x) => x.terms && itemPodeEntrarNoConvite(x.t.state));
  const fp = intacto ? await impressaoDigitalLote(txs.map((x) => ({ transaction_id: x.t.id, terms_hash: x.terms!.content_hash }))) : "";
  return { txs, intacto, fp };
}

const INVALIDO = "Este link não é válido ou já foi usado. Peça um novo para a loja vendedora.";
const MUDOU = "O lote mudou depois que este link foi enviado. Peça um novo para a loja vendedora.";

export const demoLoteApi: Pick<RegistryApi, "lote" | "aceiteLotePublico"> = {
  lote: {
    async criar(d) {
      await I.delay(200);
      const s = I.exigirSessao();
      validarItensLote(d.itens);
      const db = I.db();
      const loja = db.stores.find((x) => x.id === s.store.id)!;
      if (!d.forma_pagamento) throw new DomainError("forma_pagamento", "Informe a forma de pagamento.");
      // Mesma chave → mesmo lote (idempotência do lote inteiro).
      const antigo = db.idempotency_keys.find((k) => k.scope === "lote.create" && k.key === d.idempotency_key && k.store_id === s.store.id);
      if (antigo) return viewLote(db.batches.find((b) => b.id === (antigo.response as { id: string }).id)!);
      // Tudo que pode falhar por regra falha ANTES de criar qualquer coisa.
      for (const i of d.itens) {
        const titular = db.ownership_periods.find((o) => o.device_id === i.device_id && !o.ended_at);
        if (!titular || titular.party_id !== loja.party_id) {
          const dv = I.deviceView(i.device_id);
          throw new DomainError("nao_titular", `A loja não é a titular de ${[dv?.brand, dv?.model].filter(Boolean).join(" ") || "um dos aparelhos"} (IMEI ${dv?.imei_mascarado ?? "?"}). Não se vende o que não se tem.`, 403);
        }
      }
      const comprador = await demoApi.identidade.criar({ documento: d.comprador.documento, tipo: "pj", nome: d.comprador.nome, telefone: d.comprador.telefone });
      if (comprador.party_id === loja.party_id) throw new DomainError("mesma_loja", "A loja compradora não pode ser a própria loja vendedora.");
      const b: Batch = { ...I.row(), store_id: s.store.id, buyer_party_id: comprador.party_id, created_by: s.user_id };
      db.batches.push(b);
      for (const i of d.itens) {
        const tx = await demoApi.transacao.criar({ kind: "pj_pj", device_id: i.device_id, seller_party_id: loja.party_id, buyer_party_id: comprador.party_id, idempotency_key: `${d.idempotency_key}:${i.device_id}` });
        await demoApi.transacao.congelarTermos(tx.id, {
          valor_centavos: i.valor_centavos, forma_pagamento: d.forma_pagamento, estado_aparelho: d.estado_aparelho ?? "", defeitos: "", garantia: d.garantia ?? "",
          declaracoes: { origem: ORIGEM_LOTE, lote_id: b.id },
        });
        db.batch_items.push({ ...I.row(), batch_id: b.id, transaction_id: tx.id });
        try { await demoApi.consulta.executar(tx.id); } catch (e) { if (!(e instanceof DomainError)) throw e; }
      }
      db.idempotency_keys.push({ ...I.row(), scope: "lote.create", key: d.idempotency_key, store_id: s.store.id, request_hash: "", response: { id: b.id } } as never);
      I.auditar(s.store.id, s.user_id, "batch.created", "batch", b.id, { itens: d.itens.length });
      I.salvar();
      return viewLote(b);
    },

    async listar(): Promise<LoteResumo[]> {
      await I.delay(40);
      const s = I.exigirSessao();
      return I.db().batches.filter((b) => b.store_id === s.store.id).sort((a, c) => c.created_at.localeCompare(a.created_at)).map((b) => {
        const v = viewLote(b);
        return { id: b.id, criado_em: b.created_at, comprador: v.comprador.display_name, itens: v.itens.length, concluidos: v.concluidos, total_centavos: v.total_centavos };
      });
    },

    async obter(id) { await I.delay(40); const s = I.exigirSessao(); return viewLote(loteDaLoja(id, s.store.id)); },

    async enviar(id) {
      await I.delay(300);
      const s = I.exigirSessao();
      const b = loteDaLoja(id, s.store.id);
      const db = I.db();
      const loja = db.stores.find((x) => x.id === s.store.id)!;
      const elegiveis: Array<typeof db.transactions[number]> = [];
      for (const r of db.batch_items.filter((x) => x.batch_id === b.id)) {
        const t = db.transactions.find((x) => x.id === r.transaction_id)!;
        if (!itemPodeEntrarNoConvite(t.state)) continue;
        if (!I.termosVigentes(t.id)) continue;
        const lojaParte = db.transaction_parties.find((p) => p.transaction_id === t.id && p.is_tenant_side && p.role === "seller");
        if (lojaParte) await demoApi.aceiteLoja.registrar(t.id, lojaParte.party_id);
        elegiveis.push(t);
      }
      if (elegiveis.length === 0) throw new DomainError("lote_sem_liberados", "Nenhum aparelho do lote foi liberado na consulta de procedência. Veja o motivo de cada item.", 409);
      const phone = db.party_contacts.find((c) => c.party_id === b.buyer_party_id && c.kind === "phone")?.value;
      if (!phone) throw new DomainError("sem_telefone", "A loja compradora não tem telefone de responsável — e o código só chega por ele.", 409);
      const fp = await impressaoDigitalLote(elegiveis.map((t) => ({ transaction_id: t.id, terms_hash: I.termosVigentes(t.id)!.content_hash })));
      for (const v of db.batch_invites) if (v.batch_id === b.id && !v.consumed_at && !v.revoked_at) { v.revoked_at = I.agora(); v.revoked_reason = "novo_envio"; }
      const token = gerarToken();
      db.batch_invites.push({
        ...I.row(), batch_id: b.id, party_id: b.buyer_party_id, token_hash: await sha256Hex(token), fingerprint: fp, transaction_ids: elegiveis.map((t) => t.id),
        destination_phone: phone, destination_masked: mascararTelefone(phone), otp_hash: null, otp_expires_at: null, otp_attempts: 0, otp_sent_count: 0,
        expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(), consumed_at: null, revoked_at: null, revoked_reason: null,
      });
      const base = `${location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}`;
      const link = `${base}/aceite-lote/${token}`;
      I.enviarWhatsapp(phone, `Cartório do Celular — ${loja.name} registrou a passagem de ${elegiveis.length} aparelho(s) para a sua loja. Para confirmar o lote, abra o link e informe o código que vai chegar aqui: ${link}`);
      I.auditar(s.store.id, s.user_id, "batch.invite_sent", "batch", b.id, { itens: elegiveis.length });
      I.salvar();
      return { link, destino_mascarado: mascararTelefone(phone), itens_no_convite: elegiveis.length, lote: viewLote(b) };
    },

    async concluir(id) {
      await I.delay(300);
      const s = I.exigirSessao();
      const b = loteDaLoja(id, s.store.id);
      const db = I.db();
      const resultados: Array<{ transaction_id: string; protocolo: string; ok: boolean; erro?: string }> = [];
      for (const r of db.batch_items.filter((x) => x.batch_id === b.id)) {
        const t = db.transactions.find((x) => x.id === r.transaction_id)!;
        if (t.state === "completed") { resultados.push({ transaction_id: t.id, protocolo: t.public_protocol, ok: true }); continue; }
        if (t.state !== "ready_to_complete") { resultados.push({ transaction_id: t.id, protocolo: t.public_protocol, ok: false, erro: "Ainda não está pronto: falta o aceite ou a liberação na consulta." }); continue; }
        try { await demoApi.concluir(t.id, `lote:${b.id}:${t.id}`); resultados.push({ transaction_id: t.id, protocolo: t.public_protocol, ok: true }); }
        catch (e) { resultados.push({ transaction_id: t.id, protocolo: t.public_protocol, ok: false, erro: e instanceof DomainError ? e.message : "Não foi possível concluir este item." }); }
      }
      I.auditar(s.store.id, s.user_id, "batch.completed", "batch", b.id, { ok: resultados.filter((r) => r.ok).length });
      I.salvar();
      return { resultados, lote: viewLote(b) };
    },
  },

  aceiteLotePublico: {
    async resumo(token): Promise<ResumoAceiteLote> {
      await I.delay(80);
      const inv = await inviteDoToken(token);
      if (!inv) return { valido: false, motivo: INVALIDO };
      if (inv.revoked_at) return { valido: false, motivo: "Este link foi cancelado. Peça um novo para a loja vendedora." };
      if (new Date(inv.expires_at).getTime() < Date.now()) return { valido: false, motivo: "Este link venceu. Peça um novo para a loja vendedora." };
      const { txs, intacto, fp } = await itensDoConvite(inv);
      if (!inv.consumed_at && (!intacto || fp !== inv.fingerprint)) return { valido: false, motivo: MUDOU };
      const db = I.db();
      const lote = db.batches.find((b) => b.id === inv.batch_id)!;
      const loja = db.stores.find((x) => x.id === lote.store_id)!;
      const party = db.parties.find((p) => p.id === inv.party_id)!;
      const itens = txs.map(({ t, terms }) => {
        const dev = db.transaction_devices.find((d) => d.transaction_id === t.id)!;
        const dv = I.deviceView(dev.device_id)!;
        return { aparelho: [dv.brand, dv.model, dv.storage, dv.color].filter(Boolean).join(" "), imei_mascarado: dv.imei_mascarado, valor: formatarCentavos(terms!.payload.valor_centavos) };
      });
      const p = txs[0].terms!.payload;
      return {
        valido: true, aceito: !!inv.consumed_at, primeiro_nome: primeiroNome(party.display_name), loja: loja.name, itens,
        total: formatarCentavos(txs.reduce((n, x) => n + x.terms!.payload.valor_centavos, 0)),
        forma_pagamento: p.forma_pagamento, garantia: p.garantia || "sem garantia declarada", estado_aparelho: p.estado_aparelho || "não informado",
        impressao: inv.fingerprint.slice(0, 12), tentativas_restantes: Math.max(0, OTP_MAX_ATTEMPTS - inv.otp_attempts),
      };
    },
    async pedirCodigo(token) {
      await I.delay(300);
      const inv = await inviteDoToken(token);
      if (!inv || inv.revoked_at || inv.consumed_at) throw new DomainError("convite", INVALIDO, 404);
      const codigo = gerarOtp();
      inv.otp_hash = await I.hashOtpDemo("lote:" + inv.id, codigo);
      inv.otp_expires_at = new Date(Date.now() + OTP_TTL_MS).toISOString();
      inv.otp_attempts = 0;
      inv.otp_sent_count += 1;
      I.enviarWhatsapp(inv.destination_phone, `Seu código do Cartório do Celular: ${codigo}. Vale por 10 minutos. Não compartilhe com ninguém — nem com a loja vendedora.`);
      I.salvar();
      return { enviado: true, destino_mascarado: inv.destination_masked };
    },
    async confirmar(token, codigo) {
      await I.delay(200);
      const inv = await inviteDoToken(token);
      if (!inv || inv.revoked_at) throw new DomainError("convite", INVALIDO, 404);
      if (inv.consumed_at) return { aceito: true };
      const { txs, intacto, fp } = await itensDoConvite(inv);
      if (!intacto || fp !== inv.fingerprint) throw new DomainError("lote_mudou", MUDOU, 409);
      if (!inv.otp_hash || !inv.otp_expires_at) throw new DomainError("sem_codigo", "Peça o código primeiro.");
      if (new Date(inv.otp_expires_at).getTime() < Date.now()) throw new DomainError("codigo_vencido", "O código venceu. Peça outro.");
      if (inv.otp_attempts >= OTP_MAX_ATTEMPTS) { inv.revoked_at = I.agora(); inv.revoked_reason = "tentativas"; I.salvar(); throw new DomainError("tentativas", "Muitas tentativas. Este link foi cancelado — peça um novo para a loja vendedora.", 429); }
      const h = await I.hashOtpDemo("lote:" + inv.id, onlyDigits(codigo));
      if (!iguaisTempoConstante(h, inv.otp_hash)) {
        inv.otp_attempts += 1;
        const rest = OTP_MAX_ATTEMPTS - inv.otp_attempts;
        if (rest <= 0) { inv.revoked_at = I.agora(); inv.revoked_reason = "tentativas"; I.salvar(); throw new DomainError("tentativas", "Muitas tentativas. Este link foi cancelado — peça um novo para a loja vendedora.", 429); }
        I.salvar();
        throw new DomainError("codigo_errado", `Código não confere. ${rest === 1 ? "Última tentativa." : `Você ainda tem ${rest} tentativas.`}`);
      }
      for (const { t, terms } of txs) {
        I.registrarAceite(t.id, inv.party_id, terms!.version, terms!.content_hash, "otp_whatsapp", { batch_invite_id: inv.id, destino: inv.destination_masked, impressao: inv.fingerprint });
        I.avancarAposAceite(t);
      }
      inv.consumed_at = I.agora();
      I.salvar();
      return { aceito: true };
    },
  },
};
