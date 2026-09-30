// Demonstração — Portal da pessoa física ("Meus aparelhos"), adaptado da
// Carteira Digital de Trânsito: venda entre pessoas (comprador aceita primeiro,
// vendedor confirma por último), comunicação de venda (declaração unilateral)
// e registro de ocorrência (furto/roubo/perda com B.O.). Sessão própria da PF:
// CPF + código no WhatsApp JÁ CADASTRADO para aquele CPF.

import {
  DomainError, OTP_MAX_ATTEMPTS, OTP_TTL_MS, UNIQUE_MEDIA_SLOTS, cpfValido, gerarOtp, gerarProtocolo, gerarToken, hashTerms, iguaisTempoConstante,
  mascararTelefone, nomeCurto, onlyDigits, primeiroNome, sha256Hex,
} from "@core/index.ts";
import type { ConviteCriado, MeuAparelho, PfSession, RegistryApi, TransacaoView } from "./types.ts";
import { demoInternals as I } from "./demo.ts";

type DB = ReturnType<typeof I.db>;

const PF_KEY = "cdc-demo-pf-token";
const PF_OTP_PENDING = "cdc-demo-pf-otp";
const SESSAO_DIAS = 30;

function tokenAtual(): string | null { try { return localStorage.getItem(PF_KEY); } catch { return null; } }

async function sessaoPf(): Promise<PfSession | null> {
  const tok = tokenAtual();
  if (!tok) return null;
  const h = await sha256Hex(tok);
  const s = I.db().pf_sessions.find((x) => x.token_hash === h && new Date(x.expires_at).getTime() > Date.now());
  if (!s) return null;
  const pv = I.partyView(s.party_id);
  return { party_id: pv.party_id, display_name: pv.display_name, primeiro_nome: primeiroNome(pv.display_name), telefone_mascarado: pv.telefone_mascarado ?? "" };
}
async function exigirPf(): Promise<PfSession> {
  const s = await sessaoPf();
  if (!s) throw new DomainError("sem_sessao_pf", "Entre com seu CPF para continuar.", 401);
  return s;
}
function exigirTitular(party_id: string, device_id: string) {
  const o = I.db().ownership_periods.find((x) => x.device_id === device_id && !x.ended_at);
  if (!o || o.party_id !== party_id) throw new DomainError("nao_titular", "Você não é o titular registrado deste aparelho.", 403);
  return o;
}
function txDaPf(transaction_id: string, party_id: string) {
  const db = I.db();
  const t = db.transactions.find((x) => x.id === transaction_id);
  if (!t || !db.transaction_parties.some((p) => p.transaction_id === t.id && p.party_id === party_id)) throw new DomainError("tx_inexistente", "Transação não encontrada.", 404);
  return t;
}
/** Pessoa canônica sem vínculo de loja (comprador informado pelo vendedor). */
async function pessoaPorCpf(cpf: string, nome: string | null, telefone: string | null): Promise<string> {
  const db = I.db();
  const d = onlyDigits(cpf);
  if (!cpfValido(d)) throw new DomainError("cpf", "Esse CPF não confere. Confira os dígitos.");
  const h = await I.hashDocDemo(d);
  let ident = db.party_identifiers.find((i) => i.value_hash === h);
  let party_id: string;
  if (ident) party_id = ident.party_id;
  else {
    if (!nome?.trim()) throw new DomainError("nome", "Informe o nome de quem está comprando.");
    const p = { ...I.row(), kind: "pf" as const, display_name: nome.trim() };
    db.parties.push(p);
    ident = { ...I.row(), party_id: p.id, type: "cpf", value_hash: h, value_encrypted: await I.cifrarDemo(d) };
    db.party_identifiers.push(ident);
    party_id = p.id;
  }
  const tel = onlyDigits(telefone ?? "");
  if (tel.length >= 10 && !db.party_contacts.some((c) => c.party_id === party_id && c.kind === "phone" && c.value === tel)) db.party_contacts.push({ ...I.row(), party_id, kind: "phone", value: tel });
  return party_id;
}

