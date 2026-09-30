// avaliacao — Avaliação de usados / compra (portada do Sheik CRM):
//   config · salvar_config · remover_valor_base · estimar · listar · obter ·
//   fechar (→ pessoa + aparelho + transação + termos + consulta do Cartório) ·
//   completar_imei · excluir · nota_compra · nota_venda
// Preço: tabela de valores base da loja (determinístico, na hora). Se não
// houver linha para o modelo e existir OPENAI_API_KEY, pergunta à IA como o
// CRM fazia (GPT-4o, com busca na web quando disponível). Sem chave: oferta manual.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  DomainError, FORMAS_PAGAMENTO_PADRAO, MARGENS_PADRAO, QUESTIONARIO_PADRAO, cifrar, decifrar, estimarPelaTabela, exigirRespostasValidas,
  formatarCentavos, formatarCnpj, formatarCpf, imeiValido, importarValoresBase, marcaApple, margemDaTabela, mascararImei, onlyDigits, parseReais,
  resumirEstado, sanitizarFormasPagamento, sanitizarMargens, sanitizarQuestionario,
  type Estimativa, type Margens, type QuestionarioConfig, type TabelaMargem, type ValorBase,
} from "../_shared/core/index.ts";
import { auditar, env, exigirLoja, lancarSeErro, servir, type Ctx } from "../_shared/server.ts";
import { checkDaTx, deviceIdDaTx, imeiDoDevice, obterTx, partesDaTx, partyView, statusAceite, telefoneDaParte, termosVigentes, txView, type TxRow } from "../_shared/views.ts";
import { completarImeiDoAparelho, congelarTermos, criarAparelho, criarAparelhoSemImei, criarOuVincularPessoa, criarTransacao, executarConsulta } from "../_shared/ops.ts";

type ErpCfg = { ativo: boolean; url: string; token: string; enviar_compras: boolean; enviar_vendas: boolean; solicitar_nfe: boolean };
const ERP_PADRAO: ErpCfg = { ativo: false, url: "", token: "", enviar_compras: true, enviar_vendas: true, solicitar_nfe: true };

export async function lerConfig<T>(admin: SupabaseClient, store_id: string, key: string, padrao: T): Promise<T> {
  const { data } = await admin.from("store_settings").select("value").eq("store_id", store_id).eq("key", key).maybeSingle();
  return data ? (data.value as T) : padrao;
}
async function gravarConfig(admin: SupabaseClient, store_id: string, key: string, value: unknown) {
  const { error } = await admin.from("store_settings").upsert({ store_id, key, value, updated_at: new Date().toISOString() }, { onConflict: "store_id,key" });
  lancarSeErro(error);
}
export async function configDaLoja(admin: SupabaseClient, store_id: string) {
  const erp = await lerConfig<ErpCfg>(admin, store_id, "erp", ERP_PADRAO);
  const { token: _t, ...erpPub } = erp;
  return {
    margens: await lerConfig<Margens>(admin, store_id, "margens", MARGENS_PADRAO),
    questionario: await lerConfig<QuestionarioConfig>(admin, store_id, "questionario", QUESTIONARIO_PADRAO),
    formas_pagamento: await lerConfig<string[]>(admin, store_id, "formas_pagamento", FORMAS_PAGAMENTO_PADRAO),
    valores_base: await lerConfig<Array<ValorBase & { id: string }>>(admin, store_id, "valores_base", []),
    ia_disponivel: !!env("OPENAI_API_KEY", false),
    erp: { ...erpPub, token_definido: !!erp.token },
  };
}

type Row = Record<string, unknown>;

