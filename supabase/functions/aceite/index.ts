// aceite — ROTA PÚBLICA, SEM SESSÃO, de propósito. É aberta pelo cliente no
// celular dele. Não olha para quem está logado: é isso que impede o operador
// de completar o aceite pelo cliente.
//   op "resumo"   → o mínimo: primeiro nome, IMEI mascarado, valor, termos
//   op "codigo"   → gera o código, grava só o HMAC, envia para o WhatsApp da parte
//   op "confirmar"→ compara em tempo constante; 5 erros queimam; 10 min
import {
  DomainError, OTP_MAX_ATTEMPTS, OTP_TTL_MS, formatarCentavos, gerarOtp, hashOtp, iguaisTempoConstante, onlyDigits, primeiroNome, sha256Hex,
} from "../_shared/core/index.ts";
import { adminClient, CORS, env, json, lancarSeErro } from "../_shared/server.ts";
import { deviceIdDaTx, deviceView, mudarEstado, obterTx, partesDaTx, statusAceite, telefoneDaParte, termosVigentes } from "../_shared/views.ts";
import { enviarWhatsapp } from "../_shared/whatsapp.ts";

const INVALIDO = "Este link não é válido ou já foi usado. Peça um novo para a loja.";
const MUDOU = "As condições mudaram depois que este link foi enviado. Peça um novo para a loja.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const admin = adminClient(); // service_role, mas NENHUMA leitura de sessão do chamador
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const op = String(body.op ?? "");
    const token = String(body.token ?? "");
    if (!token) throw new DomainError("convite", INVALIDO, 404);
    const { data: inv } = await admin.from("registry_acceptance_invites").select("*").eq("token_hash", await sha256Hex(token)).maybeSingle();

    if (op === "resumo") {
      if (!inv) return json({ valido: false, motivo: INVALIDO });
      const t = await obterTx(admin, inv.transaction_id);
      const terms = await termosVigentes(admin, t);
      if (!terms || terms.version !== inv.terms_version || terms.content_hash !== inv.terms_hash) return json({ valido: false, motivo: MUDOU });
      if (inv.revoked_at) return json({ valido: false, motivo: "Este link foi cancelado. Peça um novo para a loja." });
      if (new Date(inv.expires_at) < new Date()) return json({ valido: false, motivo: "Este link venceu. Peça um novo para a loja." });
      const parte = (await partesDaTx(admin, t.id)).find((p) => p.party_id === inv.party_id)!;
      const { data: party } = await admin.from("registry_parties").select("display_name").eq("id", inv.party_id).single();
      const dv = await deviceView(admin, await deviceIdDaTx(admin, t.id));
      const { data: loja } = await admin.from("stores").select("name").eq("id", t.store_id).single();
      const p = terms.payload;
      return json({
        valido: true,
        aceito: !!inv.consumed_at,
        primeiro_nome: primeiroNome(party!.display_name as string),
        papel: parte.role,
        loja: loja!.name,
        imei_mascarado: dv?.imei_mascarado,
        aparelho: [dv?.brand, dv?.model, dv?.storage, dv?.color].filter(Boolean).join(" "),
        valor: formatarCentavos(p.valor_centavos),
        forma_pagamento: p.forma_pagamento,
        resumo_termos: [
          `Estado declarado: ${p.estado_aparelho || "não informado"}`,
          p.defeitos ? `Defeitos declarados: ${p.defeitos}` : "Sem defeitos declarados",
          p.garantia ? `Garantia: ${p.garantia}` : "Sem garantia declarada",
          `Termos versão ${terms.version} · ${terms.content_hash.slice(0, 12)}…`,
        ],
        tentativas_restantes: Math.max(0, OTP_MAX_ATTEMPTS - (inv.otp_attempts as number)),
      });
    }

    if (!inv || inv.revoked_at) throw new DomainError("convite", INVALIDO, 404);

    if (op === "codigo") {
      if (inv.consumed_at) throw new DomainError("convite", INVALIDO, 404);
      const telefone = await telefoneDaParte(admin, inv.party_id);
      if (!telefone) throw new DomainError("sem_telefone", "Não há telefone para enviar o código. Fale com a loja.", 409);
      const codigo = gerarOtp();
      const { error } = await admin.from("registry_acceptance_invites").update({
        otp_hash: await hashOtp(env("REGISTRY_PII_PEPPER"), inv.id, codigo),
        otp_expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
        otp_attempts: 0,
        otp_sent_count: (inv.otp_sent_count as number) + 1,
      }).eq("id", inv.id);
      lancarSeErro(error);
      await enviarWhatsapp(telefone, `Seu código do Cartório do Celular: ${codigo}. Vale por 10 minutos. Não compartilhe com ninguém — nem com a loja.`);
      return json({ enviado: true, destino_mascarado: inv.destination_masked }); // o código NÃO volta
    }

    if (op === "confirmar") {
      if (inv.consumed_at) return json({ aceito: true });
      const t = await obterTx(admin, inv.transaction_id);
      const terms = await termosVigentes(admin, t);
      if (!terms || terms.version !== inv.terms_version || terms.content_hash !== inv.terms_hash) throw new DomainError("termos_mudaram", MUDOU, 409);
      if (!inv.otp_hash || !inv.otp_expires_at) throw new DomainError("sem_codigo", "Peça o código primeiro.");
      if (new Date(inv.otp_expires_at) < new Date()) throw new DomainError("codigo_vencido", "O código venceu. Peça outro.");
      if ((inv.otp_attempts as number) >= OTP_MAX_ATTEMPTS) {
        await admin.from("registry_acceptance_invites").update({ revoked_at: new Date().toISOString(), revoked_reason: "tentativas" }).eq("id", inv.id);
        throw new DomainError("tentativas", "Muitas tentativas. Este link foi cancelado — peça um novo para a loja.", 429);
      }
      const h = await hashOtp(env("REGISTRY_PII_PEPPER"), inv.id, onlyDigits(String(body.codigo ?? "")));
      if (!iguaisTempoConstante(h, inv.otp_hash as string)) {
        const tentativas = (inv.otp_attempts as number) + 1;
        const rest = OTP_MAX_ATTEMPTS - tentativas;
        await admin.from("registry_acceptance_invites").update({ otp_attempts: tentativas, ...(rest <= 0 ? { revoked_at: new Date().toISOString(), revoked_reason: "tentativas" } : {}) }).eq("id", inv.id);
        if (rest <= 0) throw new DomainError("tentativas", "Muitas tentativas. Este link foi cancelado — peça um novo para a loja.", 429);
        throw new DomainError("codigo_errado", `Código não confere. ${rest === 1 ? "Última tentativa." : `Você ainda tem ${rest} tentativas.`}`);
      }
      const { error: eAcc } = await admin.from("registry_transaction_acceptances").insert({
        transaction_id: t.id, party_id: inv.party_id, terms_version: terms.version, terms_hash: terms.content_hash, channel: "otp_whatsapp",
        ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, user_agent: req.headers.get("user-agent"),
        evidence: { invite_id: inv.id, destino: inv.destination_masked },
      });
      if (eAcc && !/registry_acceptances_unique/.test(eAcc.message ?? "")) lancarSeErro(eAcc);
      await admin.from("registry_acceptance_invites").update({ consumed_at: new Date().toISOString() }).eq("id", inv.id);
      await avancar(admin, t);
      return json({ aceito: true });
    }

    throw new DomainError("op", "Operação desconhecida.");
  } catch (e) {
    if (e instanceof DomainError) return json({ error: { code: e.code, message: e.message } }, e.status);
    console.error("aceite: erro inesperado", e instanceof Error ? e.message : e);
    return json({ error: { code: "erro", message: "Algo deu errado. Tente de novo." } }, 500);
  }
});

async function avancar(admin: ReturnType<typeof adminClient>, t: Awaited<ReturnType<typeof obterTx>>) {
  const st = await statusAceite(admin, t);
  const sellerOk = st.accepted.some((p) => p.role === "seller");
  const buyerOk = st.accepted.some((p) => p.role === "buyer");
  if (st.complete && t.state !== "ready_to_complete") {
    if (t.state === "awaiting_seller") await mudarEstado(admin, t, "awaiting_buyer");
    if (t.state === "awaiting_buyer") await mudarEstado(admin, t, "ready_to_complete");
  } else if (sellerOk && !buyerOk && t.state === "awaiting_seller") {
    await mudarEstado(admin, t, "awaiting_buyer");
  }
}