export const demoPfApi: Pick<RegistryApi, "pf"> = {
  pf: {
    sessao: sessaoPf,

    async pedirCodigo({ cpf, telefone, nome }) {
      await I.delay(250);
      const db = I.db();
      const d = onlyDigits(cpf);
      const tel = onlyDigits(telefone);
      if (!cpfValido(d)) throw new DomainError("cpf", "Esse CPF não confere. Confira os dígitos.");
      if (tel.length < 10) throw new DomainError("telefone", "Informe o WhatsApp com DDD.");
      const h = await I.hashDocDemo(d);
      const ident = db.party_identifiers.find((i) => i.value_hash === h);
      let destino = tel;
      let novo = false;
      if (ident) {
        // Só o telefone JÁ CADASTRADO para este CPF recebe o código — quem sabe um CPF não entra por ele.
        const fones = db.party_contacts.filter((c) => c.party_id === ident.party_id && c.kind === "phone").map((c) => c.value);
        if (fones.length && !fones.includes(tel)) throw new DomainError("telefone_divergente", "Este WhatsApp não é o cadastrado para este CPF. Use o número que você deu na loja onde registrou o aparelho.", 403);
        if (!fones.length) throw new DomainError("sem_telefone", "Este CPF não tem WhatsApp cadastrado. Procure a loja onde registrou o aparelho.", 403);
      } else {
        if (!nome?.trim()) throw new DomainError("nome", "Primeiro acesso: informe seu nome completo.");
        novo = true;
      }
      const codigo = gerarOtp();
      const otp = { ...I.row(), cpf_hash: h, phone: destino, nome: nome?.trim() || null, otp_hash: await I.hashOtpDemo("pf:" + h, codigo), expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(), attempts: 0 };
      db.pf_otps = db.pf_otps.filter((o) => o.cpf_hash !== h);
      db.pf_otps.push(otp);
      I.enviarWhatsapp(destino, `Seu código de acesso ao Cartório do Celular: ${codigo}. Vale por 10 minutos. Não compartilhe com ninguém.`);
      try { localStorage.setItem(PF_OTP_PENDING, h); } catch { /* */ }
      I.salvar();
      return { destino_mascarado: mascararTelefone(destino), novo_cadastro: novo };
    },

    async confirmar(codigo) {
      await I.delay(200);
      const db = I.db();
      let h: string | null = null;
      try { h = localStorage.getItem(PF_OTP_PENDING); } catch { /* */ }
      const otp = h ? db.pf_otps.find((o) => o.cpf_hash === h) : null;
      if (!otp) throw new DomainError("sem_codigo", "Peça o código primeiro.");
      if (new Date(otp.expires_at).getTime() < Date.now()) throw new DomainError("codigo_vencido", "O código venceu. Peça outro.");
      if (otp.attempts >= OTP_MAX_ATTEMPTS) throw new DomainError("tentativas", "Muitas tentativas. Peça um código novo.", 429);
      const hh = await I.hashOtpDemo("pf:" + otp.cpf_hash, onlyDigits(codigo));
      if (!iguaisTempoConstante(hh, otp.otp_hash)) { otp.attempts += 1; I.salvar(); throw new DomainError("codigo_errado", `Código não confere. Você ainda tem ${Math.max(0, OTP_MAX_ATTEMPTS - otp.attempts)} tentativas.`); }
      let ident = db.party_identifiers.find((i) => i.value_hash === otp.cpf_hash);
      let party_id: string;
      if (ident) party_id = ident.party_id;
      else {
        const p = { ...I.row(), kind: "pf" as const, display_name: otp.nome ?? "Pessoa" };
        db.parties.push(p);
        // CPF: a demonstração só tem o hash aqui (o texto claro não foi guardado entre as duas chamadas).
        ident = { ...I.row(), party_id: p.id, type: "cpf", value_hash: otp.cpf_hash, value_encrypted: await I.cifrarDemo("cadastro-pf") };
        db.party_identifiers.push(ident);
        db.party_contacts.push({ ...I.row(), party_id: p.id, kind: "phone", value: otp.phone });
        party_id = p.id;
      }
      const token = gerarToken();
      db.pf_sessions.push({ ...I.row(), token_hash: await sha256Hex(token), party_id, expires_at: new Date(Date.now() + SESSAO_DIAS * 86400000).toISOString() });
      db.pf_otps = db.pf_otps.filter((o) => o.id !== otp.id);
      try { localStorage.setItem(PF_KEY, token); localStorage.removeItem(PF_OTP_PENDING); } catch { /* */ }
      I.auditar(null, null, "pf.login", "party", party_id);
      I.salvar();
      return (await sessaoPf())!;
    },

    async sair() { try { localStorage.removeItem(PF_KEY); } catch { /* */ } },

    async meusAparelhos(): Promise<MeuAparelho[]> {
      await I.delay(40);
      const s = await exigirPf();
      const db = I.db();
      const base = `${location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}`;
      return db.ownership_periods.filter((o) => o.party_id === s.party_id && !o.ended_at).sort((a, b) => b.started_at.localeCompare(a.started_at)).map((o) => {
        const tEnt = o.transaction_id ? db.transactions.find((t) => t.id === o.transaction_id) : null;
        const intencao = db.transactions.find((t) => t.kind === "pf_pf" && !["completed", "cancelled", "expired", "disputed"].includes(t.state)
          && db.transaction_devices.some((d) => d.transaction_id === t.id && d.device_id === o.device_id)
          && db.transaction_parties.some((p) => p.transaction_id === t.id && p.party_id === s.party_id && p.role === "seller"));
        let intView: MeuAparelho["intencao"] = null;
        if (intencao) {
          const st = I.statusAceite(intencao.id);
          const buyer = db.transaction_parties.find((p) => p.transaction_id === intencao.id && p.role === "buyer")!;
          const terms = I.termosVigentes(intencao.id);
          intView = { transaction_id: intencao.id, state: intencao.state, comprador: nomeCurto(I.partyView(buyer.party_id).display_name), comprador_aceitou: st.accepted.some((p) => p.role === "buyer"), vendedor_confirmou: st.accepted.some((p) => p.role === "seller"), declarada: terms?.payload.declaracoes?.origem === "comunicacao_de_venda" };
        }
        return { device: I.deviceView(o.device_id)!, desde: o.started_at, protocolo_entrada: tEnt?.public_protocol ?? null, link_certificado: tEnt?.state === "completed" ? `${base}/certificado/${tEnt.public_protocol}` : null, intencao: intView, ocorrencia_ativa: I.ocorrenciaAtiva(o.device_id) };
      });
    },

    async transacao(transaction_id) { const s = await exigirPf(); txDaPf(transaction_id, s.party_id); return I.txView(transaction_id); },

    async iniciarVenda(d) {
      await I.delay(300);
      const s = await exigirPf();
      const db = I.db();
      exigirTitular(s.party_id, d.device_id);
      if (I.ocorrenciaAtiva(d.device_id)) throw new DomainError("ocorrencia_ativa", "Há uma declaração de furto/roubo ativa para este aparelho. Retire a declaração antes de vender.", 409);
      const aberta = (await demoPfApi.pf.meusAparelhos()).find((a) => a.device.device_id === d.device_id)?.intencao;
      if (aberta) throw new DomainError("intencao_aberta", "Já existe uma venda em andamento para este aparelho. Conclua ou cancele antes de abrir outra.", 409);
      if (!(d.valor_centavos > 0)) throw new DomainError("valor", "Informe o valor.");
      const buyer = await pessoaPorCpf(d.comprador.cpf, d.comprador.nome, d.comprador.telefone);
      if (buyer === s.party_id) throw new DomainError("mesma_pessoa", "O comprador não pode ser você mesmo.");
      if (!db.party_contacts.some((c) => c.party_id === buyer && c.kind === "phone")) throw new DomainError("telefone", "Informe o WhatsApp do comprador — é por ele que o aceite chega.");
      const t: DB["transactions"][number] = { ...I.row(), store_id: null, kind: "pf_pf", state: "draft", public_protocol: gerarProtocolo(), current_terms_version: 0, created_by: "", updated_at: I.agora(), completed_at: null };
      db.transactions.push(t);
      db.transaction_parties.push({ ...I.row(), transaction_id: t.id, party_id: s.party_id, role: "seller", is_tenant_side: false });
      db.transaction_parties.push({ ...I.row(), transaction_id: t.id, party_id: buyer, role: "buyer", is_tenant_side: false });
      db.transaction_devices.push({ ...I.row(), transaction_id: t.id, device_id: d.device_id });
      I.mudarEstadoInterno(t, "awaiting_data");
      // Termos congelados a partir do que o vendedor declarou.
      const payload = { valor_centavos: Math.round(d.valor_centavos), forma_pagamento: d.forma_pagamento || "não informada", estado_aparelho: d.estado_aparelho || "não informado", defeitos: d.defeitos || "", garantia: "", declaracoes: { origem: "venda_entre_pessoas" } };
      db.transaction_terms.push({ ...I.row(), transaction_id: t.id, version: 1, payload, content_hash: await hashTerms(payload), frozen_at: I.agora() });
      t.current_terms_version = 1;
      I.executarConsultaInterno(t, { store_id: null, user_id: null });
      I.auditar(null, null, "pf.sale_intent", "transaction", t.id, { seller: s.party_id });
      // Convite para o comprador (ele aceita primeiro; o vendedor confirma por último).
      if (t.state === "awaiting_seller") { I.mudarEstadoInterno(t, "awaiting_buyer"); }
      await I.criarConviteInterno(t, buyer, `${nomeCurto(s.display_name)} quer transferir um aparelho para você pelo Cartório do Celular`, { store_id: null, user_id: null });
      I.salvar();
      return I.txView(t.id);
    },

    async enviarFoto(transaction_id, slot, arquivo) {
      const s = await exigirPf();
      const t = txDaPf(transaction_id, s.party_id);
      if (t.state === "completed") throw new DomainError("tx_encerrada", "Esta venda já foi concluída.", 409);
      const db = I.db();
      const dev = db.transaction_devices.find((d) => d.transaction_id === t.id)!;
      const bytes = new Uint8Array(await arquivo.arrayBuffer());
      const sha256 = await sha256Hex(bytes);
      const data_url = await I.reduzirParaDataUrl(arquivo);
      if (UNIQUE_MEDIA_SLOTS.includes(slot)) db.device_media = db.device_media.filter((m) => !(m.transaction_id === t.id && m.slot === slot));
      const m = { ...I.row(), device_id: dev.device_id, store_id: null, transaction_id: t.id, slot, sha256, data_url };
      db.device_media.push(m);
      I.salvar();
      return { media_id: m.id, slot, sha256, url: data_url };
    },

    async reenviarConvite(transaction_id): Promise<ConviteCriado> {
      const s = await exigirPf();
      const t = txDaPf(transaction_id, s.party_id);
      const buyer = I.db().transaction_parties.find((p) => p.transaction_id === t.id && p.role === "buyer")!;
      const r = await I.criarConviteInterno(t, buyer.party_id, `${nomeCurto(s.display_name)} quer transferir um aparelho para você pelo Cartório do Celular`, { store_id: null, user_id: null });
      I.salvar();
      return r;
    },

    async confirmarVenda(transaction_id) {
      await I.delay(300);
      const s = await exigirPf();
      const t = txDaPf(transaction_id, s.party_id);
      if (t.state === "completed") return { protocolo: t.public_protocol, grade: I.statusAceite(t.id).grade, completed_at: t.completed_at!, repetida: true };
      const st = I.statusAceite(t.id);
      if (!st.accepted.some((p) => p.role === "buyer")) throw new DomainError("comprador_pendente", "O comprador ainda não aceitou no celular dele. Você confirma por último — depois de ver o aceite dele.", 409);
      const terms = I.termosVigentes(t.id)!;
      // O vendedor está autenticado pelo próprio celular (código no WhatsApp cadastrado): canal 'portal'.
      I.registrarAceite(t.id, s.party_id, terms.version, terms.content_hash, "portal", { pf_session: true });
      I.avancarAposAceite(t);
      const r = await I.concluirInterno(t, { store_id: null, user_id: null });
      I.salvar();
      return r;
    },

    async cancelarVenda(transaction_id) {
      const s = await exigirPf();
      const t = txDaPf(transaction_id, s.party_id);
      if (t.state === "completed") throw new DomainError("append_only", "Uma venda concluída não pode ser cancelada. Abra uma contestação.", 409);
      I.mudarEstadoInterno(t, "cancelled");
      for (const inv of I.db().invites) if (inv.transaction_id === t.id && !inv.consumed_at && !inv.revoked_at) { inv.revoked_at = I.agora(); inv.revoked_reason = "cancelada"; }
      I.salvar();
    },

    async comunicarVenda(d) {
      await I.delay(300);
      const s = await exigirPf();
      const db = I.db();
      exigirTitular(s.party_id, d.device_id);
      if (I.ocorrenciaAtiva(d.device_id)) throw new DomainError("ocorrencia_ativa", "Há uma declaração de furto/roubo ativa para este aparelho.", 409);
      const aberta = (await demoPfApi.pf.meusAparelhos()).find((a) => a.device.device_id === d.device_id)?.intencao;
      if (aberta) throw new DomainError("intencao_aberta", "Já existe uma venda em andamento para este aparelho.", 409);
      const dataVenda = d.data_venda && !Number.isNaN(Date.parse(d.data_venda)) ? new Date(d.data_venda).toISOString() : I.agora();
      const buyer = await pessoaPorCpf(d.comprador.cpf, d.comprador.nome || "Comprador informado pelo vendedor", d.comprador.telefone ?? null);
      if (buyer === s.party_id) throw new DomainError("mesma_pessoa", "O comprador não pode ser você mesmo.");
      const t: DB["transactions"][number] = { ...I.row(), store_id: null, kind: "pf_pf", state: "draft", public_protocol: gerarProtocolo(), current_terms_version: 0, created_by: "", updated_at: I.agora(), completed_at: null };
      db.transactions.push(t);
      db.transaction_parties.push({ ...I.row(), transaction_id: t.id, party_id: s.party_id, role: "seller", is_tenant_side: false });
      db.transaction_parties.push({ ...I.row(), transaction_id: t.id, party_id: buyer, role: "buyer", is_tenant_side: false });
      db.transaction_devices.push({ ...I.row(), transaction_id: t.id, device_id: d.device_id });
      I.mudarEstadoInterno(t, "awaiting_data");
      const payload = { valor_centavos: d.valor_centavos && d.valor_centavos > 0 ? Math.round(d.valor_centavos) : 1, forma_pagamento: "não informada", estado_aparelho: "não informado", defeitos: "", garantia: "", declaracoes: { origem: "comunicacao_de_venda", data_venda: dataVenda } };
      const content_hash = await hashTerms(payload);
      db.transaction_terms.push({ ...I.row(), transaction_id: t.id, version: 1, payload, content_hash, frozen_at: I.agora() });
      t.current_terms_version = 1;
      I.executarConsultaInterno(t, { store_id: null, user_id: null });
      // A declaração do vendedor vale desde já — é isto que o protege.
      I.registrarAceite(t.id, s.party_id, 1, content_hash, "portal", { pf_session: true, comunicacao_de_venda: true });
      I.avancarAposAceite(t);
      db.device_events.push({ ...I.row(), device_id: d.device_id, store_id: null, type: "sale_declared", visibility: "public", transaction_id: t.id, payload: { aviso: "O titular registrado declarou ter vendido este aparelho nesta data. Declaração unilateral: o comprador ainda não confirmou.", data_venda: dataVenda, comprador_confirmou: false } });
      I.auditar(null, null, "pf.sale_declared", "transaction", t.id, { seller: s.party_id });
      if (db.party_contacts.some((c) => c.party_id === buyer && c.kind === "phone")) {
        await I.criarConviteInterno(t, buyer, `${nomeCurto(s.display_name)} declarou ter vendido um aparelho para você pelo Cartório do Celular. Confirme para a transferência ficar registrada em seu nome`, { store_id: null, user_id: null });
      }
      I.salvar();
      return I.txView(t.id);
    },

    async registrarOcorrencia(d) {
      await I.delay(200);
      const s = await exigirPf();
      const db = I.db();
      exigirTitular(s.party_id, d.device_id);
      if (I.ocorrenciaAtiva(d.device_id)) throw new DomainError("ja_declarada", "Já existe uma declaração ativa para este aparelho.", 409);
      const f = { ...I.row(), device_id: d.device_id, kind: "theft_declared" as const, tipo: d.tipo, declared_by_party_id: s.party_id, bo_numero: d.bo_numero?.trim() || null, bo_data: d.bo_data || null, cidade: d.cidade?.trim() || null, uf: d.uf?.trim().toUpperCase().slice(0, 2) || null, active: true, withdrawn_at: null, withdrawn_reason: null };
      db.device_flags.push(f);
      db.device_events.push({ ...I.row(), device_id: d.device_id, store_id: null, type: "theft_declared", visibility: "public", transaction_id: null, payload: { tipo: d.tipo, bo_numero: f.bo_numero, bo_data: f.bo_data, cidade: f.cidade, uf: f.uf, aviso: `O titular registrado declarou ${d.tipo} deste aparelho${f.bo_numero ? `, com boletim de ocorrência nº ${f.bo_numero}` : ", sem número de boletim informado"}. É uma declaração do titular, não uma verificação do Cartório. Canal oficial: Celular Seguro (gov.br).` } });
      I.auditar(null, null, "pf.theft_declared", "device", d.device_id, { tipo: d.tipo });
      I.salvar();
      return I.ocorrenciaAtiva(d.device_id)!;
    },

    async retirarOcorrencia(device_id, motivo) {
      await I.delay(200);
      const s = await exigirPf();
      const db = I.db();
      exigirTitular(s.party_id, device_id);
      const f = db.device_flags.find((x) => x.device_id === device_id && x.kind === "theft_declared" && x.active);
      if (!f) throw new DomainError("sem_declaracao", "Não há declaração ativa.", 404);
      if ((motivo ?? "").trim().length < 5) throw new DomainError("motivo", "Escreva o motivo (ex.: aparelho recuperado).");
      f.active = false; f.withdrawn_at = I.agora(); f.withdrawn_reason = motivo.trim();
      db.device_events.push({ ...I.row(), device_id, store_id: null, type: "theft_withdrawn", visibility: "public", transaction_id: null, payload: { motivo: motivo.trim(), aviso: "O titular registrado retirou a declaração anterior." } });
      I.auditar(null, null, "pf.theft_withdrawn", "device", device_id, {});
      I.salvar();
    },
  },
};