async function view(admin: SupabaseClient, a: Row) {
  const t = a.transaction_id ? await obterTx(admin, a.transaction_id as string).catch(() => null) : null;
  const seller = a.seller_party_id ? await partyView(admin, a.seller_party_id as string) : null;
  const imei = a.device_id ? await imeiDoDevice(admin, a.device_id as string) : "";
  const st = t && t.state === "completed" ? await statusAceite(admin, t) : null;
  return {
    id: a.id, created_at: a.created_at, brand: a.brand, model: a.model, memory: a.memory, color: a.color, device: a.device,
    customer_name: a.customer_name, answers: a.answers, estimativa: a.estimativa, margem_tabela: a.margem_tabela,
    closed_at: a.closed_at, final_price_centavos: a.final_price_centavos, payment_method: a.payment_method,
    pix_key: a.pix_key_encrypted ? await decifrar(env("REGISTRY_PII_KEY"), a.pix_key_encrypted as string) : null, pix_key_holder: a.pix_key_holder,
    seller_party_id: a.seller_party_id, seller_display_name: seller?.display_name ?? null, seller_telefone_mascarado: seller?.telefone_mascarado ?? null,
    device_id: a.device_id, imei_mascarado: imei ? mascararImei(imei) : null, imei_pendente: !!a.closed_at && !imei,
    transaction_id: a.transaction_id, transaction_state: t?.state ?? null, protocolo: t?.state === "completed" ? t.public_protocol : null,
    aceite_grade: st?.grade ?? null, store_name: a.store_name,
  };
}

async function obterAvaliacao(admin: SupabaseClient, id: string, store_id: string): Promise<Row> {
  const { data, error } = await admin.from("trade_in_evaluations").select("*").eq("id", id).eq("store_id", store_id).maybeSingle();
  lancarSeErro(error);
  if (!data) throw new DomainError("avaliacao", "Avaliação não encontrada.", 404);
  return data as Row;
}

