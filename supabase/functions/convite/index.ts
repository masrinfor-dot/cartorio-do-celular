// convite — "criar": gera o link de aceite para a PARTE (nunca para a loja),
// grava só o hash do token, envia pelo WhatsApp DA PARTE e devolve o link uma
// única vez. O código de 6 dígitos nasce depois, na rota pública, e nunca
// aparece em resposta nenhuma.
import { DomainError, INVITE_TTL_MS, gerarToken, mascararTelefone, sha256Hex } from "../_shared/core/index.ts";
import { auditar, env, exigirLoja, lancarSeErro, servir } from "../_shared/server.ts";
import { obterTx, partesDaTx, telefoneDaParte, termosVigentes } from "../_shared/views.ts";
import { enviarWhatsapp } from "../_shared/whatsapp.ts";

servir(async (_req, ctx, body) => {
  const { user, store } = exigirLoja(ctx);
  const admin = ctx.admin;
  if (body.op !== "criar") throw new DomainError("op", "Operação desconhecida.");
  const t = await obterTx(admin, String(body.transaction_id ?? ""), store.id);
  const party_id = String(body.party_id ?? "");
  const parte = (await partesDaTx(admin, t.id)).find((p) => p.party_id === party_id);
  if (!parte) throw new DomainError("parte", "Essa pessoa não faz parte desta transação.", 404);
  if (parte.is_tenant_side) throw new DomainError("convite_loja", "A loja tem canal próprio de aceite; o convite é para a outra parte.", 403);
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
    // Um convite vivo por parte e versão. O token não é recuperável (só hash),
    // então reenviar troca o hash — continua sendo UM convite.
    const { error } = await admin.from("registry_acceptance_invites").update({ token_hash }).eq("id", vivo.id);
    lancarSeErro(error);
    invite_id = vivo.id as string;
    reaproveitado = true;
  } else {
    if (vivo) await admin.from("registry_acceptance_invites").update({ revoked_at: agora.toISOString(), revoked_reason: "expirado" }).eq("id", vivo.id);
    const { data, error } = await admin.from("registry_acceptance_invites").insert({
      transaction_id: t.id, party_id, terms_version: terms.version, terms_hash: terms.content_hash, token_hash,
      destination_masked: mascararTelefone(telefone), expires_at: new Date(agora.getTime() + INVITE_TTL_MS).toISOString(), created_by: user.id,
    }).select("id").single();
    lancarSeErro(error);
    invite_id = data!.id as string;
  }

  const link = `${env("PUBLIC_APP_URL").replace(/\/$/, "")}/aceite/${token}`;
  await enviarWhatsapp(telefone, `Cartório do Celular — ${store.name} registrou a passagem do seu aparelho. Para confirmar, abra o link e informe o código que vai chegar aqui: ${link}`);
  await auditar(admin, store.id, user.id, "invite.sent", "invite", invite_id, { party_id, terms_version: terms.version, reaproveitado }, ctx.ip);
  return { invite_id, link, destino_mascarado: mascararTelefone(telefone), expires_at: new Date(agora.getTime() + INVITE_TTL_MS).toISOString(), reaproveitado };
});
