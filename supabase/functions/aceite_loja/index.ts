// aceite_loja — o aceite que o OPERADOR registra:
//   channel 'operator_pj'          → só para a parte que É a loja (403 para o resto)
//   channel 'presencial_assistido' → exceção com cinco travas (regra 9 do dossiê)
import { DomainError, exigirAceiteAssistidoPermitido } from "../_shared/core/index.ts";
import { auditar, exigirLoja, lancarSeErro, servir } from "../_shared/server.ts";
import { mudarEstado, obterTx, partesDaTx, statusAceite, termosVigentes } from "../_shared/views.ts";

servir(async (_req, ctx, body) => {
  const { user, store } = exigirLoja(ctx);
  const admin = ctx.admin;
  const t = await obterTx(admin, String(body.transaction_id ?? ""), store.id);
  const party_id = String(body.party_id ?? "");
  const channel = String(body.channel ?? "operator_pj");
  const parte = (await partesDaTx(admin, t.id)).find((p) => p.party_id === party_id);
  if (!parte) throw new DomainError("parte", "Essa pessoa não faz parte desta transação.", 404);
  const terms = await termosVigentes(admin, t);
  if (!terms) throw new DomainError("sem_termos", "Confirme as condições antes de aceitar.", 409);

  let evidence: Record<string, unknown>;
  let inviteParaQueimar: string | null = null;

  if (channel === "operator_pj") {
    if (!parte.is_tenant_side) throw new DomainError("aceite_pelo_cliente", "O operador não assina pelo cliente. O aceite dele vem pelo celular dele.", 403);
    evidence = { operator_user_id: user.id };
  } else if (channel === "presencial_assistido") {
    const { data: inv } = await admin.from("registry_acceptance_invites").select("id, party_id, terms_version, terms_hash, consumed_at, revoked_at, expires_at, destination_masked")
      .eq("transaction_id", t.id).eq("party_id", party_id).eq("terms_version", terms.version).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const motivo = String(body.motivo ?? "");
    exigirAceiteAssistidoPermitido({ party: parte, invite: inv ? { id: inv.id, party_id: inv.party_id, terms_version: inv.terms_version, terms_hash: inv.terms_hash, consumed_at: inv.consumed_at, revoked_at: inv.revoked_at, expires_at: inv.expires_at } : null, termsVersion: terms.version, reason: motivo, operatorUserId: user.id });
    evidence = { reason: motivo.trim(), operator_user_id: user.id, invite_id: inv!.id, destino: inv!.destination_masked };
    inviteParaQueimar = inv!.id as string;
  } else {
    throw new DomainError("canal", "Canal de aceite inválido para o operador.");
  }

  const { error } = await admin.from("registry_transaction_acceptances").insert({
    transaction_id: t.id, party_id, terms_version: terms.version, terms_hash: terms.content_hash, channel, ip: ctx.ip, user_agent: ctx.userAgent, evidence,
  });
  if (error && !/registry_acceptances_unique/.test(error.message ?? "")) lancarSeErro(error);
  if (inviteParaQueimar) {
    // Queima o convite: dois caminhos abertos para a mesma assinatura registram duas vezes.
    await admin.from("registry_acceptance_invites").update({ revoked_at: new Date().toISOString(), revoked_reason: "aceite_presencial_assistido" }).eq("id", inviteParaQueimar);
    await auditar(admin, store.id, user.id, "acceptance.assisted", "transaction", t.id, { reason: evidence.reason, invite_id: inviteParaQueimar }, ctx.ip);
  }

  const st = await statusAceite(admin, t);
  const sellerOk = st.accepted.some((p) => p.role === "seller");
  const buyerOk = st.accepted.some((p) => p.role === "buyer");
  if (st.complete && t.state !== "ready_to_complete") {
    if (t.state === "awaiting_seller") await mudarEstado(admin, t, "awaiting_buyer");
    if (t.state === "awaiting_buyer") await mudarEstado(admin, t, "ready_to_complete");
  } else if (sellerOk && !buyerOk && t.state === "awaiting_seller") {
    await mudarEstado(admin, t, "awaiting_buyer");
  }
  return st;
});
