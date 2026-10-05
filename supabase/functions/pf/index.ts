// pf — Portal da pessoa física ("Meus aparelhos"). PÚBLICA no sentido de não
// usar a sessão da loja: a PF tem sessão própria (cabeçalho X-PF-Token), obtida
// por CPF + código enviado ao WhatsApp JÁ CADASTRADO para aquele CPF.
//   sessao · pedir_codigo · confirmar · meus_aparelhos · transacao · iniciar_venda ·
//   (multipart) foto · reenviar_convite · confirmar_venda · cancelar_venda ·
//   comunicar_venda · registrar_ocorrencia · retirar_ocorrencia
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  DomainError, OTP_MAX_ATTEMPTS, expiraEm, garantiaDe, OTP_TTL_MS, UNIQUE_MEDIA_SLOTS, cifrar, cpfValido, detectarTipo, gerarOtp, gerarProtocolo, gerarToken, hashDocumento, hashOtp,
  hashTerms, iguaisTempoConstante, mascararTelefone, nomeCurto, onlyDigits, primeiroNome, removerMetadados, sha256Hex, type MediaSlot, type TermsPayload,
} from "../_shared/core/index.ts";
import { adminClient, auditar, CORS, env, json, lancarSeErro } from "../_shared/server.ts";
import { deviceView, mudarEstado, obterTx, ocorrenciaAtiva, partesDaTx, partyView, statusAceite, telefoneDaParte, termosVigentes, txView, type TxRow } from "../_shared/views.ts";
import { concluir, criarConvite, executarConsulta, expirarSeParada } from "../_shared/ops.ts";
import { enviarWhatsapp } from "../_shared/whatsapp.ts";

const SESSAO_DIAS = 30;
type Sessao = { party_id: string; display_name: string };

