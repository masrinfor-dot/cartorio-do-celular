// BACKEND DE DEMONSTRAÇÃO — roda inteiro no navegador, sem Supabase.
//
// Ele existe para o protótipo ser testável hoje, com dados sintéticos. Aplica
// as MESMAS regras do núcleo (máquina de estados, gate de procedência, aceite
// preso à versão dos termos, cinco travas do aceite assistido). O "WhatsApp"
// é uma caixa de entrada simulada em /demo/celular — é lá, e só lá, que o
// código de 6 dígitos aparece, porque aquela tela representa o celular do
// vendedor, não a do operador.

import {
  DomainError,
  REQUIRED_MEDIA_SLOTS,
  acceptanceStatus,
  descreverFaltantes,
  cifrar,
  completarImei,
  consultaVigente,
  documentoValido,
  exigirAceiteAssistidoPermitido,
  exigirProcedenciaLiberada,
  exigirTransicao,
  formatarCentavos,
  gerarOtp,
  gerarProtocolo,
  gerarToken,
  hashDocumento,
  hashOtp,
  hashTerms,
  iguaisTempoConstante,
  imeiValido,
  mascararImei,
  mascararTelefone,
  onlyDigits,
  primeiroNome,
  nomeCurto,
  sha256Hex,
  simularConsulta,
  uuid,
  INVITE_TTL_MS,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  type Acceptance,
  type AcceptanceChannel,
  type CheckOutcome,
  type MediaSlot,
  type PartyKind,
  type TermsPayload,
  type TransactionKind,
  type TransactionParty,
  type TransactionState,
} from "@core/index.ts";
import type {
  BuscaAparelho,
  BuscaIdentidade,
  CertificadoView,
  ConclusaoResultado,
  ConviteCriado,
  CriarAparelhoResultado,
  EstoqueItem,
  MediaView,
  PartyView,
  PassaporteResultado,
  RegistryApi,
  ResumoAceitePublico,
  Session,
  Store,
  TransacaoView,
} from "./types.ts";

// Segredos da demonstração. Dados sintéticos — nunca use estes valores em produção.
const DEMO_KEY = "ZGVtby1rZXktZGVtby1rZXktZGVtby1rZXktZGVtbyE="; // 32 bytes
const DEMO_PEPPER = "demo-pepper-nao-usar-em-producao";
const DB_KEY = "cdc-demo-db-v1";
const SESSION_KEY = "cdc-demo-session-v1";

interface Row { id: string; created_at: string }
interface DB {
  users: Array<Row & { email: string; senha: string }>;
  stores: Array<Store & { created_at: string; party_id: string }>;
  store_members: Array<Row & { store_id: string; user_id: string; role: string }>;
  parties: Array<Row & { kind: PartyKind; display_name: string }>;
  party_identifiers: Array<Row & { party_id: string; type: "cpf" | "cnpj"; value_hash: string; value_encrypted: string }>;
  party_contacts: Array<Row & { party_id: string; kind: "phone" | "email"; value: string }>;
  tenant_party_links: Array<Row & { store_id: string; party_id: string }>;
  devices: Array<Row & { brand: string | null; model: string | null; storage: string | null; color: string | null }>;
  device_identifiers: Array<Row & { device_id: string; type: string; value: string; is_active: boolean }>;
  device_media: Array<Row & { device_id: string; store_id: string; transaction_id: string; slot: MediaSlot; sha256: string; data_url: string }>;
  device_checks: Array<Row & CheckOutcome & { device_id: string; transaction_id: string }>;
  device_events: Array<Row & { device_id: string; store_id: string | null; type: string; visibility: "public" | "tenant" | "private"; transaction_id: string | null; payload: Record<string, unknown> }>;
  transactions: Array<Row & { store_id: string; kind: TransactionKind; state: TransactionState; public_protocol: string; current_terms_version: number; created_by: string; updated_at: string; completed_at: string | null }>;
  transaction_parties: Array<Row & TransactionParty & { transaction_id: string }>;
  transaction_devices: Array<Row & { transaction_id: string; device_id: string }>;
  transaction_terms: Array<Row & { transaction_id: string; version: number; payload: TermsPayload; content_hash: string; frozen_at: string }>;
  acceptances: Array<Row & Acceptance & { transaction_id: string; evidence: Record<string, unknown> }>;
  invites: Array<Row & {
    transaction_id: string; party_id: string; terms_version: number; terms_hash: string; token_hash: string;
    otp_hash: string | null; otp_expires_at: string | null; otp_attempts: number; otp_sent_count: number;
    destination_phone: string; destination_masked: string; expires_at: string; consumed_at: string | null; revoked_at: string | null; revoked_reason: string | null;
  }>;
  ownership_periods: Array<Row & { device_id: string; party_id: string; transaction_id: string | null; started_at: string; ended_at: string | null }>;
  certificates: Array<Row & { transaction_id: string; protocol: string; content_hash: string }>;
  idempotency_keys: Array<Row & { scope: string; key: string; store_id: string; request_hash: string; response: unknown }>;
  outbox: Array<Row & { topic: string; store_id: string; payload: Record<string, unknown>; processed_at: string | null }>;
  audit: Array<Row & { store_id: string | null; actor_user_id: string | null; action: string; subject_type: string; subject_id: string | null; metadata: Record<string, unknown> }>;
  whatsapp_inbox: Array<Row & { to_phone: string; to_masked: string; text: string }>;
}

function vazio(): DB {
  return {
    users: [], stores: [], store_members: [], parties: [], party_identifiers: [], party_contacts: [], tenant_party_links: [],
    devices: [], device_identifiers: [], device_media: [], device_checks: [], device_events: [],
    transactions: [], transaction_parties: [], transaction_devices: [], transaction_terms: [], acceptances: [], invites: [],
    ownership_periods: [], certificates: [], idempotency_keys: [], outbox: [], audit: [], whatsapp_inbox: [],
  };
}

let db: DB = carregar();
// Outra aba (o "celular do cliente") grava no mesmo localStorage: recarrega aqui.
try {
  window.addEventListener("storage", (e) => { if (e.key === DB_KEY) db = carregar(); });
} catch { /* sem window */ }
function carregar(): DB {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return { ...vazio(), ...JSON.parse(raw) };
  } catch { /* começa vazio */ }
  return vazio();
}
function salvar() {
  try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch { /* sem storage: só memória */ }
}
const agora = () => new Date().toISOString();
const row = (): Row => ({ id: uuid(), created_at: agora() });
const delay = (ms = 120) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Sessão e loja
// ---------------------------------------------------------------------------