async function estimarComIA(dev: string, respostas: Record<string, string>, marginPct: number): Promise<Estimativa | null> {
  const key = env("OPENAI_API_KEY", false);
  if (!key) return null;
  const payPct = 100 - marginPct;
  const cond = Object.entries(respostas).map(([k, v]) => `- ${k}: ${v}`).join("\n");
  const prompt = [
    `Você é o avaliador de compra de celulares usados de uma loja no Brasil.`,
    `Estime os preços ATUAIS de venda do aparelho usado abaixo no mercado brasileiro (OLX, Mercado Livre, Trocafone).`,
    ``, `Aparelho: ${dev.slice(0, 120)}`, `Estado informado pelo vendedor:`, cond || "- (sem detalhes)", ``,
    `Regras: 1. Estime a faixa de preço de VENDA do usado hoje no Brasil, já descontando o estado. 2. A loja trabalha com margem de ${marginPct}%: sugira um valor de COMPRA em torno de ${payPct}% do valor de revenda estimado.`,
    `Responda SOMENTE com JSON válido, sem markdown: {"marketPrice":"R$ X – R$ Y","suggestedPrice":"R$ Z","summary":"justificativa curta em 2-4 frases"}`,
  ].join("\n");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, signal: ctrl.signal,
      body: JSON.stringify({ model: env("OPENAI_MODEL", false) || "gpt-4o", max_tokens: 600, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const raw: string = j.choices?.[0]?.message?.content ?? "";
    const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
    if (s < 0 || e < 0) return null;
    const p = JSON.parse(raw.slice(s, e + 1)) as { marketPrice?: string; suggestedPrice?: string; summary?: string };
    const sug = parseReais(p.suggestedPrice ?? "");
    if (!sug) return null;
    return { metodo: "ia", valor_base_centavos: null, faixa_mercado: (p.marketPrice ?? "").slice(0, 200) || null, sugestao_centavos: Math.round(sug / 1000) * 1000, margem_tabela: 2, margem_pct: marginPct, desconto_pct: 0, justificativa: `${(p.summary ?? "").slice(0, 1500)} (Sugestão gerada por IA com base em preços pesquisados — confirme antes de fechar a compra.)` };
  } catch { return null; } finally { clearTimeout(timer); }
}

async function fotosDaTx(admin: SupabaseClient, transaction_id: string | null, slots: string[]): Promise<string[]> {
  if (!transaction_id) return [];
  const { data } = await admin.from("registry_device_media").select("storage_key, slot").eq("transaction_id", transaction_id).in("slot", slots);
  const urls: string[] = [];
  for (const m of data ?? []) {
    const { data: s } = await admin.storage.from("registry-media").createSignedUrl(m.storage_key as string, 300);
    if (s?.signedUrl) urls.push(s.signedUrl);
  }
  return urls;
}

servir(async (_req, ctx: Ctx, body) => {
  const { user, store } = exigirLoja(ctx);
  const admin = ctx.admin;
  const op = String(body.op ?? "");
  const octx = { store, user, ip: ctx.ip };

  if (op === "config") return configDaLoja(admin, store.id);

  if (op === "salvar_config") {
    if (body.margens) await gravarConfig(admin, store.id, "margens", sanitizarMargens(body.margens));
    if (body.questionario) { const r = sanitizarQuestionario(body.questionario); if (r.error) throw new DomainError("questionario", r.error); await gravarConfig(admin, store.id, "questionario", r.config); }
    if (body.formas_pagamento) { const r = sanitizarFormasPagamento(body.formas_pagamento); if (r.error) throw new DomainError("pagamentos", r.error); await gravarConfig(admin, store.id, "formas_pagamento", r.methods); }
    if (typeof body.valores_base_texto === "string") {
      const { linhas, erros } = importarValoresBase(body.valores_base_texto);
      if (erros.length) throw new DomainError("valores_base", erros.slice(0, 3).join(" · "));
      const atuais = await lerConfig<Array<ValorBase & { id: string }>>(admin, store.id, "valores_base", []);
      const chave = (v: ValorBase) => `${v.brand}|${v.model}|${v.storage ?? ""}`.toLowerCase();
      const novos = linhas.map((l) => ({ ...l, id: crypto.randomUUID() }));
      await gravarConfig(admin, store.id, "valores_base", [...atuais.filter((a) => !novos.some((n) => chave(n) === chave(a))), ...novos]);
    }
    if (body.erp && typeof body.erp === "object") {
      const atual = await lerConfig<ErpCfg>(admin, store.id, "erp", ERP_PADRAO);
      const e = body.erp as Partial<ErpCfg> & { token?: string; token_definido?: boolean };
      const novo: ErpCfg = { ativo: !!(e.ativo ?? atual.ativo), url: String(e.url ?? atual.url).trim(), token: e.token ? String(e.token) : atual.token, enviar_compras: !!(e.enviar_compras ?? atual.enviar_compras), enviar_vendas: !!(e.enviar_vendas ?? atual.enviar_vendas), solicitar_nfe: !!(e.solicitar_nfe ?? atual.solicitar_nfe) };
      await gravarConfig(admin, store.id, "erp", novo);
    }
    await auditar(admin, store.id, user.id, "avaliacao.config", "store", store.id, { chaves: Object.keys(body).filter((k) => k !== "op") }, ctx.ip);
    return configDaLoja(admin, store.id);
  }

  if (op === "remover_valor_base") {
    const atuais = await lerConfig<Array<ValorBase & { id: string }>>(admin, store.id, "valores_base", []);
    await gravarConfig(admin, store.id, "valores_base", atuais.filter((v) => v.id !== body.id));
    return {};
  }

  if (op === "listar") {
    const { data, error } = await admin.from("trade_in_evaluations").select("*").eq("store_id", store.id).order("created_at", { ascending: false }).limit(300);
    lancarSeErro(error);
    return Promise.all((data ?? []).map((a) => view(admin, a as Row)));
  }

  if (op === "estimar") {
    const brand = String(body.brand ?? "").trim().slice(0, 40), model = String(body.model ?? "").trim().slice(0, 60);
    const memory = String(body.memory ?? "").trim().slice(0, 20) || null, color = String(body.color ?? "").trim().slice(0, 30) || null;
    if (!brand || !model) throw new DomainError("aparelho", "Informe a marca e o modelo do aparelho.");
    const c = await configDaLoja(admin, store.id);
    const perguntas = marcaApple(brand) ? c.questionario.apple : c.questionario.android;
    const respostas: Record<string, string> = {};
    for (const [k, v] of Object.entries((body.answers as Record<string, unknown>) ?? {}).slice(0, 30)) if (typeof v === "string" && v.trim()) respostas[k.trim().slice(0, 60)] = v.trim().slice(0, 200);
    exigirRespostasValidas(perguntas, respostas);
    const tabela: TabelaMargem = body.tabela === 1 || body.tabela === 3 ? body.tabela : 2;
    const device = [brand, model, memory, color].filter(Boolean).join(" ");
    let estimativa = estimarPelaTabela({ linhas: c.valores_base, brand, model, memory, perguntas, respostas, margens: c.margens, tabela });
    if (!estimativa) estimativa = await estimarComIA(device, respostas, margemDaTabela(c.margens, tabela));
    const { data, error } = await admin.from("trade_in_evaluations").insert({
      store_id: store.id, user_id: user.id, brand, model, memory, color, device, customer_name: String(body.customer_name ?? "").trim().slice(0, 120) || null,
      answers: respostas, estimativa, margem_tabela: tabela,
    }).select("*").single();
    lancarSeErro(error);
    return view(admin, data as Row);
  }

  const id = String(body.id ?? "");

  if (op === "obter") return view(admin, await obterAvaliacao(admin, id, store.id));

  if (op === "fechar") {
    const a = await obterAvaliacao(admin, id, store.id);
    if (a.closed_at) throw new DomainError("ja_fechada", "Este negócio já foi fechado. Para corrigir, use a compra em Celulares comprados.", 409);
    const v = (body.vendedor ?? {}) as Record<string, string>;
    const finalCent = Math.round(Number(body.final_price_centavos));
    const pagamento = String(body.payment_method ?? "");
    const imei = onlyDigits(String(body.imei ?? ""));
    if (!(finalCent > 0)) throw new DomainError("valor", "Informe o valor final negociado.");
    if (!pagamento) throw new DomainError("forma_pagamento", "Informe a forma de pagamento.");
    if (imei && !imeiValido(imei)) throw new DomainError("imei", "Esse IMEI não confere. Confira os 15 dígitos — ou deixe em branco e complete depois.");
    const tabela: TabelaMargem = body.tabela === 1 || body.tabela === 3 ? body.tabela : 2;

    // 1. vendedor + dados extras cifrados
    const seller = await criarOuVincularPessoa(admin, octx, { documento: v.cpf ?? "", tipo: "pf", nome: v.nome ?? "", telefone: v.telefone ?? "" });
    const key = env("REGISTRY_PII_KEY");
    const det: Record<string, unknown> = { party_id: seller.party_id, updated_at: new Date().toISOString() };
    if (v.rg?.trim()) det.rg_encrypted = await cifrar(key, v.rg.trim());
    if (v.endereco?.trim()) det.endereco_encrypted = await cifrar(key, v.endereco.trim());
    if (v.bairro?.trim()) det.bairro_encrypted = await cifrar(key, v.bairro.trim());
    await admin.from("registry_party_details").upsert(det, { onConflict: "party_id" });

    // 2. aparelho (com IMEI: cadastra ou reaproveita; sem: nasce pendente)
    let device_id: string;
    if (imei) {
      const r = await criarAparelho(admin, octx, { imei, marca: a.brand as string, modelo: a.model as string, armazenamento: (a.memory as string) ?? "", cor: (a.color as string) ?? "" });
      device_id = r.conflito ? r.existente.device!.device_id : r.device_id;
    } else {
      device_id = await criarAparelhoSemImei(admin, octx, { marca: a.brand as string, modelo: a.model as string, armazenamento: (a.memory as string) ?? "", cor: (a.color as string) ?? "" });
    }

    // 3. transação PF→PJ + 4. termos + 5. consulta (com IMEI)
    if (!store.party_id) throw new DomainError("loja", "A loja não tem parte cadastrada. Recadastre a loja.", 500);
    const t = await criarTransacao(admin, octx, { kind: "pf_pj", device_id, seller_party_id: seller.party_id, buyer_party_id: store.party_id, idempotency_key: `avaliacao:${a.id}` });
    const c = await configDaLoja(admin, store.id);
    const perguntas = marcaApple(a.brand as string) ? c.questionario.apple : c.questionario.android;
    const answers = (a.answers as Record<string, string>) ?? {};
    const { estado, defeitos } = resumirEstado(perguntas, answers);
    const pix = /pix/i.test(pagamento);
    await congelarTermos(admin, octx, t, {
      valor_centavos: finalCent, forma_pagamento: pagamento, estado_aparelho: estado, defeitos, garantia: "",
      declaracoes: { ...answers, ...(pix && body.pix_key ? { "Chave Pix": String(body.pix_key), "Titular da chave Pix": String(body.pix_key_holder ?? "") } : {}), avaliacao_id: a.id as string, tabela_margem: String(tabela) },
    });
    if (imei) await executarConsulta(admin, octx, t);

    const { data: saved, error } = await admin.from("trade_in_evaluations").update({
      closed_at: new Date().toISOString(), final_price_centavos: finalCent, payment_method: pagamento,
      pix_key_encrypted: pix && body.pix_key ? await cifrar(key, String(body.pix_key)) : null, pix_key_holder: pix ? String(body.pix_key_holder ?? "").trim() || null : null,
      seller_party_id: seller.party_id, device_id, transaction_id: t.id, store_name: store.name, margem_tabela: tabela, updated_at: new Date().toISOString(),
    }).eq("id", a.id).select("*").single();
    lancarSeErro(error);
    await auditar(admin, store.id, user.id, "avaliacao.closed", "avaliacao", a.id as string, { transaction_id: t.id, imei_pendente: !imei }, ctx.ip);
    return view(admin, saved as Row);
  }

  if (op === "completar_imei") {
    const a = await obterAvaliacao(admin, id, store.id);
    if (!a.closed_at || !a.device_id || !a.transaction_id) throw new DomainError("avaliacao", "Compra não encontrada.", 404);
    await completarImeiDoAparelho(admin, octx, a.device_id as string, String(body.imei ?? ""), a.transaction_id as string);
    const t = await obterTx(admin, a.transaction_id as string, store.id);
    await executarConsulta(admin, octx, t);
    await auditar(admin, store.id, user.id, "avaliacao.imei_completed", "avaliacao", a.id as string, {}, ctx.ip);
    return view(admin, a);
  }

  if (op === "excluir") {
    const a = await obterAvaliacao(admin, id, store.id);
    if (a.transaction_id) {
      const t = await obterTx(admin, a.transaction_id as string, store.id);
      if (t.state === "completed") throw new DomainError("append_only", "Este registro já foi concluído no Cartório e não pode ser excluído. Abra uma contestação.", 409);
      if (!["cancelled", "expired"].includes(t.state)) { const { mudarEstado } = await import("../_shared/views.ts"); await mudarEstado(admin, t, "cancelled"); }
    }
    const { error } = await admin.from("trade_in_evaluations").delete().eq("id", a.id);
    lancarSeErro(error);
    await auditar(admin, store.id, user.id, "avaliacao.deleted", "avaliacao", a.id as string, {}, ctx.ip);
    return {};
  }

  if (op === "nota_compra") {
    const a = await obterAvaliacao(admin, id, store.id);
    if (!a.closed_at || !a.seller_party_id) throw new DomainError("avaliacao", "Esta avaliação ainda não virou compra.", 404);
    const t = a.transaction_id ? await obterTx(admin, a.transaction_id as string, store.id) : null;
    const seller = await partyView(admin, a.seller_party_id as string);
    const key = env("REGISTRY_PII_KEY");
    const { data: ident } = await admin.from("registry_party_identifiers").select("value_encrypted").eq("party_id", a.seller_party_id).maybeSingle();
    const { data: det } = await admin.from("registry_party_details").select("*").eq("party_id", a.seller_party_id).maybeSingle();
    const { data: s } = await admin.from("stores").select("name, cnpj, city").eq("id", store.id).single();
    const c = await configDaLoja(admin, store.id);
    const perguntas = marcaApple(a.brand as string) ? c.questionario.apple : c.questionario.android;
    const answers = (a.answers as Record<string, string>) ?? {};
    const st = t && t.state === "completed" ? await statusAceite(admin, t) : null;
    await auditar(admin, store.id, user.id, "nota_compra.viewed", "avaliacao", a.id as string, { party_id: a.seller_party_id }, ctx.ip); // acesso a documento é auditado
    const base = env("PUBLIC_APP_URL").replace(/\/$/, "");
    return {
      protocolo: t?.state === "completed" ? t.public_protocol : null, registro_estado: t?.state ?? null, aceite_grade: st?.grade ?? null, concluido_em: t?.completed_at ?? null,
      loja: { nome: s!.name, cnpj: formatarCnpj(s!.cnpj as string), cidade: s!.city }, data: a.closed_at,
      aparelho: { descricao: a.device, marca: a.brand, modelo: a.model, memoria: a.memory, cor: a.color, imei: a.device_id ? (await imeiDoDevice(admin, a.device_id as string)) || null : null },
      vendedor: {
        nome: seller.display_name, cpf: ident ? formatarCpf(await decifrar(key, ident.value_encrypted as string)) : "",
        rg: det?.rg_encrypted ? await decifrar(key, det.rg_encrypted as string) : null, endereco: det?.endereco_encrypted ? await decifrar(key, det.endereco_encrypted as string) : null,
        bairro: det?.bairro_encrypted ? await decifrar(key, det.bairro_encrypted as string) : null, telefone: await telefoneDaParte(admin, a.seller_party_id as string),
      },
      valor: formatarCentavos(Number(a.final_price_centavos ?? 0)), forma_pagamento: a.payment_method ?? "—",
      pix_key: a.pix_key_encrypted ? await decifrar(key, a.pix_key_encrypted as string) : null, pix_key_holder: a.pix_key_holder,
      checklist: perguntas.filter((q) => answers[q.key]).map((q) => ({ pergunta: q.key, resposta: answers[q.key] })),
      fotos: { documento: await fotosDaTx(admin, a.transaction_id as string | null, ["documento", "selfie"]), aparelho: await fotosDaTx(admin, a.transaction_id as string | null, ["frente_ligada", "traseira", "tela_imei", "laterais", "avarias"]), comprovante: await fotosDaTx(admin, a.transaction_id as string | null, ["comprovante"]) },
      link_certificado: t?.state === "completed" ? `${base}/certificado/${t.public_protocol}` : null,
    };
  }

  if (op === "nota_venda") {
    const t: TxRow = await obterTx(admin, String(body.transaction_id ?? ""), store.id);
    if (t.state !== "completed" || t.kind !== "pj_pf") throw new DomainError("venda", "Nota de venda só existe para venda concluída.", 404);
    const tv = await txView(admin, t);
    const buyer = tv.parties.find((p) => p.role === "buyer")!;
    const key = env("REGISTRY_PII_KEY");
    const { data: ident } = await admin.from("registry_party_identifiers").select("value_encrypted").eq("party_id", buyer.party_id).maybeSingle();
    const { data: s } = await admin.from("stores").select("name, cnpj, city").eq("id", store.id).single();
    const p = tv.terms!.payload;
    const ck = await checkDaTx(admin, t.id);
    await auditar(admin, store.id, user.id, "nota_venda.viewed", "transaction", t.id, {}, ctx.ip);
    return {
      protocolo: t.public_protocol, aceite_grade: tv.aceite.grade, concluido_em: t.completed_at,
      loja: { nome: s!.name, cnpj: formatarCnpj(s!.cnpj as string), cidade: s!.city },
      aparelho: { descricao: [tv.device?.brand, tv.device?.model, tv.device?.storage, tv.device?.color].filter(Boolean).join(" "), imei: await imeiDoDevice(admin, await deviceIdDaTx(admin, t.id)) },
      comprador: { nome: buyer.display_name, cpf: ident ? formatarCpf(await decifrar(key, ident.value_encrypted as string)) : "", telefone: await telefoneDaParte(admin, buyer.party_id) },
      valor: formatarCentavos(p.valor_centavos), forma_pagamento: p.forma_pagamento, garantia: p.garantia || "não informada",
      estado_declarado: p.estado_aparelho, defeitos_declarados: p.defeitos || "nenhum",
      consulta: ck ? { resultado: ck.result, fonte: ck.provider, data: ck.checked_at } : null,
      link_certificado: `${env("PUBLIC_APP_URL").replace(/\/$/, "")}/certificado/${t.public_protocol}`,
    };
  }

  throw new DomainError("op", "Operação desconhecida.");
});

// Reexport para a função erp (evita duplicar a leitura da configuração).
export { partesDaTx };
