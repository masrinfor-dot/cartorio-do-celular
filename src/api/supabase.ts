// Cliente do backend Supabase. Toda escrita vai por Edge Function; o navegador
// nunca grava lastro nem vê CPF, token ou código.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DomainError } from "@core/index.ts";
import type { RegistryApi, Session, Store } from "./types.ts";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

let client: SupabaseClient | null = null;
function sb(): SupabaseClient {
  if (!client) {
    if (!url || !anon) throw new DomainError("config", "Configure VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY no .env.", 500);
    client = createClient(url, anon);
  }
  return client;
}

async function fn<T>(nome: string, body: Record<string, unknown>, opts: { publico?: boolean; headers?: Record<string, string> } = {}): Promise<T> {
  const { data: sess } = await sb().auth.getSession();
  const headers: Record<string, string> = { "Content-Type": "application/json", apikey: anon, ...(opts.headers ?? {}) };
  if (!opts.publico && sess.session) headers.Authorization = `Bearer ${sess.session.access_token}`;
  else headers.Authorization = `Bearer ${anon}`;
  const res = await fetch(`${url}/functions/v1/${nome}`, { method: "POST", headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) {
    const e = json?.error ?? {};
    throw new DomainError(e.code ?? "erro", e.message ?? "Algo deu errado. Tente de novo.", res.status);
  }
  return json as T;
}

async function fnMultipart<T>(nome: string, form: FormData): Promise<T> {
  const { data: sess } = await sb().auth.getSession();
  const res = await fetch(`${url}/functions/v1/${nome}`, { method: "POST", headers: { apikey: anon, Authorization: `Bearer ${sess.session?.access_token ?? anon}` }, body: form });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) throw new DomainError(json?.error?.code ?? "erro", json?.error?.message ?? "Falha ao enviar a foto.", res.status);
  return json as T;
}

async function sessaoAtual(): Promise<Session | null> {
  const { data } = await sb().auth.getUser();
  if (!data.user) return null;
  const { data: m } = await sb().from("store_members").select("store_id, stores(id,name,cnpj,city,state,tier)").eq("user_id", data.user.id).limit(1).maybeSingle();
  const st = (m as { stores?: Store } | null)?.stores ?? null;
  return { user_id: data.user.id, email: data.user.email ?? "", store: st };
}

export const supabaseApi: RegistryApi = {
  modo: "supabase",
  auth: {
    session: sessaoAtual,
    async signIn(email, senha) {
      const { error } = await sb().auth.signInWithPassword({ email, password: senha });
      if (error) throw new DomainError("credenciais", "E-mail ou senha não conferem.", 401);
      return (await sessaoAtual())!;
    },
    async signUp(email, senha) {
      const { error } = await sb().auth.signUp({ email, password: senha });
      if (error) throw new DomainError("cadastro", error.message, 400);
      return (await sessaoAtual()) ?? { user_id: "", email, store: null };
    },
    async signOut() { await sb().auth.signOut(); },
    onChange(cb) {
      const { data } = sb().auth.onAuthStateChange(() => { sessaoAtual().then(cb); });
      return () => data.subscription.unsubscribe();
    },
  },
  loja: { criar: (dados) => fn("loja", { op: "criar", ...dados }) },
  identidade: {
    buscar: (documento) => fn("identidade", { op: "buscar", documento }),
    criar: (dados) => fn("identidade", { op: "criar", ...dados }),
  },
  aparelho: {
    buscarPorImei: (imei) => fn("aparelho", { op: "buscar_por_imei", imei }),
    criar: (dados) => fn("aparelho", { op: "criar", ...dados }),
  },
  transacao: {
    criar: ({ idempotency_key, ...dados }) => fn("transacao", { op: "criar", ...dados }, { headers: { "Idempotency-Key": idempotency_key } }),
    obter: (id) => fn("transacao", { op: "obter", transaction_id: id }),
    listar: () => fn("transacao", { op: "listar" }),
    mudarEstado: (id, novo) => fn("transacao", { op: "mudar_estado", transaction_id: id, novo_estado: novo }),
    congelarTermos: (id, termos) => fn("transacao", { op: "congelar_termos", transaction_id: id, ...termos }),
  },
  consulta: { executar: (transaction_id) => fn("consulta_procedencia", { transaction_id }) },
  midia: {
    async enviar(transaction_id, slot, arquivo) {
      const f = new FormData();
      f.append("transaction_id", transaction_id);
      f.append("slot", slot);
      f.append("arquivo", arquivo);
      return fnMultipart("midia", f);
    },
  },
  convite: { criar: (transaction_id, party_id) => fn("convite", { op: "criar", transaction_id, party_id }) },
  aceitePublico: {
    resumo: (token) => fn("aceite", { op: "resumo", token }, { publico: true }),
    pedirCodigo: (token) => fn("aceite", { op: "codigo", token }, { publico: true }),
    confirmar: (token, codigo) => fn("aceite", { op: "confirmar", token, codigo }, { publico: true }),
  },
  aceiteLoja: { registrar: (transaction_id, party_id) => fn("aceite_loja", { transaction_id, party_id, channel: "operator_pj" }) },
  aceiteAssistido: { registrar: (transaction_id, party_id, motivo) => fn("aceite_loja", { transaction_id, party_id, channel: "presencial_assistido", motivo }) },
  concluir: (transaction_id, idempotency_key) => fn("concluir", { transaction_id }, { headers: { "Idempotency-Key": idempotency_key } }),
  estoque: {
    listar: () => fn("transacao", { op: "estoque" }),
    partyDaLoja: () => fn("loja", { op: "party" }),
  },
  publico: {
    async passaporte(imei) {
      const { data, error } = await sb().rpc("public_device_passport", { p_imei: imei.replace(/\D/g, "") });
      if (error) throw new DomainError("passaporte", "Não foi possível consultar agora. Tente de novo.", 500);
      return data;
    },
    certificado: (protocolo) => fn("certificado", { op: "obter", protocolo }, { publico: true }),
  },
};