let listeners: Array<(s: Session | null) => void> = [];
function sessaoAtual(): Session | null {
  let uid: string | null = null;
  try { uid = localStorage.getItem(SESSION_KEY); } catch { /* */ }
  if (!uid) return null;
  const u = db.users.find((x) => x.id === uid);
  if (!u) return null;
  const m = db.store_members.find((x) => x.user_id === uid);
  const s = m ? db.stores.find((x) => x.id === m.store_id) ?? null : null;
  return { user_id: u.id, email: u.email, store: s ? { id: s.id, name: s.name, cnpj: s.cnpj, city: s.city, state: s.state, tier: s.tier } : null };
}
function exigirSessao(): Session & { store: Store } {
  const s = sessaoAtual();
  if (!s) throw new DomainError("sem_sessao", "Entre na sua conta para continuar.", 401);
  if (!s.store) throw new DomainError("sem_loja", "Cadastre a loja antes de registrar aparelhos.", 403);
  return s as Session & { store: Store };
}
function notificar() { const s = sessaoAtual(); listeners.forEach((l) => l(s)); }

function auditar(store_id: string | null, actor: string | null, action: string, subject_type: string, subject_id: string | null, metadata: Record<string, unknown> = {}) {
  db.audit.push({ ...row(), store_id, actor_user_id: actor, action, subject_type, subject_id, metadata });
}

// ---------------------------------------------------------------------------
// Helpers de leitura
// ---------------------------------------------------------------------------

function partyView(party_id: string): PartyView {
  const p = db.parties.find((x) => x.id === party_id);
  if (!p) throw new DomainError("parte_inexistente", "Pessoa não encontrada.", 404);
  const tel = db.party_contacts.find((c) => c.party_id === party_id && c.kind === "phone");
  return { party_id: p.id, display_name: p.display_name, kind: p.kind, telefone_mascarado: tel ? mascararTelefone(tel.value) : null };
}
function deviceView(device_id: string) {
  const d = db.devices.find((x) => x.id === device_id);
  if (!d) return null;
  const imei = db.device_identifiers.find((i) => i.device_id === device_id && i.type === "imei" && i.is_active);
  return { device_id: d.id, imei_mascarado: imei ? mascararImei(imei.value) : "****", brand: d.brand, model: d.model, storage: d.storage, color: d.color };
}
function imeiDoDevice(device_id: string): string {
  return db.device_identifiers.find((i) => i.device_id === device_id && i.type === "imei" && i.is_active)?.value ?? "";
}
function termosVigentes(tx_id: string) {
  const t = db.transactions.find((x) => x.id === tx_id)!;
  if (t.current_terms_version === 0) return null;
  return db.transaction_terms.find((x) => x.transaction_id === tx_id && x.version === t.current_terms_version) ?? null;
}
/** A consulta é DESTA transação: cada passagem tem a própria consulta, com a própria data. */
function checkVigente(transaction_id: string): CheckOutcome | null {
  const cs = db.device_checks.filter((c) => c.transaction_id === transaction_id).sort((a, b) => b.checked_at.localeCompare(a.checked_at));
  return cs[0] ?? null;
}
function statusAceite(tx_id: string) {
  const t = db.transactions.find((x) => x.id === tx_id)!;
  const parties = db.transaction_parties.filter((p) => p.transaction_id === tx_id);
  const accs = db.acceptances.filter((a) => a.transaction_id === tx_id);
  const terms = termosVigentes(tx_id);
  return acceptanceStatus(t.kind, parties, accs, t.current_terms_version, terms?.content_hash ?? "");
}
function txView(tx_id: string): TransacaoView {
  const t = db.transactions.find((x) => x.id === tx_id);
  if (!t) throw new DomainError("tx_inexistente", "Transação não encontrada.", 404);
  const dev = db.transaction_devices.find((d) => d.transaction_id === tx_id);
  const terms = termosVigentes(tx_id);
  return {
    id: t.id, kind: t.kind, state: t.state, public_protocol: t.public_protocol, current_terms_version: t.current_terms_version,
    created_at: t.created_at, completed_at: t.completed_at,
    parties: db.transaction_parties.filter((p) => p.transaction_id === tx_id).map((p) => ({ ...p, ...partyView(p.party_id) })),
    device: dev ? deviceView(dev.device_id) : null,
    terms: terms ? { version: terms.version, content_hash: terms.content_hash, payload: terms.payload, frozen_at: terms.frozen_at } : null,
    check: checkVigente(tx_id),
    media: db.device_media.filter((m) => m.transaction_id === tx_id).map((m) => ({ media_id: m.id, slot: m.slot, sha256: m.sha256, url: m.data_url })),
    aceite: statusAceite(tx_id),
    convites: db.invites.filter((i) => i.transaction_id === tx_id).map((i) => ({ invite_id: i.id, party_id: i.party_id, terms_version: i.terms_version, destino_mascarado: i.destination_masked, consumed_at: i.consumed_at, revoked_at: i.revoked_at, expires_at: i.expires_at })),
  };
}
function exigirTxDaLoja(tx_id: string, store_id: string) {
  const t = db.transactions.find((x) => x.id === tx_id && x.store_id === store_id);
  if (!t) throw new DomainError("tx_inexistente", "Transação não encontrada.", 404);
  return t;
}
function mudarEstadoInterno(t: DB["transactions"][number], novo: TransactionState) {
  exigirTransicao(t.state, novo);
  t.state = novo;
  t.updated_at = agora();
}
function linhaDoTempo(device_id: string, publicOnly: boolean, store_id?: string) {
  return db.device_events
    .filter((e) => e.device_id === device_id && (e.visibility === "public" || (!publicOnly && e.store_id === store_id)))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((e) => ({ tipo: e.type, data: e.created_at, dados: e.payload }));
}
function buscaAparelho(device_id: string, store_id?: string): BuscaAparelho {
  const dv = deviceView(device_id);
  if (!dv) return { encontrado: false, elos: 0, linha_do_tempo: [] };
  const elos = db.ownership_periods.filter((o) => o.device_id === device_id).length;
  const titular = db.ownership_periods.find((o) => o.device_id === device_id && !o.ended_at);
  const storeParty = store_id ? db.stores.find((s) => s.id === store_id)?.party_id : undefined;
  return { encontrado: true, device: dv, elos, linha_do_tempo: linhaDoTempo(device_id, !store_id, store_id), loja_e_titular: !!titular && titular.party_id === storeParty };
}

