// certificado — PÚBLICO: "obter" valida um protocolo e devolve o conteúdo
// (sem PII: IMEI mascarado, nomes curtos). Protocolo inexistente: uma frase,
// sem dizer quantos existem, sem sugerir parecidos.
import { DomainError, hashTerms } from "../_shared/core/index.ts";
import { adminClient, CORS, json } from "../_shared/server.ts";
import { montarCertificado } from "../_shared/certificado.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.op !== "obter") throw new DomainError("op", "Operação desconhecida.");
    const protocolo = String(body.protocolo ?? "").trim().toUpperCase();
    if (!/^[A-Z2-9]{10}$/.test(protocolo)) return json(null);
    const admin = adminClient();
    const { data: t } = await admin.from("registry_transactions").select("id").eq("public_protocol", protocolo).eq("state", "completed").maybeSingle();
    if (!t) return json(null);
    const conteudo = await montarCertificado(admin, t.id as string);
    return json({ ...conteudo, content_hash: await hashTerms(conteudo) });
  } catch (e) {
    if (e instanceof DomainError) return json({ error: { code: e.code, message: e.message } }, e.status);
    console.error("certificado: erro inesperado", e instanceof Error ? e.message : e);
    return json({ error: { code: "erro", message: "Algo deu errado. Tente de novo." } }, 500);
  }
});
