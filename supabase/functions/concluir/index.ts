// concluir — confere idempotência e chama registry_complete_transaction, que faz
// os nove passos dentro de UMA transação de banco. Se qualquer passo falhar,
// nada acontece. A constraint de exclusão impede dois donos; se o banco
// recusar, o erro é mostrado — nunca contornado.
import { DomainError, descreverFaltantes, hashTerms, sha256Hex } from "../_shared/core/index.ts";
import { exigirLoja, servir, traduzirErroBanco } from "../_shared/server.ts";
import { obterTx, statusAceite, termosVigentes } from "../_shared/views.ts";
import { montarCertificado } from "../_shared/certificado.ts";

servir(async (req, ctx, body) => {
  const { user, store } = exigirLoja(ctx);
  const admin = ctx.admin;
  const transaction_id = String(body.transaction_id ?? "");
  const key = req.headers.get("Idempotency-Key") ?? "";
  if (!key) throw new DomainError("idempotencia", "Falta o cabeçalho Idempotency-Key.");
  const request_hash = await sha256Hex(JSON.stringify({ transaction_id }));
  const { data: idem } = await admin.from("registry_idempotency_keys").select("request_hash, response").eq("scope", "tx.complete").eq("key", key).eq("store_id", store.id).maybeSingle();
  if (idem) {
    if (idem.request_hash !== request_hash) throw new DomainError("idempotencia_conflito", "Esta chave já foi usada com dados diferentes.", 409);
    return { ...(idem.response as Record<string, unknown>), repetida: true };
  }

  const t = await obterTx(admin, transaction_id, store.id);
  const terms = await termosVigentes(admin, t);
  if (!terms) throw new DomainError("sem_termos", "Confirme as condições antes de concluir.", 409);
  const st = await statusAceite(admin, t);
  if (!st.complete) throw new DomainError("aceite_incompleto", descreverFaltantes(st), 409);

  const { data, error } = await admin.rpc("registry_complete_transaction", {
    p_transaction_id: t.id, p_actor_user_id: user.id, p_grade: st.grade, p_terms_hash: terms.content_hash,
  });
  if (error) throw traduzirErroBanco(error);
  const r = data as { protocolo: string; grade: string; completed_at: string; repetida: boolean };

  // Certificado: conteúdo determinístico → mesmo hash sempre.
  const conteudo = await montarCertificado(admin, t.id);
  const content_hash = await hashTerms(conteudo);
  await admin.from("registry_certificates").insert({ transaction_id: t.id, protocol: r.protocolo, content_hash });
  await admin.from("registry_idempotency_keys").insert({ scope: "tx.complete", key, store_id: store.id, request_hash, response: r });
  return { ...r, repetida: false };
});