async function idempotente<T extends object>(scope: string, key: string, store_id: string, body: unknown, fn: () => Promise<T>): Promise<T & { repetida?: boolean }> {
  const request_hash = await sha256Hex(JSON.stringify(body));
  const found = db.idempotency_keys.find((k) => k.scope === scope && k.key === key && k.store_id === store_id);
  if (found) {
    if (found.request_hash !== request_hash) throw new DomainError("idempotencia_conflito", "Esta chave já foi usada com dados diferentes.", 409);
    return { ...(found.response as T), repetida: true };
  }
  const resp: T = await fn();
  db.idempotency_keys.push({ ...row(), scope, key, store_id, request_hash, response: resp });
  return resp as T & { repetida?: boolean };
}

// ---------------------------------------------------------------------------
// WhatsApp simulado
// ---------------------------------------------------------------------------
function enviarWhatsapp(to_phone: string, text: string) {
  db.whatsapp_inbox.push({ ...row(), to_phone, to_masked: mascararTelefone(to_phone), text });
}

/** Só a tela /demo/celular usa isto — ela representa o aparelho do cliente. */
export const demoWhatsapp = {
  mensagens(): Array<{ id: string; at: string; to_masked: string; text: string }> {
    return [...db.whatsapp_inbox].reverse().map((m) => ({ id: m.id, at: m.created_at, to_masked: m.to_masked, text: m.text }));
  },
  limpar() { db.whatsapp_inbox = []; salvar(); },
};

export const demoAdmin = {
  zerar() { db = vazio(); salvar(); try { localStorage.removeItem(SESSION_KEY); } catch { /* */ } notificar(); },
  /** IMEIs sintéticos válidos por Luhn — o último dígito controla o simulador. */
  imeiExemplo(terminacao: "clear" | "restricted" | "inconclusive" | "unavailable" = "clear"): string {
    const alvo = { restricted: "0", inconclusive: "1", unavailable: "2", clear: null }[terminacao];
    for (let tenta = 0; tenta < 200; tenta++) {
      const base = "35" + String(Math.floor(Math.random() * 1e12)).padStart(12, "0");
      const imei = completarImei(base);
      if (alvo === null ? !["0", "1", "2"].includes(imei.slice(-1)) : imei.slice(-1) === alvo) return imei;
    }
    return completarImei("35692008000000");
  },
  estatisticas() {
    const total = db.devices.length;
    const comMaisDeUmElo = db.devices.filter((d) => db.ownership_periods.filter((o) => o.device_id === d.id).length > 1).length;
    return { aparelhos: total, densidade: comMaisDeUmElo, transacoes: db.transactions.length, aceitesAssistidos: db.acceptances.filter((a) => a.channel === "presencial_assistido").length };
  },
};

// ---------------------------------------------------------------------------
// A API
// ---------------------------------------------------------------------------