async function sessaoDoToken(admin: SupabaseClient, req: Request): Promise<Sessao | null> {
  const tok = req.headers.get("X-PF-Token") ?? "";
  if (!tok) return null;
  const { data } = await admin.from("pf_sessions").select("party_id, expires_at").eq("token_hash", await sha256Hex(tok)).maybeSingle();
  if (!data || new Date(data.expires_at as string) < new Date()) return null;
  const pv = await partyView(admin, data.party_id as string);
  return { party_id: pv.party_id, display_name: pv.display_name };
}
async function exigirPf(admin: SupabaseClient, req: Request): Promise<Sessao> {
  const s = await sessaoDoToken(admin, req);
  if (!s) throw new DomainError("sem_sessao_pf", "Entre com seu CPF para continuar.", 401);
  return s;
}
function pfView(s: Sessao, tel: string | null) {
  return { party_id: s.party_id, display_name: s.display_name, primeiro_nome: primeiroNome(s.display_name), telefone_mascarado: tel ? mascararTelefone(tel) : "" };
}
async function exigirTitular(admin: SupabaseClient, party_id: string, device_id: string) {
  const { data } = await admin.from("registry_ownership_periods").select("party_id").eq("device_id", device_id).is("ended_at", null).maybeSingle();
  if (!data || data.party_id !== party_id) throw new DomainError("nao_titular", "Você não é o titular registrado deste aparelho.", 403);
}
async function txDaPf(admin: SupabaseClient, transaction_id: string, party_id: string): Promise<TxRow> {
  const t = await obterTx(admin, transaction_id);
  if (!(await partesDaTx(admin, t.id)).some((p) => p.party_id === party_id)) throw new DomainError("tx_inexistente", "Transação não encontrada.", 404);
  return t;
}
/** Pessoa canônica sem vínculo de loja (comprador informado pelo vendedor). */
async function pessoaPorCpf(admin: SupabaseClient, cpf: string, nome: string | null, telefone: string | null): Promise<string> {
  const d = onlyDigits(cpf);
  if (!cpfValido(d)) throw new DomainError("cpf", "Esse CPF não confere. Confira os dígitos.");
  const hash = await hashDocumento(env("REGISTRY_PII_PEPPER"), d);
  const { data: ident } = await admin.from("registry_party_identifiers").select("party_id").eq("value_hash", hash).maybeSingle();
  let party_id: string;
  if (ident) party_id = ident.party_id as string;
  else {
    if (!nome?.trim()) throw new DomainError("nome", "Informe o nome de quem está comprando.");
    const { data: p, error } = await admin.from("registry_parties").insert({ kind: "pf", display_name: nome.trim() }).select("id").single();
    lancarSeErro(error);
    party_id = p!.id as string;
    await admin.from("registry_party_identifiers").insert({ party_id, type: "cpf", value_hash: hash, value_encrypted: await cifrar(env("REGISTRY_PII_KEY"), d) });
  }
  const tel = onlyDigits(telefone ?? "");
  if (tel.length >= 10) {
    const { data: ja } = await admin.from("registry_party_contacts").select("id").eq("party_id", party_id).eq("kind", "phone").eq("value", tel).maybeSingle();
    if (!ja) await admin.from("registry_party_contacts").insert({ party_id, kind: "phone", value: tel });
  }
  return party_id;
}
async function intencaoAberta(admin: SupabaseClient, party_id: string, device_id: string) {
  const { data } = await admin.from("registry_transaction_devices").select("transaction_id, registry_transactions!inner(id, kind, state, store_id)").eq("device_id", device_id);
  for (const r of data ?? []) {
    const t = (r as unknown as { registry_transactions: { id: string; kind: string; state: string } }).registry_transactions;
    if (t.kind !== "pf_pf" || ["completed", "cancelled", "expired", "disputed"].includes(t.state)) continue;
    // Parada além do prazo: expira aqui mesmo, sem esperar a rotina diária.
    if (await expirarSeParada(admin, await obterTx(admin, t.id))) continue;
    const parts = await partesDaTx(admin, t.id);
    if (parts.some((p) => p.party_id === party_id && p.role === "seller")) return t.id;
  }
  return null;
}
async function novaTxPf(admin: SupabaseClient, seller: string, buyer: string, device_id: string, payload: TermsPayload): Promise<TxRow> {
  const { data: t, error } = await admin.from("registry_transactions").insert({ store_id: null, kind: "pf_pf", state: "awaiting_data", public_protocol: gerarProtocolo(), origin: "portal_pf" }).select("*").single();
  lancarSeErro(error);
  const tx = t as TxRow;
  await admin.from("registry_transaction_parties").insert([{ transaction_id: tx.id, party_id: seller, role: "seller", is_tenant_side: false }, { transaction_id: tx.id, party_id: buyer, role: "buyer", is_tenant_side: false }]);
  await admin.from("registry_transaction_devices").insert({ transaction_id: tx.id, device_id });
  const content_hash = await hashTerms(payload);
  await admin.from("registry_transaction_terms").insert({ transaction_id: tx.id, version: 1, payload, content_hash });
  await admin.from("registry_transactions").update({ current_terms_version: 1 }).eq("id", tx.id);
  tx.current_terms_version = 1;
  await executarConsulta(admin, { store: null, user: null, ip: null }, tx);
  return tx;
}
async function avancar(admin: SupabaseClient, t: TxRow) {
  const st = await statusAceite(admin, t);
  const sellerOk = st.accepted.some((p) => p.role === "seller");
  const buyerOk = st.accepted.some((p) => p.role === "buyer");
  if (st.complete && t.state !== "ready_to_complete") {
    if (t.state === "awaiting_seller") await mudarEstado(admin, t, "awaiting_buyer");
    if (t.state === "awaiting_buyer") await mudarEstado(admin, t, "ready_to_complete");
  } else if (sellerOk && !buyerOk && t.state === "awaiting_seller") await mudarEstado(admin, t, "awaiting_buyer");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const admin = adminClient();
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  try {
    const ct = req.headers.get("content-type") ?? "";

    // Foto (multipart) — venda entre pessoas
    if (ct.includes("multipart/form-data")) {
      const s = await exigirPf(admin, req);
      const form = await req.formData();
      const t = await txDaPf(admin, String(form.get("transaction_id") ?? ""), s.party_id);
      if (t.state === "completed") throw new DomainError("tx_encerrada", "Esta venda já foi concluída.", 409);
      const slot = String(form.get("slot") ?? "") as MediaSlot;
      const arquivo = form.get("arquivo");
      if (!(arquivo instanceof File) || arquivo.size === 0) throw new DomainError("foto", "Envie a foto.");
      const original = new Uint8Array(await arquivo.arrayBuffer());
      const tipo = detectarTipo(original);
      if (!tipo) throw new DomainError("tipo", "O arquivo não é uma foto (JPEG, PNG, WebP ou HEIC).");
      const { bytes } = removerMetadados(original, tipo);
      const sha256 = await sha256Hex(bytes);
      const { data: dev } = await admin.from("registry_transaction_devices").select("device_id").eq("transaction_id", t.id).single();
      const storage_key = `pf/${t.id}/${slot}-${sha256.slice(0, 16)}.${{ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic" }[tipo]}`;
      const { error: eUp } = await admin.storage.from("registry-media").upload(storage_key, bytes, { contentType: tipo, upsert: true });
      if (eUp) throw new DomainError("storage", "Não foi possível guardar a foto. Tente de novo.", 500);
      if (UNIQUE_MEDIA_SLOTS.includes(slot)) await admin.from("registry_device_media").delete().eq("transaction_id", t.id).eq("slot", slot);
      const { data: m, error } = await admin.from("registry_device_media").insert({ device_id: dev!.device_id, store_id: null, transaction_id: t.id, slot, storage_key, sha256, mime: tipo, bytes: bytes.length }).select("id").single();
      lancarSeErro(error);
      const { data: signed } = await admin.storage.from("registry-media").createSignedUrl(storage_key, 60);
      return json({ media_id: m!.id, slot, sha256, url: signed?.signedUrl ?? "" });
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const op = String(body.op ?? "");

    if (op === "sessao") {
      const s = await sessaoDoToken(admin, req);
      return json(s ? pfView(s, await telefoneDaParte(admin, s.party_id)) : null);
    }

    if (op === "pedir_codigo") {
      const d = onlyDigits(String(body.cpf ?? ""));
      const tel = onlyDigits(String(body.telefone ?? ""));
      const nome = String(body.nome ?? "").trim() || null;
      if (!cpfValido(d)) throw new DomainError("cpf", "Esse CPF não confere. Confira os dígitos.");
      if (tel.length < 10) throw new DomainError("telefone", "Informe o WhatsApp com DDD.");
      const hash = await hashDocumento(env("REGISTRY_PII_PEPPER"), d);
      const { data: ident } = await admin.from("registry_party_identifiers").select("party_id").eq("value_hash", hash).maybeSingle();
      let novo = false;
      if (ident) {
        // Só o telefone JÁ CADASTRADO para este CPF recebe o código.
        const { data: fones } = await admin.from("registry_party_contacts").select("value").eq("party_id", ident.party_id).eq("kind", "phone");
        const lista = (fones ?? []).map((f) => f.value as string);
        if (!lista.length) throw new DomainError("sem_telefone", "Este CPF não tem WhatsApp cadastrado. Procure a loja onde registrou o aparelho.", 403);
        if (!lista.includes(tel)) throw new DomainError("telefone_divergente", "Este WhatsApp não é o cadastrado para este CPF. Use o número que você deu na loja onde registrou o aparelho.", 403);
      } else {
        if (!nome) throw new DomainError("nome", "Primeiro acesso: informe seu nome completo.");
        novo = true;
      }
      const codigo = gerarOtp();
      const { error } = await admin.from("pf_otps").upsert({ cpf_hash: hash, phone: tel, nome, otp_hash: await hashOtp(env("REGISTRY_PII_PEPPER"), "pf:" + hash, codigo), expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(), attempts: 0, created_at: new Date().toISOString() }, { onConflict: "cpf_hash" });
      lancarSeErro(error);
      await enviarWhatsapp(tel, `Seu código de acesso ao Cartório do Celular: ${codigo}. Vale por 10 minutos. Não compartilhe com ninguém.`);
      // O CPF em claro só existe nesta chamada; o cliente reenvia na confirmação.
      return json({ destino_mascarado: mascararTelefone(tel), novo_cadastro: novo });
    }

    if (op === "confirmar") {
      const d = onlyDigits(String(body.cpf ?? ""));
      const hash = await hashDocumento(env("REGISTRY_PII_PEPPER"), d);
      const { data: otp } = await admin.from("pf_otps").select("*").eq("cpf_hash", hash).maybeSingle();
      if (!otp) throw new DomainError("sem_codigo", "Peça o código primeiro.");
      if (new Date(otp.expires_at as string) < new Date()) throw new DomainError("codigo_vencido", "O código venceu. Peça outro.");
      if ((otp.attempts as number) >= OTP_MAX_ATTEMPTS) throw new DomainError("tentativas", "Muitas tentativas. Peça um código novo.", 429);
      const h = await hashOtp(env("REGISTRY_PII_PEPPER"), "pf:" + hash, onlyDigits(String(body.codigo ?? "")));
      if (!iguaisTempoConstante(h, otp.otp_hash as string)) {
        await admin.from("pf_otps").update({ attempts: (otp.attempts as number) + 1 }).eq("cpf_hash", hash);
        throw new DomainError("codigo_errado", `Código não confere. Você ainda tem ${Math.max(0, OTP_MAX_ATTEMPTS - (otp.attempts as number) - 1)} tentativas.`);
      }
      const party_id = await pessoaPorCpf(admin, d, otp.nome as string | null, otp.phone as string);
      const token = gerarToken();
      await admin.from("pf_sessions").insert({ token_hash: await sha256Hex(token), party_id, expires_at: new Date(Date.now() + SESSAO_DIAS * 86400000).toISOString() });
      await admin.from("pf_otps").delete().eq("cpf_hash", hash);
      await auditar(admin, null, null, "pf.login", "party", party_id, {}, ip);
      const pv = await partyView(admin, party_id);
      return json({ token, sessao: pfView({ party_id, display_name: pv.display_name }, otp.phone as string) });
    }

    const s = await exigirPf(admin, req);
    const base = env("PUBLIC_APP_URL").replace(/\/$/, "");

    if (op === "meus_aparelhos") {
      const { data: per } = await admin.from("registry_ownership_periods").select("device_id, started_at, transaction_id").eq("party_id", s.party_id).is("ended_at", null).order("started_at", { ascending: false });
      const out = [];
      for (const o of per ?? []) {
        const tEnt = o.transaction_id ? await obterTx(admin, o.transaction_id as string).catch(() => null) : null;
        const intId = await intencaoAberta(admin, s.party_id, o.device_id as string);
        let intencao = null;
        if (intId) {
          const it = await obterTx(admin, intId);
          const st = await statusAceite(admin, it);
          const buyer = (await partesDaTx(admin, it.id)).find((p) => p.role === "buyer")!;
          const terms = await termosVigentes(admin, it);
          intencao = { transaction_id: it.id, state: it.state, comprador: nomeCurto((await partyView(admin, buyer.party_id)).display_name), comprador_aceitou: st.accepted.some((p) => p.role === "buyer"), vendedor_confirmou: st.accepted.some((p) => p.role === "seller"), declarada: terms?.payload.declaracoes?.origem === "comunicacao_de_venda", expira_em: expiraEm(it.updated_at) };
        }
        const termosEnt = tEnt?.state === "completed" ? await termosVigentes(admin, tEnt) : null;
        out.push({ device: await deviceView(admin, o.device_id as string), desde: o.started_at, protocolo_entrada: tEnt?.public_protocol ?? null, link_certificado: tEnt?.state === "completed" ? `${base}/certificado/${tEnt.public_protocol}` : null, intencao, garantia: termosEnt ? garantiaDe(tEnt!.completed_at, termosEnt.payload.garantia) : null, ocorrencia_ativa: await ocorrenciaAtiva(admin, o.device_id as string) });
      }
      return json(out);
    }

    if (op === "transacao") return json(await txView(admin, await txDaPf(admin, String(body.transaction_id ?? ""), s.party_id)));

    if (op === "iniciar_venda") {
      const device_id = String(body.device_id ?? "");
      await exigirTitular(admin, s.party_id, device_id);
      if (await ocorrenciaAtiva(admin, device_id)) throw new DomainError("ocorrencia_ativa", "Há uma declaração de furto/roubo ativa para este aparelho. Retire a declaração antes de vender.", 409);
      if (await intencaoAberta(admin, s.party_id, device_id)) throw new DomainError("intencao_aberta", "Já existe uma venda em andamento para este aparelho. Conclua ou cancele antes de abrir outra.", 409);
      const valor = Math.round(Number(body.valor_centavos));
      if (!(valor > 0)) throw new DomainError("valor", "Informe o valor.");
      const c = (body.comprador ?? {}) as Record<string, string>;
      const buyer = await pessoaPorCpf(admin, c.cpf ?? "", c.nome ?? null, c.telefone ?? null);
      if (buyer === s.party_id) throw new DomainError("mesma_pessoa", "O comprador não pode ser você mesmo.");
      if (!(await telefoneDaParte(admin, buyer))) throw new DomainError("telefone", "Informe o WhatsApp do comprador — é por ele que o aceite chega.");
      const t = await novaTxPf(admin, s.party_id, buyer, device_id, { valor_centavos: valor, forma_pagamento: String(body.forma_pagamento ?? "") || "não informada", estado_aparelho: String(body.estado_aparelho ?? "") || "não informado", defeitos: String(body.defeitos ?? ""), garantia: "", declaracoes: { origem: "venda_entre_pessoas" } });
      if (t.state === "awaiting_seller") await mudarEstado(admin, t, "awaiting_buyer");
      await criarConvite(admin, { store: null, user: null, ip }, t, buyer, `${nomeCurto(s.display_name)} quer transferir um aparelho para você pelo Cartório do Celular`);
      await auditar(admin, null, null, "pf.sale_intent", "transaction", t.id, { seller: s.party_id }, ip);
      return json(await txView(admin, t));
    }

    if (op === "reenviar_convite") {
      const t = await txDaPf(admin, String(body.transaction_id ?? ""), s.party_id);
      const buyer = (await partesDaTx(admin, t.id)).find((p) => p.role === "buyer")!;
      return json(await criarConvite(admin, { store: null, user: null, ip }, t, buyer.party_id, `${nomeCurto(s.display_name)} quer transferir um aparelho para você pelo Cartório do Celular`));
    }

    if (op === "confirmar_venda") {
      const t = await txDaPf(admin, String(body.transaction_id ?? ""), s.party_id);
      if (t.state === "completed") return json({ protocolo: t.public_protocol, grade: (await statusAceite(admin, t)).grade, completed_at: t.completed_at, repetida: true });
      const st = await statusAceite(admin, t);
      if (!st.accepted.some((p) => p.role === "buyer")) throw new DomainError("comprador_pendente", "O comprador ainda não aceitou no celular dele. Você confirma por último — depois de ver o aceite dele.", 409);
      const terms = (await termosVigentes(admin, t))!;
      const { error } = await admin.from("registry_transaction_acceptances").insert({ transaction_id: t.id, party_id: s.party_id, terms_version: terms.version, terms_hash: terms.content_hash, channel: "portal", ip, user_agent: req.headers.get("user-agent"), evidence: { pf_session: true } });
      if (error && !/registry_acceptances_unique/.test(error.message ?? "")) lancarSeErro(error);
      await avancar(admin, t);
      return json(await concluir(admin, null, t));
    }

    if (op === "cancelar_venda") {
      const t = await txDaPf(admin, String(body.transaction_id ?? ""), s.party_id);
      if (t.state === "completed") throw new DomainError("append_only", "Uma venda concluída não pode ser cancelada. Abra uma contestação.", 409);
      await mudarEstado(admin, t, "cancelled");
      await admin.from("registry_acceptance_invites").update({ revoked_at: new Date().toISOString(), revoked_reason: "cancelada" }).eq("transaction_id", t.id).is("consumed_at", null).is("revoked_at", null);
      return json({});
    }

    if (op === "comunicar_venda") {
      const device_id = String(body.device_id ?? "");
      await exigirTitular(admin, s.party_id, device_id);
      if (await ocorrenciaAtiva(admin, device_id)) throw new DomainError("ocorrencia_ativa", "Há uma declaração de furto/roubo ativa para este aparelho.", 409);
      if (await intencaoAberta(admin, s.party_id, device_id)) throw new DomainError("intencao_aberta", "Já existe uma venda em andamento para este aparelho.", 409);
      const c = (body.comprador ?? {}) as Record<string, string>;
      const dataVenda = body.data_venda && !Number.isNaN(Date.parse(String(body.data_venda))) ? new Date(String(body.data_venda)).toISOString() : new Date().toISOString();
      const buyer = await pessoaPorCpf(admin, c.cpf ?? "", c.nome?.trim() || "Comprador informado pelo vendedor", c.telefone ?? null);
      if (buyer === s.party_id) throw new DomainError("mesma_pessoa", "O comprador não pode ser você mesmo.");
      const valor = Math.round(Number(body.valor_centavos));
      const t = await novaTxPf(admin, s.party_id, buyer, device_id, { valor_centavos: valor > 0 ? valor : 1, forma_pagamento: "não informada", estado_aparelho: "não informado", defeitos: "", garantia: "", declaracoes: { origem: "comunicacao_de_venda", data_venda: dataVenda } });
      const terms = (await termosVigentes(admin, t))!;
      // A declaração do vendedor vale desde já — é isto que o protege.
      await admin.from("registry_transaction_acceptances").insert({ transaction_id: t.id, party_id: s.party_id, terms_version: 1, terms_hash: terms.content_hash, channel: "portal", ip, evidence: { pf_session: true, comunicacao_de_venda: true } });
      await avancar(admin, t);
      await admin.from("registry_device_events").insert({ device_id, store_id: null, type: "sale_declared", visibility: "public", transaction_id: t.id, payload: { aviso: "O titular registrado declarou ter vendido este aparelho nesta data. Declaração unilateral: o comprador ainda não confirmou.", data_venda: dataVenda, comprador_confirmou: false } });
      await auditar(admin, null, null, "pf.sale_declared", "transaction", t.id, { seller: s.party_id }, ip);
      if (await telefoneDaParte(admin, buyer)) {
        await criarConvite(admin, { store: null, user: null, ip }, t, buyer, `${nomeCurto(s.display_name)} declarou ter vendido um aparelho para você pelo Cartório do Celular. Confirme para a transferência ficar registrada em seu nome`);
      }
      return json(await txView(admin, t));
    }

    if (op === "registrar_ocorrencia") {
      const device_id = String(body.device_id ?? "");
      await exigirTitular(admin, s.party_id, device_id);
      if (await ocorrenciaAtiva(admin, device_id)) throw new DomainError("ja_declarada", "Já existe uma declaração ativa para este aparelho.", 409);
      const tipo = ["furto", "roubo", "perda"].includes(String(body.tipo)) ? String(body.tipo) : "furto";
      const bo = String(body.bo_numero ?? "").trim() || null;
      const { error } = await admin.from("registry_device_flags").insert({ device_id, kind: "theft_declared", tipo, declared_by_party_id: s.party_id, bo_numero: bo, bo_data: body.bo_data ? String(body.bo_data) : null, cidade: String(body.cidade ?? "").trim() || null, uf: String(body.uf ?? "").trim().toUpperCase().slice(0, 2) || null });
      lancarSeErro(error);
      await admin.from("registry_device_events").insert({ device_id, store_id: null, type: "theft_declared", visibility: "public", payload: { tipo, bo_numero: bo, bo_data: body.bo_data ?? null, cidade: body.cidade ?? null, uf: body.uf ?? null, aviso: `O titular registrado declarou ${tipo} deste aparelho${bo ? `, com boletim de ocorrência nº ${bo}` : ", sem número de boletim informado"}. É uma declaração do titular, não uma verificação do Cartório. Canal oficial: Celular Seguro (gov.br).` } });
      await auditar(admin, null, null, "pf.theft_declared", "device", device_id, { tipo }, ip);
      return json(await ocorrenciaAtiva(admin, device_id));
    }

    if (op === "retirar_ocorrencia") {
      const device_id = String(body.device_id ?? "");
      await exigirTitular(admin, s.party_id, device_id);
      const motivo = String(body.motivo ?? "").trim();
      if (motivo.length < 5) throw new DomainError("motivo", "Escreva o motivo (ex.: aparelho recuperado).");
      const { data: f } = await admin.from("registry_device_flags").select("id").eq("device_id", device_id).eq("kind", "theft_declared").eq("active", true).maybeSingle();
      if (!f) throw new DomainError("sem_declaracao", "Não há declaração ativa.", 404);
      await admin.from("registry_device_flags").update({ active: false, withdrawn_at: new Date().toISOString(), withdrawn_reason: motivo }).eq("id", f.id);
      await admin.from("registry_device_events").insert({ device_id, store_id: null, type: "theft_withdrawn", visibility: "public", payload: { motivo, aviso: "O titular registrado retirou a declaração anterior." } });
      await auditar(admin, null, null, "pf.theft_withdrawn", "device", device_id, {}, ip);
      return json({});
    }

    throw new DomainError("op", "Operação desconhecida.");
  } catch (e) {
    if (e instanceof DomainError) return json({ error: { code: e.code, message: e.message } }, e.status);
    console.error("pf: erro inesperado", e instanceof Error ? e.message : e);
    return json({ error: { code: "erro", message: "Algo deu errado. Tente de novo." } }, 500);
  }
});
