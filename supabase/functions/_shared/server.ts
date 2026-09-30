// Infra comum das Edge Functions (Deno). CORS, JSON, sessão, loja, segredos.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { DomainError } from "./core/index.ts";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, idempotency-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

export function env(nome: string, obrigatorio = true): string {
  const v = Deno.env.get(nome) ?? "";
  if (!v && obrigatorio) throw new DomainError("config", `Falta configurar o segredo ${nome}.`, 500);
  return v;
}

export interface Ctx {
  admin: SupabaseClient;
  user: { id: string; email: string } | null;
  store: { id: string; name: string; party_id: string | null } | null;
  ip: string | null;
  userAgent: string | null;
}

/** Cliente com service_role — ignora RLS. Só existe dentro das Edge Functions. */
export function adminClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
}

export async function contexto(req: Request): Promise<Ctx> {
  const admin = adminClient();
  const auth = req.headers.get("Authorization") ?? "";
  let user: Ctx["user"] = null;
  let store: Ctx["store"] = null;
  const token = auth.replace(/^Bearer\s+/i, "");
  if (token && token !== env("SUPABASE_ANON_KEY", false)) {
    const { data } = await admin.auth.getUser(token);
    if (data.user) {
      user = { id: data.user.id, email: data.user.email ?? "" };
      const { data: m } = await admin.from("store_members").select("store_id, stores(id,name,party_id)").eq("user_id", user.id).limit(1).maybeSingle();
      const s = (m as { stores?: { id: string; name: string; party_id: string | null } } | null)?.stores;
      if (s) store = { id: s.id, name: s.name, party_id: s.party_id };
    }
  }
  return {
    admin, user, store,
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: req.headers.get("user-agent"),
  };
}

export function exigirLoja(ctx: Ctx): { user: NonNullable<Ctx["user"]>; store: NonNullable<Ctx["store"]> } {
  if (!ctx.user) throw new DomainError("sem_sessao", "Entre na sua conta para continuar.", 401);
  if (!ctx.store) throw new DomainError("sem_loja", "Cadastre a loja antes de registrar aparelhos.", 403);
  return { user: ctx.user, store: ctx.store };
}

export async function auditar(admin: SupabaseClient, store_id: string | null, actor_user_id: string | null, action: string, subject_type: string, subject_id: string | null, metadata: Record<string, unknown> = {}, ip: string | null = null) {
  await admin.from("registry_audit_events").insert({ store_id, actor_user_id, action, subject_type, subject_id, metadata, ip });
}

/** Erros de banco vindos de `raise exception 'codigo:mensagem'` viram DomainError. */
export function traduzirErroBanco(e: { message?: string; code?: string } | null): DomainError {
  const msg = e?.message ?? "";
  const m = msg.match(/^([a-z_]+):(.+)$/s);
  if (m) return new DomainError(m[1], m[2].trim(), 409);
  if (/registry_ownership_no_overlap/.test(msg)) return new DomainError("dois_donos", "Já existe um titular aberto para este aparelho.", 409);
  if (/append-only/.test(msg)) return new DomainError("append_only", "Este registro não pode ser alterado nem apagado. Corrija por um novo registro.", 409);
  if (/registry_device_identifiers_active_unique/.test(msg)) return new DomainError("imei_conflito", "Este IMEI já está ativo em outro aparelho.", 409);
  return new DomainError("banco", "Algo deu errado ao gravar. Tente de novo.", 500);
}

/** Envolve a função: OPTIONS, JSON e tradução de erro para o operador. */
export function servir(fn: (req: Request, ctx: Ctx, body: Record<string, unknown>) => Promise<unknown>) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    try {
      const ctx = await contexto(req);
      const ct = req.headers.get("content-type") ?? "";
      const body = ct.includes("application/json") ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
      const out = await fn(req, ctx, body);
      return json(out ?? {});
    } catch (e) {
      if (e instanceof DomainError) return json({ error: { code: e.code, message: e.message } }, e.status);
      console.error("erro inesperado", e instanceof Error ? e.message : e); // nunca registrar corpo de requisição aqui
      return json({ error: { code: "erro", message: "Algo deu errado. Tente de novo." } }, 500);
    }
  });
}

export function lancarSeErro(error: { message?: string; code?: string } | null): void {
  if (error) throw traduzirErroBanco(error);
}