export const demoApi: RegistryApi = {
  modo: "demo",

  auth: {
    async session() { return sessaoAtual(); },
    async signIn(email, senha) {
      await delay();
      const u = db.users.find((x) => x.email.toLowerCase() === email.toLowerCase());
      if (!u || u.senha !== senha) throw new DomainError("credenciais", "E-mail ou senha não conferem.", 401);
      localStorage.setItem(SESSION_KEY, u.id);
      notificar();
      return sessaoAtual()!;
    },
    async signUp(email, senha) {
      await delay();
      if (!/.+@.+\..+/.test(email)) throw new DomainError("email", "Informe um e-mail válido.");
      if (senha.length < 6) throw new DomainError("senha", "A senha precisa ter pelo menos 6 caracteres.");
      if (db.users.some((x) => x.email.toLowerCase() === email.toLowerCase())) throw new DomainError("email_existe", "Já existe conta com esse e-mail. Entre com ela.");
      const u = { ...row(), email, senha };
      db.users.push(u);
      salvar();
      localStorage.setItem(SESSION_KEY, u.id);
      notificar();
      return sessaoAtual()!;
    },
    async signOut() { try { localStorage.removeItem(SESSION_KEY); } catch { /* */ } notificar(); },
    onChange(cb) { listeners.push(cb); return () => { listeners = listeners.filter((l) => l !== cb); }; },
  },

  loja: {
    async criar({ nome, cnpj, cidade, uf }) {
      await delay();
      const s = sessaoAtual();
      if (!s) throw new DomainError("sem_sessao", "Entre na sua conta.", 401);
      if (s.store) throw new DomainError("ja_tem_loja", "Este usuário já pertence a uma loja.");
      const c = onlyDigits(cnpj);
      if (!documentoValido(c, "pj")) throw new DomainError("cnpj", "Esse CNPJ não confere. Confira os dígitos.");
      if (!nome.trim()) throw new DomainError("nome", "Informe o nome da loja.");
      if (db.stores.some((x) => x.cnpj === c)) throw new DomainError("cnpj_existe", "Já existe loja com esse CNPJ.");
      // A loja também é uma PARTE (pj) — é ela que figura como compradora/vendedora.
      const party = { ...row(), kind: "pj" as const, display_name: nome.trim() };
      db.parties.push(party);
      db.party_identifiers.push({ ...row(), party_id: party.id, type: "cnpj", value_hash: await hashDocumento(DEMO_PEPPER, c), value_encrypted: await cifrar(DEMO_KEY, c) });
      const store = { ...row(), name: nome.trim(), cnpj: c, city: cidade || null, state: uf ? uf.toUpperCase() : null, tier: "cadastrada" as const, party_id: party.id };
      db.stores.push(store);
      db.store_members.push({ ...row(), store_id: store.id, user_id: s.user_id, role: "owner" });
      db.tenant_party_links.push({ ...row(), store_id: store.id, party_id: party.id });
      auditar(store.id, s.user_id, "store.created", "store", store.id);
      salvar();
      notificar();
      return { id: store.id, name: store.name, cnpj: store.cnpj, city: store.city, state: store.state, tier: store.tier };
    },
  },

  identidade: {
    async buscar(documento): Promise<BuscaIdentidade> {
      await delay();
      const s = exigirSessao();
      const d = onlyDigits(documento);
      const h = await hashDocumento(DEMO_PEPPER, d);
      const ident = db.party_identifiers.find((i) => i.value_hash === h);
      if (!ident) return { encontrado: false };
      const vinculo = db.tenant_party_links.some((l) => l.store_id === s.store.id && l.party_id === ident.party_id);
      if (!vinculo) return { encontrado: true, vinculo: false, party_id: ident.party_id }; // o nome NÃO vai
      const pv = partyView(ident.party_id);
      return { encontrado: true, vinculo: true, party_id: pv.party_id, display_name: pv.display_name, telefone_mascarado: pv.telefone_mascarado };
    },
    async criar({ documento, tipo, nome, telefone }) {
      await delay();
      const s = exigirSessao();
      const d = onlyDigits(documento);
      if (!documentoValido(d, tipo)) throw new DomainError("documento", tipo === "pf" ? "Esse CPF não confere. Confira os dígitos." : "Esse CNPJ não confere. Confira os dígitos.");
      if (!nome.trim()) throw new DomainError("nome", "Informe o nome.");
      const tel = onlyDigits(telefone);
      if (tel.length < 10) throw new DomainError("telefone", "Informe o telefone com DDD — é por ele que o código de aceite chega.");
      const h = await hashDocumento(DEMO_PEPPER, d);
      let ident = db.party_identifiers.find((i) => i.value_hash === h);
      let party_id: string;
      if (ident) {
        party_id = ident.party_id; // pessoa única na plataforma: só cria o vínculo
      } else {
        const p = { ...row(), kind: tipo, display_name: nome.trim() };
        db.parties.push(p);
        ident = { ...row(), party_id: p.id, type: tipo === "pf" ? "cpf" : "cnpj", value_hash: h, value_encrypted: await cifrar(DEMO_KEY, d) };
        db.party_identifiers.push(ident);
        party_id = p.id;
      }
      if (!db.party_contacts.some((c) => c.party_id === party_id && c.kind === "phone" && c.value === tel)) {
        db.party_contacts.push({ ...row(), party_id, kind: "phone", value: tel });
      }
      if (!db.tenant_party_links.some((l) => l.store_id === s.store.id && l.party_id === party_id)) {
        db.tenant_party_links.push({ ...row(), store_id: s.store.id, party_id });
      }
      auditar(s.store.id, s.user_id, "party.linked", "party", party_id);
      salvar();
      return partyView(party_id);
    },
  },

  aparelho: {
    async buscarPorImei(imei) {
      await delay();
      const s = exigirSessao();
      const p = onlyDigits(imei);
      if (!imeiValido(p)) throw new DomainError("imei", "Esse IMEI não confere. Confira os 15 dígitos — provavelmente há um número trocado.");
      const id = db.device_identifiers.find((i) => i.type === "imei" && i.value === p && i.is_active);
      if (!id) return { encontrado: false, elos: 0, linha_do_tempo: [] };
      return buscaAparelho(id.device_id, s.store.id);
    },
    async criar({ imei, marca, modelo, armazenamento, cor }): Promise<CriarAparelhoResultado> {
      await delay();
      const s = exigirSessao();
      const p = onlyDigits(imei);
      if (!imeiValido(p)) throw new DomainError("imei", "Esse IMEI não confere. Confira os 15 dígitos — provavelmente há um número trocado.");
      const existente = db.device_identifiers.find((i) => i.type === "imei" && i.value === p && i.is_active);
      if (existente) return { conflito: true, existente: buscaAparelho(existente.device_id, s.store.id) };
      const d = { ...row(), brand: marca || null, model: modelo || null, storage: armazenamento || null, color: cor || null };
      db.devices.push(d);
      db.device_identifiers.push({ ...row(), device_id: d.id, type: "imei", value: p, is_active: true });
      db.device_events.push({ ...row(), device_id: d.id, store_id: s.store.id, type: "device_created", visibility: "public", transaction_id: null, payload: { marca: d.brand, modelo: d.model } });
      auditar(s.store.id, s.user_id, "device.created", "device", d.id);
      salvar();
      return { conflito: false, device_id: d.id };
    },
  },

  transacao: {
    async criar({ kind, device_id, seller_party_id, buyer_party_id, idempotency_key }) {
      await delay();
      const s = exigirSessao();
      const body = { kind, device_id, seller_party_id, buyer_party_id };
      const r = await idempotente("tx.create", idempotency_key, s.store.id, body, async () => {
        if (!db.devices.some((d) => d.id === device_id)) throw new DomainError("aparelho", "Aparelho não encontrado.", 404);
        const storeParty = db.stores.find((x) => x.id === s.store.id)!.party_id;
        if (kind === "pj_pf") {
          // Não se vende o que não se tem.
          const titular = db.ownership_periods.find((o) => o.device_id === device_id && !o.ended_at);
          if (!titular || titular.party_id !== storeParty) throw new DomainError("nao_titular", "A loja não é a titular atual deste aparelho. Não se vende o que não se tem.", 403);
        }
        const t = { ...row(), store_id: s.store.id, kind, state: "draft" as TransactionState, public_protocol: gerarProtocolo(), current_terms_version: 0, created_by: s.user_id, updated_at: agora(), completed_at: null };
        db.transactions.push(t);
        db.transaction_parties.push({ ...row(), transaction_id: t.id, party_id: seller_party_id, role: "seller", is_tenant_side: seller_party_id === storeParty });
        db.transaction_parties.push({ ...row(), transaction_id: t.id, party_id: buyer_party_id, role: "buyer", is_tenant_side: buyer_party_id === storeParty });
        db.transaction_devices.push({ ...row(), transaction_id: t.id, device_id });
        mudarEstadoInterno(t, "awaiting_data");
        auditar(s.store.id, s.user_id, "tx.created", "transaction", t.id, { kind });
        salvar();
        return { id: t.id };
      });
      return txView(r.id);
    },
    async obter(id) { await delay(40); const s = exigirSessao(); exigirTxDaLoja(id, s.store.id); return txView(id); },
    async listar() {
      await delay(40);
      const s = exigirSessao();
      return db.transactions.filter((t) => t.store_id === s.store.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).map((t) => txView(t.id));
    },
    async mudarEstado(id, novo) {
      await delay();
      const s = exigirSessao();
      const t = exigirTxDaLoja(id, s.store.id);
      mudarEstadoInterno(t, novo);
      salvar();
      return txView(id);
    },
    async congelarTermos(id, termos) {
      await delay();
      const s = exigirSessao();
      const t = exigirTxDaLoja(id, s.store.id);
      if (["completed", "cancelled", "expired", "disputed", "blocked"].includes(t.state)) throw new DomainError("tx_encerrada", "Esta transação não aceita mais mudanças.", 409);
      if (!(termos.valor_centavos > 0)) throw new DomainError("valor", "Informe o valor.");
      if (!termos.forma_pagamento) throw new DomainError("forma_pagamento", "Informe a forma de pagamento.");
      const payload: TermsPayload = { valor_centavos: Math.round(termos.valor_centavos), forma_pagamento: termos.forma_pagamento, estado_aparelho: termos.estado_aparelho ?? "", defeitos: termos.defeitos ?? "", garantia: termos.garantia ?? "", declaracoes: termos.declaracoes ?? {} };
      const content_hash = await hashTerms(payload);
      const vig = termosVigentes(id);
      if (vig && vig.content_hash === content_hash) return { version: vig.version, content_hash, unchanged: true };
      const version = t.current_terms_version + 1;
      db.transaction_terms.push({ ...row(), transaction_id: id, version, payload, content_hash, frozen_at: agora() });
      t.current_terms_version = version;
      // Revoga convites das versões anteriores. Os aceites antigos simplesmente deixam de contar.
      for (const inv of db.invites) {
        if (inv.transaction_id === id && inv.terms_version < version && !inv.consumed_at && !inv.revoked_at) { inv.revoked_at = agora(); inv.revoked_reason = "termos_alterados"; }
      }
      if (t.state === "awaiting_buyer" || t.state === "ready_to_complete") mudarEstadoInterno(t, "awaiting_seller");
      auditar(s.store.id, s.user_id, "tx.terms_frozen", "transaction", id, { version });
      salvar();
      return { version, content_hash, unchanged: false };
    },
  },

  consulta: {
    async executar(transaction_id) {
      await delay(400);
      const s = exigirSessao();
      const t = exigirTxDaLoja(transaction_id, s.store.id);
      const dev = db.transaction_devices.find((d) => d.transaction_id === transaction_id)!;
      const out = simularConsulta(imeiDoDevice(dev.device_id));
      db.device_checks.push({ ...row(), ...out, device_id: dev.device_id, transaction_id });
      if (t.state === "awaiting_data") mudarEstadoInterno(t, "awaiting_checks");
      if (t.state === "awaiting_checks" || t.state === "under_review") {
        if (out.result === "clear") mudarEstadoInterno(t, "awaiting_seller");
        else if (out.result === "restricted") mudarEstadoInterno(t, "blocked");
        else if (out.result === "inconclusive") mudarEstadoInterno(t, "under_review");
        // unavailable / expired: fica onde está, sem liberar.
      }
      db.device_events.push({ ...row(), device_id: dev.device_id, store_id: s.store.id, type: "check_performed", visibility: "tenant", transaction_id, payload: { resultado: out.result, fonte: out.provider, data: out.checked_at } });
      salvar();
      return out;
    },
  },

  midia: {
    async enviar(transaction_id, slot, arquivo) {
      const s = exigirSessao();
      exigirTxDaLoja(transaction_id, s.store.id);
      const dev = db.transaction_devices.find((d) => d.transaction_id === transaction_id)!;
      const bytes = new Uint8Array(await arquivo.arrayBuffer());
      if (bytes.length === 0) throw new DomainError("foto_vazia", "A foto veio vazia. Tente de novo.");
      const sha256 = await sha256Hex(bytes);
      const data_url = await reduzirParaDataUrl(arquivo);
      db.device_media = db.device_media.filter((m) => !(m.transaction_id === transaction_id && m.slot === slot)); // troca da foto do MESMO slot na mesma transação em rascunho
      const m = { ...row(), device_id: dev.device_id, store_id: s.store.id, transaction_id, slot, sha256, data_url };
      db.device_media.push(m);
      salvar();
      return { media_id: m.id, slot, sha256, url: data_url };
    },
  },

  convite: {
    async criar(transaction_id, party_id): Promise<ConviteCriado> {
      await delay(300);
      const s = exigirSessao();
      const t = exigirTxDaLoja(transaction_id, s.store.id);
      const part = db.transaction_parties.find((p) => p.transaction_id === transaction_id && p.party_id === party_id);
      if (!part) throw new DomainError("parte", "Essa pessoa não faz parte desta transação.", 404);
      if (part.is_tenant_side) throw new DomainError("convite_loja", "A loja tem canal próprio de aceite; o convite é para a outra parte.", 403);
      const terms = termosVigentes(transaction_id);
      if (!terms) throw new DomainError("sem_termos", "Confirme as condições antes de enviar o código.", 409);
      const phone = db.party_contacts.find((c) => c.party_id === party_id && c.kind === "phone")?.value;
      if (!phone) throw new DomainError("sem_telefone", "Essa pessoa não tem telefone cadastrado — e o código só chega por ele.", 409);

      const vivo = db.invites.find((i) => i.transaction_id === transaction_id && i.party_id === party_id && i.terms_version === terms.version && !i.consumed_at && !i.revoked_at);
      let inv = vivo;
      let token = "";
      let reaproveitado = false;
      if (inv && new Date(inv.expires_at).getTime() > Date.now()) {
        // Um convite vivo por parte e versão: reenviar reaproveita. Como o token não é
        // recuperável (só o hash), a demonstração gera um token novo e troca o hash —
        // continua sendo UM convite.
        token = gerarToken();
        inv.token_hash = await sha256Hex(token);
        reaproveitado = true;
      } else {
        if (inv) { inv.revoked_at = agora(); inv.revoked_reason = "expirado"; }
        token = gerarToken();
        inv = { ...row(), transaction_id, party_id, terms_version: terms.version, terms_hash: terms.content_hash, token_hash: await sha256Hex(token), otp_hash: null, otp_expires_at: null, otp_attempts: 0, otp_sent_count: 0, destination_phone: phone, destination_masked: mascararTelefone(phone), expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(), consumed_at: null, revoked_at: null, revoked_reason: null };
        db.invites.push(inv);
      }
      const link = `${location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}/aceite/${token}`;
      const nomeLoja = s.store.name;
      enviarWhatsapp(phone, `Cartório do Celular — ${nomeLoja} registrou a passagem do seu aparelho. Para confirmar, abra o link e informe o código que vai chegar aqui: ${link}`);
      if (t.state === "awaiting_seller" && part.role === "buyer") { /* ok */ }
      auditar(s.store.id, s.user_id, "invite.sent", "invite", inv.id, { party_id, terms_version: terms.version, reaproveitado });
      salvar();
      return { invite_id: inv.id, link, destino_mascarado: inv.destination_masked, expires_at: inv.expires_at, reaproveitado };
    },
  },

  // Rotas públicas: NENHUMA olha para a sessão.
  aceitePublico: {
    async resumo(token): Promise<ResumoAceitePublico> {
      await delay(80);
      const inv = await inviteDoToken(token);
      if (!inv) return { valido: false, motivo: "Este link não é válido ou já foi usado. Peça um novo para a loja." };
      const t = db.transactions.find((x) => x.id === inv.transaction_id)!;
      const terms = termosVigentes(t.id);
      if (!terms || terms.version !== inv.terms_version || terms.content_hash !== inv.terms_hash) {
        return { valido: false, motivo: "As condições mudaram depois que este link foi enviado. Peça um novo para a loja." };
      }
      if (inv.revoked_at) return { valido: false, motivo: "Este link foi cancelado. Peça um novo para a loja." };
      if (new Date(inv.expires_at).getTime() < Date.now()) return { valido: false, motivo: "Este link venceu. Peça um novo para a loja." };
      const part = db.transaction_parties.find((p) => p.transaction_id === t.id && p.party_id === inv.party_id)!;
      const party = db.parties.find((p) => p.id === inv.party_id)!;
      const dev = db.transaction_devices.find((d) => d.transaction_id === t.id)!;
      const dv = deviceView(dev.device_id)!;
      const loja = db.stores.find((st) => st.id === t.store_id)!;
      const p = terms.payload;
      return {
        valido: true,
        aceito: !!inv.consumed_at,
        primeiro_nome: primeiroNome(party.display_name),
        papel: part.role as "seller" | "buyer",
        loja: loja.name,
        imei_mascarado: dv.imei_mascarado,
        aparelho: [dv.brand, dv.model, dv.storage, dv.color].filter(Boolean).join(" "),
        valor: formatarCentavos(p.valor_centavos),
        forma_pagamento: p.forma_pagamento,
        resumo_termos: [
          `Estado declarado: ${p.estado_aparelho || "não informado"}`,
          p.defeitos ? `Defeitos declarados: ${p.defeitos}` : "Sem defeitos declarados",
          p.garantia ? `Garantia: ${p.garantia}` : "Sem garantia declarada",
          `Termos versão ${terms.version} · ${terms.content_hash.slice(0, 12)}…`,
        ],
        tentativas_restantes: Math.max(0, OTP_MAX_ATTEMPTS - inv.otp_attempts),
      };
    },
    async pedirCodigo(token) {
      await delay(300);
      const inv = await inviteDoToken(token);
      if (!inv || inv.revoked_at || inv.consumed_at) throw new DomainError("convite", "Este link não é válido ou já foi usado.", 404);
      const codigo = gerarOtp();
      inv.otp_hash = await hashOtp(DEMO_PEPPER, inv.id, codigo);
      inv.otp_expires_at = new Date(Date.now() + OTP_TTL_MS).toISOString();
      inv.otp_attempts = 0;
      inv.otp_sent_count += 1;
      // O código vai para o WhatsApp da PARTE. Nunca volta na resposta.
      enviarWhatsapp(inv.destination_phone, `Seu código do Cartório do Celular: ${codigo}. Vale por 10 minutos. Não compartilhe com ninguém — nem com a loja.`);
      salvar();
      return { enviado: true, destino_mascarado: inv.destination_masked };
    },
    async confirmar(token, codigo) {
      await delay(200);
      const inv = await inviteDoToken(token);
      if (!inv || inv.revoked_at) throw new DomainError("convite", "Este link não é válido. Peça um novo para a loja.", 404);
      if (inv.consumed_at) return { aceito: true };
      const t = db.transactions.find((x) => x.id === inv.transaction_id)!;
      const terms = termosVigentes(t.id);
      if (!terms || terms.version !== inv.terms_version || terms.content_hash !== inv.terms_hash) {
        throw new DomainError("termos_mudaram", "As condições mudaram depois que este link foi enviado. Peça um novo para a loja.", 409);
      }
      if (!inv.otp_hash || !inv.otp_expires_at) throw new DomainError("sem_codigo", "Peça o código primeiro.");
      if (new Date(inv.otp_expires_at).getTime() < Date.now()) throw new DomainError("codigo_vencido", "O código venceu. Peça outro.");
      if (inv.otp_attempts >= OTP_MAX_ATTEMPTS) { inv.revoked_at = agora(); inv.revoked_reason = "tentativas"; salvar(); throw new DomainError("tentativas", "Muitas tentativas. Este link foi cancelado — peça um novo para a loja.", 429); }
      const h = await hashOtp(DEMO_PEPPER, inv.id, onlyDigits(codigo));
      if (!iguaisTempoConstante(h, inv.otp_hash)) {
        inv.otp_attempts += 1;
        salvar();
        const rest = OTP_MAX_ATTEMPTS - inv.otp_attempts;
        if (rest <= 0) { inv.revoked_at = agora(); inv.revoked_reason = "tentativas"; salvar(); throw new DomainError("tentativas", "Muitas tentativas. Este link foi cancelado — peça um novo para a loja.", 429); }
        throw new DomainError("codigo_errado", `Código não confere. ${rest === 1 ? "Última tentativa." : `Você ainda tem ${rest} tentativas.`}`);
      }
      registrarAceite(t.id, inv.party_id, terms.version, terms.content_hash, "otp_whatsapp", { invite_id: inv.id, destino: inv.destination_masked });
      inv.consumed_at = agora();
      avancarAposAceite(t);
      salvar();
      return { aceito: true };
    },
  },

  aceiteLoja: {
    async registrar(transaction_id, party_id) {
      await delay();
      const s = exigirSessao();
      const t = exigirTxDaLoja(transaction_id, s.store.id);
      const part = db.transaction_parties.find((p) => p.transaction_id === transaction_id && p.party_id === party_id);
      if (!part) throw new DomainError("parte", "Essa pessoa não faz parte desta transação.", 404);
      if (!part.is_tenant_side) throw new DomainError("aceite_pelo_cliente", "O operador não assina pelo cliente. O aceite dele vem pelo celular dele.", 403);
      const terms = termosVigentes(transaction_id);
      if (!terms) throw new DomainError("sem_termos", "Confirme as condições antes de aceitar.", 409);
      registrarAceite(transaction_id, party_id, terms.version, terms.content_hash, "operator_pj", { operator_user_id: s.user_id });
      avancarAposAceite(t);
      salvar();
      return statusAceite(transaction_id);
    },
  },

  aceiteAssistido: {
    async registrar(transaction_id, party_id, motivo) {
      await delay();
      const s = exigirSessao();
      const t = exigirTxDaLoja(transaction_id, s.store.id);
      const part = db.transaction_parties.find((p) => p.transaction_id === transaction_id && p.party_id === party_id);
      if (!part) throw new DomainError("parte", "Essa pessoa não faz parte desta transação.", 404);
      const terms = termosVigentes(transaction_id);
      if (!terms) throw new DomainError("sem_termos", "Confirme as condições antes de aceitar.", 409);
      const inv = db.invites.filter((i) => i.transaction_id === transaction_id && i.party_id === party_id && i.terms_version === terms.version).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
      exigirAceiteAssistidoPermitido({ party: part, invite: inv ? { id: inv.id, party_id: inv.party_id, terms_version: inv.terms_version, terms_hash: inv.terms_hash, consumed_at: inv.consumed_at, revoked_at: inv.revoked_at, expires_at: inv.expires_at } : null, termsVersion: terms.version, reason: motivo, operatorUserId: s.user_id });
      registrarAceite(transaction_id, party_id, terms.version, terms.content_hash, "presencial_assistido", { reason: motivo.trim(), operator_user_id: s.user_id, invite_id: inv!.id, destino: inv!.destination_masked });
      // Queima o convite na mesma transação: dois caminhos abertos registram duas vezes.
      inv!.revoked_at = agora();
      inv!.revoked_reason = "aceite_presencial_assistido";
      auditar(s.store.id, s.user_id, "acceptance.assisted", "transaction", transaction_id, { reason: motivo.trim(), invite_id: inv!.id });
      avancarAposAceite(t);
      salvar();
      return statusAceite(transaction_id);
    },
  },

  async concluir(transaction_id, idempotency_key): Promise<ConclusaoResultado> {
    await delay(300);
    const s = exigirSessao();
    const t = exigirTxDaLoja(transaction_id, s.store.id);
    const r = await idempotente("tx.complete", idempotency_key, s.store.id, { transaction_id }, async () => {
      const dev = db.transaction_devices.find((d) => d.transaction_id === transaction_id)!;
      // 1. gate de procedência
      const ck = checkVigente(transaction_id);
      exigirProcedenciaLiberada(ck ? consultaVigente(ck) : null);
      // 2. fotos obrigatórias
      const slots = new Set(db.device_media.filter((m) => m.transaction_id === transaction_id).map((m) => m.slot));
      const faltam = REQUIRED_MEDIA_SLOTS.filter((sl) => !slots.has(sl));
      if (faltam.length) throw new DomainError("fotos", `Faltam fotos obrigatórias: ${faltam.map(rotuloSlot).join(", ")}.`, 409);
      // 3. aceites da versão vigente
      const st = statusAceite(transaction_id);
      if (!st.complete) throw new DomainError("aceite_incompleto", descreverFaltantes(st), 409);
      // 4. transição
      if (t.state !== "ready_to_complete") exigirTransicao(t.state, "completed");
      // 5–6. titularidade
      const terms = termosVigentes(transaction_id)!;
      const seller = db.transaction_parties.find((p) => p.transaction_id === transaction_id && p.role === "seller")!;
      const buyer = db.transaction_parties.find((p) => p.transaction_id === transaction_id && p.role === "buyer")!;
      const now = agora();
      const aberto = db.ownership_periods.find((o) => o.device_id === dev.device_id && !o.ended_at);
      if (aberto) {
        if (aberto.party_id !== seller.party_id) {
          if (t.kind !== "pf_pj") throw new DomainError("titular_divergente", "O titular atual registrado não é o vendedor desta transação.", 409);
          // Entrada de balcão vinda de quem não era o último titular registrado: o
          // Cartório registra a passagem e DECLARA o buraco na corrente — não acusa.
          db.device_events.push({ ...row(), device_id: dev.device_id, store_id: s.store.id, type: "chain_gap", visibility: "public", transaction_id, payload: { aviso: "O vendedor desta passagem não era o último titular registrado. Houve ao menos uma passagem sem registro no Cartório entre as duas." } });
        }
        aberto.ended_at = now;
      }
      // Exclusão de sobreposição (no Postgres é constraint; aqui, conferência explícita).
      if (db.ownership_periods.some((o) => o.device_id === dev.device_id && !o.ended_at)) throw new DomainError("dois_donos", "Já existe um titular aberto para este aparelho.", 409);
      db.ownership_periods.push({ ...row(), device_id: dev.device_id, party_id: buyer.party_id, transaction_id, started_at: now, ended_at: null });
      // 7. evento público
      db.device_events.push({ ...row(), device_id: dev.device_id, store_id: s.store.id, type: "transfer_completed", visibility: "public", transaction_id, payload: { protocolo: t.public_protocol, modalidade: t.kind, aceite: st.grade, termos_hash: terms.content_hash, consulta: ck ? { resultado: ck.result, fonte: ck.provider, data: ck.checked_at } : null } });
      // 8. outbox
      db.outbox.push({ ...row(), topic: "registry.transfer_completed", store_id: s.store.id, payload: { transaction_id, device_id: dev.device_id, protocolo: t.public_protocol, kind: t.kind, aceite: st.grade }, processed_at: null });
      // 9. estado
      mudarEstadoInterno(t, "completed");
      t.completed_at = now;
      // certificado
      const cert = await montarCertificado(transaction_id);
      db.certificates.push({ ...row(), transaction_id, protocol: t.public_protocol, content_hash: cert.content_hash });
      auditar(s.store.id, s.user_id, "tx.completed", "transaction", transaction_id, { grade: st.grade });
      salvar();
      return { protocolo: t.public_protocol, grade: st.grade, completed_at: now, repetida: false };
    });
    return { ...r, repetida: !!r.repetida };
  },

  estoque: {
    async listar(): Promise<EstoqueItem[]> {
      await delay(40);
      const s = exigirSessao();
      const storeParty = db.stores.find((x) => x.id === s.store.id)!.party_id;
      return db.ownership_periods
        .filter((o) => o.party_id === storeParty && !o.ended_at)
        .sort((a, b) => b.started_at.localeCompare(a.started_at))
        .map((o) => ({ device: deviceView(o.device_id)!, desde: o.started_at, protocolo_entrada: o.transaction_id ? db.transactions.find((t) => t.id === o.transaction_id)?.public_protocol ?? null : null }));
    },
    async partyDaLoja() {
      const s = exigirSessao();
      return partyView(db.stores.find((x) => x.id === s.store.id)!.party_id);
    },
  },

  publico: {
    async passaporte(imei): Promise<PassaporteResultado> {
      await delay(80);
      const p = onlyDigits(imei);
      const id = db.device_identifiers.find((i) => i.type === "imei" && i.value === p && i.is_active);
      if (!id) return { encontrado: false, aviso: "Este aparelho ainda não tem registro no Cartório. Isso não significa que ele tenha problema — significa que ninguém registrou a passagem dele por aqui." };
      return {
        encontrado: true,
        imei_mascarado: mascararImei(p),
        elos: db.ownership_periods.filter((o) => o.device_id === id.device_id).length,
        linha_do_tempo: linhaDoTempo(id.device_id, true),
        limites: "O Cartório registra passagens declaradas e verificadas na data indicada. Não é órgão público e não substitui boletim de ocorrência, nota fiscal ou vistoria técnica.",
      };
    },
    async certificado(protocolo) {
      await delay(80);
      const t = db.transactions.find((x) => x.public_protocol === protocolo.trim().toUpperCase() && x.state === "completed");
      if (!t) return null;
      return montarCertificado(t.id);
    },
  },
};

