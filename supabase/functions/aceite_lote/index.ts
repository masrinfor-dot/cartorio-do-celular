// aceite_lote — ROTA PÚBLICA, SEM SESSÃO: a loja compradora aceita o lote inteiro
// no celular do responsável, com UM código. Não olha para quem está logado.
//   resumo → o mínimo (itens, IMEI mascarado, valores)   codigo → envia o código   confirmar
import {
  DomainError, OTP_MAX_ATTEMPTS, OTP_TTL_MS, formatarCentavos, gerarOtp, hashOtp, iguaisTempoConstante, impressaoDigitalLote, itemPodeEntrarNoConvite, onlyDigits, primeiroNome, sha256Hex,
} from "../_shared/core/index.ts";
import { adminClient, CORS, env, json, lancarSeErro } from "../_shared/server.ts";
import { deviceIdDaTx, deviceView, obterTx, telefoneDaParte, termosVigentes } from "../_shared/views.ts";
import { enviarWhatsapp } from "../_shared/whatsapp.ts";
import { avancarAposAceite } from "../_shared/ops.ts";

const INVALIDO = "Este link não é válido ou já foi usado. Peça um novo para a loja vendedora.";
const MUDOU = "O lote mudou depois que este link foi enviado. Peça um novo para a loja vendedora.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const admin = adminClient();
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const op = String(body.op ?? "");
    const token = String(body.token ?? "");
    if (!token) throw new DomainError("convite", INVALIDO, 404);
    const { data: inv } = await admin.from("registry_batch_invites").select("*").eq("token_hash", await sha256Hex(token)).maybeSingle();

    // Os itens do convite, o hash atual dos termos e se ainda estão no estado certo.
    async function itensDoConvite() {
      const txs = [];
      for (const id of inv!.transaction_ids as string[]) {
        const t = await obterTx(admin, id);
        const terms = await termosVigentes(admin, t);
        txs.push({ t, terms });
      }
      const intacto = txs.every((x) => x.terms && itemPodeEntrarNoConvite(x.t.state));
      const fp = intacto ? await impressaoDigitalLote(txs.map((x) => ({ transaction_id: x.t.id, terms_hash: x.terms!.content_hash }))) : "";
      return { txs, intacto, fp };
    }

    if (op === "resumo") {
      if (!inv) return json({ valido: false, motivo: INVALIDO });
      if (inv.revoked_at) return json({ valido: false, motivo: "Este link foi cancelado. Peça um novo para a loja vendedora." });
      if (new Date(inv.expires_at) < new Date()) return json({ valido: false, motivo: "Este link venceu. Peça um novo para a loja vendedora." });
      const { txs, intacto, fp } = await itensDoConvite();
      if (!inv.consumed_at && (!intacto || fp !== inv.fingerprint)) return json({ valido: false, motivo: MUDOU });
      const { data: lote } = await admin.from("registry_batches").select("store_id").eq("id", inv.batch_id).single();
      const { data: loja } = await admin.from("stores").select("name").eq("id", lote!.store_id).single();
      const { data: party } = await admin.from("registry_parties").select("display_name").eq("id", inv.party_id).single();
      const itens = [];
      let total = 0;
      for (const { t, terms } of txs) {
        const dv = await deviceView(admin, await deviceIdDaTx(admin, t.id));
        total += terms!.payload.valor_centavos;
        itens.push({ aparelho: [dv?.brand, dv?.model, dv?.storage, dv?.color].filter(Boolean).join(" "), imei_mascarado: dv?.imei_mascarado ?? "", valor: formatarCentavos(terms!.payload.valor_centavos) });
      }
      const p = txs[0].terms!.payload;
      return json({
        valido: true, aceito: !!inv.consumed_at, primeiro_nome: primeiroNome(party!.display_name as string), loja: loja!.name, itens, total: formatarCentavos(total),
        forma_pagamento: p.forma_pagamento, garantia: p.garantia || "sem garantia declarada", estado_aparelho: p.estado_aparelho || "não informado",
        impressao: inv.fingerprint.slice(0, 12), tentativas_restantes: Math.max(0, OTP_MAX_ATTEMPTS - (inv.otp_attempts as number)),
      });
    }

    if (!inv || inv.revoked_at) throw new DomainError("convite", INVALIDO, 404);

    if (op === "codigo") {
      if (inv.consumed_at) throw new DomainError("convite", INVALIDO, 404);
      const telefone = await telefoneDaParte(admin, inv.party_id);
      if (!telefone) throw new DomainError("sem_telefone", "Não há telefone para enviar o código. Fale com a loja vendedora.", 409);
      const codigo = gerarOtp();
      const { error } = await admin.from("registry_batch_invites").update({
        otp_hash: await hashOtp(env("REGISTRY_PII_PEPPER"), "lote:" + inv.id, codigo),
        otp_expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(), otp_attempts: 0, otp_sent_count: (inv.otp_sent_count as number) + 1,
      }).eq("id", inv.id);
      lancarSeErro(error);
      await enviarWhatsapp(telefone, `Seu código do Cartório do Celular: ${codigo}. Vale por 10 minutos. Não compartilhe com ninguém — nem com a loja vendedora.`);
      return json({ enviado: true, destino_mascarado: inv.destination_masked });
    }

    if (op === "confirmar") {
      if (inv.consumed_at) return json({ aceito: true });
      const { txs, intacto, fp } = await itensDoConvite();
      if (!intacto || fp !== inv.fingerprint) throw new DomainError("lote_mudou", MUDOU, 409);
      if (!inv.otp_hash || !inv.otp_expires_at) throw new DomainError("sem_codigo", "Peça o código primeiro.");
      if (new Date(inv.otp_expires_at) < new Date()) throw new DomainError("codigo_vencido", "O código venceu. Peça outro.");
      if ((inv.otp_attempts as number) >= OTP_MAX_ATTEMPTS) {
        await admin.from("registry_batch_invites").update({ revoked_at: new Date().toISOString(), revoked_reason: "tentativas" }).eq("id", inv.id);
        throw new DomainError("tentativas", "Muitas tentativas. Este link foi cancelado — peça um novo para a loja vendedora.", 429);
      }
      const h = await hashOtp(env("REGISTRY_PII_PEPPER"), "lote:" + inv.id, onlyDigits(String(body.codigo ?? "")));
      if (!iguaisTempoConstante(h, inv.otp_hash as string)) {
        const tentativas = (inv.otp_attempts as number) + 1;
        const rest = OTP_MAX_ATTEMPTS - tentativas;
        await admin.from("registry_batch_invites").update({ otp_attempts: tentativas, ...(rest <= 0 ? { revoked_at: new Date().toISOString(), revoked_reason: "tentativas" } : {}) }).eq("id", inv.id);
        if (rest <= 0) throw new DomainError("tentativas", "Muitas tentativas. Este link foi cancelado — peça um novo para a loja vendedora.", 429);
        throw new DomainError("codigo_errado", `Código não confere. ${rest === 1 ? "Última tentativa." : `Você ainda tem ${rest} tentativas.`}`);
      }
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
      for (const { t, terms } of txs) {
        const { error } = await admin.from("registry_transaction_acceptances").insert({
          transaction_id: t.id, party_id: inv.party_id, terms_version: terms!.version, terms_hash: terms!.content_hash, channel: "otp_whatsapp", ip, user_agent: req.headers.get("user-agent"),
          evidence: { batch_invite_id: inv.id, destino: inv.destination_masked, impressao: inv.fingerprint },
        });
        if (error && !/registry_acceptances_unique/.test(error.message ?? "")) lancarSeErro(error);
        await avancarAposAceite(admin, await obterTx(admin, t.id));
      }
      await admin.from("registry_batch_invites").update({ consumed_at: new Date().toISOString() }).eq("id", inv.id);
      return json({ aceito: true, itens: txs.length });
    }
    throw new DomainError("op", "Operação desconhecida.");
  } catch (e) {
    if (e instanceof DomainError) return json({ error: { code: e.code, message: e.message } }, e.status);
    console.error("aceite_lote: erro inesperado", e instanceof Error ? e.message : e);
    return json({ error: { code: "erro", message: "Algo deu errado. Tente de novo." } }, 500);
  }
});