// ---------------------------------------------------------------------------
// Internos
// ---------------------------------------------------------------------------

async function inviteDoToken(token: string) {
  if (!token) return null;
  const h = await sha256Hex(token);
  return db.invites.find((i) => i.token_hash === h) ?? null;
}

function registrarAceite(transaction_id: string, party_id: string, terms_version: number, terms_hash: string, channel: AcceptanceChannel, evidence: Record<string, unknown>) {
  if (db.acceptances.some((a) => a.transaction_id === transaction_id && a.party_id === party_id && a.terms_version === terms_version)) return; // uma vez por versão
  db.acceptances.push({ ...row(), transaction_id, party_id, terms_version, terms_hash, channel, accepted_at: agora(), evidence });
}

function avancarAposAceite(t: DB["transactions"][number]) {
  const st = statusAceite(t.id);
  const sellerOk = st.accepted.some((p) => p.role === "seller");
  const buyerOk = st.accepted.some((p) => p.role === "buyer");
  if (st.complete && t.state !== "ready_to_complete") {
    if (t.state === "awaiting_seller") mudarEstadoInterno(t, "awaiting_buyer");
    if (t.state === "awaiting_buyer") mudarEstadoInterno(t, "ready_to_complete");
  } else if (sellerOk && !buyerOk && t.state === "awaiting_seller") {
    mudarEstadoInterno(t, "awaiting_buyer");
  }
}

function rotuloSlot(s: MediaSlot): string {
  return { frente_ligada: "frente ligada", traseira: "traseira", tela_imei: "tela com o IMEI", laterais: "laterais", avarias: "avarias", documento: "documento", selfie: "selfie" }[s];
}

async function montarCertificado(transaction_id: string): Promise<CertificadoView> {
  const t = db.transactions.find((x) => x.id === transaction_id)!;
  const dev = db.transaction_devices.find((d) => d.transaction_id === transaction_id)!;
  const dv = deviceView(dev.device_id)!;
  const terms = termosVigentes(transaction_id)!;
  const seller = db.transaction_parties.find((p) => p.transaction_id === transaction_id && p.role === "seller")!;
  const buyer = db.transaction_parties.find((p) => p.transaction_id === transaction_id && p.role === "buyer")!;
  const st = statusAceite(transaction_id);
  const ck = db.device_checks.filter((c) => c.transaction_id === transaction_id).sort((a, b) => b.checked_at.localeCompare(a.checked_at))[0] ?? null;
  const loja = db.stores.find((x) => x.id === t.store_id)!;
  const p = terms.payload;
  const elosAntes = db.ownership_periods.filter((o) => o.device_id === dev.device_id && o.transaction_id !== transaction_id && (!o.ended_at || o.ended_at <= (t.completed_at ?? agora()))).length;
  const conteudo = {
    protocolo: t.public_protocol,
    kind: t.kind,
    emitido_em: t.completed_at ?? "",
    imei_mascarado: dv.imei_mascarado,
    aparelho: [dv.brand, dv.model, dv.storage, dv.color].filter(Boolean).join(" "),
    loja: loja.name,
    vendedor: nomeCurto(partyView(seller.party_id).display_name),
    comprador: nomeCurto(partyView(buyer.party_id).display_name),
    grade: st.grade,
    verificado: [
      ...(ck ? [{ item: `IMEI ${ck.result === "clear" ? "sem restrição" : ck.result} na consulta`, data: ck.checked_at, fonte: ck.provider }] : []),
      { item: "Documento do vendedor com dígitos verificadores válidos", data: t.created_at, fonte: "Cartório" },
      { item: `Registro anterior no Cartório: ${elosAntes} elo(s)`, data: t.completed_at ?? "", fonte: "Cartório" },
      { item: "Termos aceitos pelas duas partes na versão " + terms.version, data: t.completed_at ?? "", fonte: st.grade === "assistido" ? "aceite presencial assistido — prova de grau menor" : "aceite por canal próprio" },
    ],
    declarado: [
      { item: "Estado do aparelho", valor: p.estado_aparelho || "não informado" },
      { item: "Defeitos", valor: p.defeitos || "nenhum declarado" },
      ...Object.entries(p.declaracoes ?? {}).map(([k, v]) => ({ item: k, valor: String(v) })),
    ],
    valor: formatarCentavos(p.valor_centavos),
    forma_pagamento: p.forma_pagamento,
    garantia: p.garantia || "não informada",
  };
  const content_hash = await hashTerms(conteudo); // sem data de geração dentro: mesmo conteúdo, mesmo hash
  return { ...conteudo, content_hash };
}

async function reduzirParaDataUrl(arquivo: Blob): Promise<string> {
  // Redimensiona para caber no localStorage. Redesenhar no canvas também descarta o EXIF.
  try {
    const bmp = await createImageBitmap(arquivo);
    const max = 640;
    const esc = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * esc);
    c.height = Math.round(bmp.height * esc);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.7);
  } catch {
    return await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(arquivo); });
  }
}
