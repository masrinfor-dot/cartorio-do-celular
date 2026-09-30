// Demonstração — Avaliação de usados / compra, nota de compra, nota de venda e
// integração ERP. Reaproveita as operações do Cartório (identidade, aparelho,
// transação, termos, consulta) — o fechamento do negócio É a transação PF→PJ.

import {
  DomainError,
  FORMAS_PAGAMENTO_PADRAO,
  MARGENS_PADRAO,
  QUESTIONARIO_PADRAO,
  estimarPelaTabela,
  exigirRespostasValidas,
  formatarCentavos,
  formatarCnpj,
  formatarCpf,
  imeiValido,
  importarValoresBase,
  marcaApple,
  mascararImei,
  onlyDigits,
  recalcularOferta,
  resumirEstado,
  sanitizarFormasPagamento,
  sanitizarMargens,
  sanitizarQuestionario,
  type Estimativa,
  type Margens,
  type QuestionarioConfig,
  type TabelaMargem,
  type ValorBase,
} from "@core/index.ts";
import type { AvaliacaoConfig, AvaliacaoView, ErpConfig, ErpEnvio, FecharNegocio, NotaCompra, NotaVenda, RegistryApi } from "./types.ts";
import { demoApi, demoInternals as I } from "./demo.ts";

const CFG = { margens: "margens", questionario: "questionario", pagamentos: "formas_pagamento", valores: "valores_base", erp: "erp" };

function cfg<T>(store_id: string, key: string, padrao: T): T {
  const r = I.db().store_settings.find((s) => s.store_id === store_id && s.key === key);
  return r ? (r.value as T) : padrao;
}
function setCfg(store_id: string, key: string, value: unknown) {
  const db = I.db();
  const r = db.store_settings.find((s) => s.store_id === store_id && s.key === key);
  if (r) r.value = value; else db.store_settings.push({ ...I.row(), store_id, key, value });
}
type ErpCfgInterno = ErpConfig & { token: string };
const ERP_PADRAO: ErpCfgInterno = { ativo: false, url: "", token: "", token_definido: false, enviar_compras: true, enviar_vendas: true, solicitar_nfe: true };

function configDaLoja(store_id: string): AvaliacaoConfig {
  const erp = cfg<ErpCfgInterno>(store_id, CFG.erp, ERP_PADRAO);
  const { token: _t, ...erpPublico } = erp;
  return {
    margens: cfg<Margens>(store_id, CFG.margens, MARGENS_PADRAO),
    questionario: cfg<QuestionarioConfig>(store_id, CFG.questionario, QUESTIONARIO_PADRAO),
    formas_pagamento: cfg<string[]>(store_id, CFG.pagamentos, FORMAS_PAGAMENTO_PADRAO),
    valores_base: cfg<Array<ValorBase & { id: string }>>(store_id, CFG.valores, []),
    ia_disponivel: false, // a demonstração não chama IA; a tabela de valores base faz o papel
    erp: { ...erpPublico, token_definido: !!erp.token },
  };
}

function view(id: string): AvaliacaoView {
  const db = I.db();
  const a = db.avaliacoes.find((x) => x.id === id);
  if (!a) throw new DomainError("avaliacao", "Avaliação não encontrada.", 404);
  const t = a.transaction_id ? db.transactions.find((x) => x.id === a.transaction_id) ?? null : null;
  const seller = a.seller_party_id ? I.partyView(a.seller_party_id) : null;
  const imei = a.device_id ? I.imeiDoDevice(a.device_id) : "";
  return {
    id: a.id, created_at: a.created_at, brand: a.brand, model: a.model, memory: a.memory, color: a.color, device: a.device,
    customer_name: a.customer_name, answers: a.answers, estimativa: a.estimativa, margem_tabela: a.margem_tabela,
    closed_at: a.closed_at, final_price_centavos: a.final_price_centavos, payment_method: a.payment_method, pix_key: a.pix_key, pix_key_holder: a.pix_key_holder,
    seller_party_id: a.seller_party_id, seller_display_name: seller?.display_name ?? null, seller_telefone_mascarado: seller?.telefone_mascarado ?? null,
    device_id: a.device_id, imei_mascarado: imei ? mascararImei(imei) : null, imei_pendente: !!a.closed_at && !imei,
    transaction_id: a.transaction_id, transaction_state: t?.state ?? null, protocolo: t?.state === "completed" ? t.public_protocol : null,
    aceite_grade: t?.state === "completed" ? I.statusAceite(t.id).grade : null,
    store_name: a.store_name,
  };
}

export const demoAvaliacaoApi: Pick<RegistryApi, "avaliacao" | "notaVenda" | "erp"> = {
  avaliacao: {
    async config() { await I.delay(40); const { store } = I.sessao(); return configDaLoja(store.id); },

    async salvarConfig(patch) {
      await I.delay();
      const { store, user } = I.sessao();
      if (patch.margens) setCfg(store.id, CFG.margens, sanitizarMargens(patch.margens));
      if (patch.questionario) {
        const r = sanitizarQuestionario(patch.questionario);
        if (r.error) throw new DomainError("questionario", r.error);
        setCfg(store.id, CFG.questionario, r.config);
      }
      if (patch.formas_pagamento) {
        const r = sanitizarFormasPagamento(patch.formas_pagamento);
        if (r.error) throw new DomainError("pagamentos", r.error);
        setCfg(store.id, CFG.pagamentos, r.methods);
      }
      if (patch.valores_base_texto !== undefined) {
        const { linhas, erros } = importarValoresBase(patch.valores_base_texto);
        if (erros.length) throw new DomainError("valores_base", erros.slice(0, 3).join(" · "));
        const atuais = cfg<Array<ValorBase & { id: string }>>(store.id, CFG.valores, []);
        // Mesma marca/modelo/armazenamento substitui; o resto acrescenta.
        const chave = (v: ValorBase) => `${v.brand}|${v.model}|${v.storage ?? ""}`.toLowerCase();
        const novos = linhas.map((l) => ({ ...l, id: crypto.randomUUID() }));
        const restantes = atuais.filter((a) => !novos.some((n) => chave(n) === chave(a)));
        setCfg(store.id, CFG.valores, [...restantes, ...novos]);
      }
      if (patch.erp) {
        const atual = cfg<ErpCfgInterno>(store.id, CFG.erp, ERP_PADRAO);
        const { token, ...resto } = patch.erp;
        const novo: ErpCfgInterno = { ...atual, ...resto, token: token !== undefined ? token : atual.token, token_definido: false };
        novo.token_definido = !!novo.token;
        setCfg(store.id, CFG.erp, novo);
      }
      I.auditar(store.id, user.id, "avaliacao.config", "store", store.id, { chaves: Object.keys(patch) });
      I.salvar();
      return configDaLoja(store.id);
    },

    async removerValorBase(id) {
      const { store } = I.sessao();
      setCfg(store.id, CFG.valores, cfg<Array<ValorBase & { id: string }>>(store.id, CFG.valores, []).filter((v) => v.id !== id));
      I.salvar();
    },

    async estimar(d) {
      await I.delay(300);
      const { store, user } = I.sessao();
      const brand = d.brand.trim().slice(0, 40), model = d.model.trim().slice(0, 60);
      if (!brand || !model) throw new DomainError("aparelho", "Informe a marca e o modelo do aparelho.");
      const c = configDaLoja(store.id);
      const perguntas = marcaApple(brand) ? c.questionario.apple : c.questionario.android;
      const respostas: Record<string, string> = {};
      for (const [k, v] of Object.entries(d.answers ?? {}).slice(0, 30)) if (typeof v === "string" && v.trim()) respostas[k.trim().slice(0, 60)] = v.trim().slice(0, 200);
      exigirRespostasValidas(perguntas, respostas);
      const tabela: TabelaMargem = d.tabela === 1 || d.tabela === 3 ? d.tabela : 2;
      const estimativa: Estimativa | null = estimarPelaTabela({ linhas: c.valores_base, brand, model, memory: d.memory || null, perguntas, respostas, margens: c.margens, tabela });
      const a = {
        ...I.row(), store_id: store.id, user_id: user.id, brand, model, memory: d.memory || null, color: d.color || null,
        device: [brand, model, d.memory, d.color].filter(Boolean).join(" "), customer_name: d.customer_name?.trim() || null,
        answers: respostas, estimativa, margem_tabela: tabela,
        closed_at: null, final_price_centavos: null, payment_method: null, pix_key: null, pix_key_holder: null,
        seller_party_id: null, device_id: null, transaction_id: null, store_name: null,
      };
      I.db().avaliacoes.push(a);
      I.salvar();
      return view(a.id);
    },

    async listar() {
      await I.delay(40);
      const { store } = I.sessao();
      return I.db().avaliacoes.filter((a) => a.store_id === store.id).sort((x, y) => y.created_at.localeCompare(x.created_at)).map((a) => view(a.id));
    },

    async obter(id) { await I.delay(30); const { store } = I.sessao(); const a = I.db().avaliacoes.find((x) => x.id === id && x.store_id === store.id); if (!a) throw new DomainError("avaliacao", "Avaliação não encontrada.", 404); return view(id); },

    async fechar(id, dados) {
      await I.delay(300);
      const { store, user } = I.sessao();
      const db = I.db();
      const a = db.avaliacoes.find((x) => x.id === id && x.store_id === store.id);
      if (!a) throw new DomainError("avaliacao", "Avaliação não encontrada.", 404);
      if (a.closed_at) throw new DomainError("ja_fechada", "Este negócio já foi fechado. Para corrigir, use a compra em Celulares comprados.", 409);
      if (!(dados.final_price_centavos > 0)) throw new DomainError("valor", "Informe o valor final negociado.");
      if (!dados.payment_method) throw new DomainError("forma_pagamento", "Informe a forma de pagamento.");
      const imei = onlyDigits(dados.imei ?? "");
      if (imei && !imeiValido(imei)) throw new DomainError("imei", "Esse IMEI não confere. Confira os 15 dígitos — ou deixe em branco e complete depois.");

      // 1. Vendedor — pessoa canônica + vínculo com a loja (mesma regra do balcão).
      const seller = await demoApi.identidade.criar({ documento: dados.vendedor.cpf, tipo: "pf", nome: dados.vendedor.nome, telefone: dados.vendedor.telefone });
      const det = db.party_details.find((p) => p.party_id === seller.party_id);
      const novoDet = {
        rg_encrypted: dados.vendedor.rg ? await I.cifrarDemo(dados.vendedor.rg.trim()) : det?.rg_encrypted ?? null,
        endereco_encrypted: dados.vendedor.endereco ? await I.cifrarDemo(dados.vendedor.endereco.trim()) : det?.endereco_encrypted ?? null,
        bairro_encrypted: dados.vendedor.bairro ? await I.cifrarDemo(dados.vendedor.bairro.trim()) : det?.bairro_encrypted ?? null,
      };
      if (det) Object.assign(det, novoDet); else db.party_details.push({ ...I.row(), party_id: seller.party_id, ...novoDet });

      // 2. Aparelho — com IMEI: cadastra ou reaproveita o existente (passagem repetida).
      //    Sem IMEI: cria o aparelho sem identificador → "IMEI pendente".
      let device_id: string;
      if (imei) {
        const r = await demoApi.aparelho.criar({ imei, marca: a.brand, modelo: a.model, armazenamento: a.memory ?? "", cor: a.color ?? "" });
        device_id = r.conflito ? r.existente.device!.device_id : r.device_id;
      } else {
        const d = { ...I.row(), brand: a.brand, model: a.model, storage: a.memory, color: a.color };
        db.devices.push(d);
        db.device_events.push({ ...I.row(), device_id: d.id, store_id: store.id, type: "device_created", visibility: "public", transaction_id: null, payload: { marca: d.brand, modelo: d.model, imei_pendente: true } });
        device_id = d.id;
      }

      // 3. Transação PF→PJ + 4. termos congelados a partir da avaliação.
      const loja = await demoApi.estoque.partyDaLoja();
      const t = await demoApi.transacao.criar({ kind: "pf_pj", device_id, seller_party_id: seller.party_id, buyer_party_id: loja.party_id, idempotency_key: `avaliacao:${a.id}` });
      const c = configDaLoja(store.id);
      const perguntas = marcaApple(a.brand) ? c.questionario.apple : c.questionario.android;
      const { estado, defeitos } = resumirEstado(perguntas, a.answers);
      const pix = /pix/i.test(dados.payment_method);
      await demoApi.transacao.congelarTermos(t.id, {
        valor_centavos: Math.round(dados.final_price_centavos), forma_pagamento: dados.payment_method, estado_aparelho: estado, defeitos, garantia: "",
        declaracoes: { ...a.answers, ...(pix && dados.pix_key ? { "Chave Pix": dados.pix_key, "Titular da chave Pix": dados.pix_key_holder ?? "" } : {}), avaliacao_id: a.id, tabela_margem: String(dados.tabela) },
      });
      // 5. Consulta de procedência — só com IMEI. Sem IMEI, fica aguardando dados.
      if (imei) await demoApi.consulta.executar(t.id);

      Object.assign(a, {
        closed_at: I.agora(), final_price_centavos: Math.round(dados.final_price_centavos), payment_method: dados.payment_method,
        pix_key: pix ? dados.pix_key?.trim() || null : null, pix_key_holder: pix ? dados.pix_key_holder?.trim() || null : null,
        seller_party_id: seller.party_id, device_id, transaction_id: t.id, store_name: store.name, margem_tabela: dados.tabela,
      });
      I.auditar(store.id, user.id, "avaliacao.closed", "avaliacao", a.id, { transaction_id: t.id, imei_pendente: !imei });
      I.salvar();
      return view(a.id);
    },

    async completarImei(id, imeiRaw) {
      await I.delay(200);
      const { store, user } = I.sessao();
      const db = I.db();
      const a = db.avaliacoes.find((x) => x.id === id && x.store_id === store.id);
      if (!a || !a.closed_at || !a.device_id || !a.transaction_id) throw new DomainError("avaliacao", "Compra não encontrada.", 404);
      const imei = onlyDigits(imeiRaw);
      if (!imeiValido(imei)) throw new DomainError("imei", "Esse IMEI não confere. Confira os 15 dígitos — provavelmente há um número trocado.");
      if (I.imeiDoDevice(a.device_id)) throw new DomainError("imei_ja", "Este aparelho já tem IMEI. Para corrigir, abra uma contestação.", 409);
      const ativo = db.device_identifiers.find((i) => i.type === "imei" && i.value === imei && i.is_active);
      if (ativo) throw new DomainError("imei_conflito", "Este IMEI já está cadastrado em outro aparelho do Cartório. Confira o número — se estiver certo, a compra precisa ser refeita apontando para o aparelho existente.", 409);
      db.device_identifiers.push({ ...I.row(), device_id: a.device_id, type: "imei", value: imei, is_active: true });
      db.device_events.push({ ...I.row(), device_id: a.device_id, store_id: store.id, type: "imei_completed", visibility: "tenant", transaction_id: a.transaction_id, payload: { por: user.id } });
      await demoApi.consulta.executar(a.transaction_id);
      I.auditar(store.id, user.id, "avaliacao.imei_completed", "avaliacao", a.id);
      I.salvar();
      return view(a.id);
    },

    async excluir(id) {
      await I.delay();
      const { store, user } = I.sessao();
      const db = I.db();
      const a = db.avaliacoes.find((x) => x.id === id && x.store_id === store.id);
      if (!a) throw new DomainError("avaliacao", "Avaliação não encontrada.", 404);
      if (a.transaction_id) {
        const t = db.transactions.find((x) => x.id === a.transaction_id)!;
        if (t.state === "completed") throw new DomainError("append_only", "Este registro já foi concluído no Cartório e não pode ser excluído. Abra uma contestação.", 409);
        if (!["cancelled", "expired"].includes(t.state)) I.mudarEstadoInterno(t, "cancelled");
      }
      db.avaliacoes = db.avaliacoes.filter((x) => x.id !== id);
      I.auditar(store.id, user.id, "avaliacao.deleted", "avaliacao", id);
      I.salvar();
    },

    async notaCompra(id): Promise<NotaCompra> {
      await I.delay(60);
      const { store, user } = I.sessao();
      const db = I.db();
      const a = db.avaliacoes.find((x) => x.id === id && x.store_id === store.id);
      if (!a || !a.closed_at || !a.seller_party_id) throw new DomainError("avaliacao", "Esta avaliação ainda não virou compra.", 404);
      const t = a.transaction_id ? db.transactions.find((x) => x.id === a.transaction_id) ?? null : null;
      const seller = I.partyView(a.seller_party_id);
      const ident = db.party_identifiers.find((i) => i.party_id === a.seller_party_id);
      const det = db.party_details.find((p) => p.party_id === a.seller_party_id);
      const tel = db.party_contacts.find((c) => c.party_id === a.seller_party_id && c.kind === "phone")?.value ?? null;
      const s = db.stores.find((x) => x.id === store.id)!;
      const c = configDaLoja(store.id);
      const perguntas = marcaApple(a.brand) ? c.questionario.apple : c.questionario.android;
      const fotos = (slots: string[]) => db.device_media.filter((m) => m.transaction_id === a.transaction_id && slots.includes(m.slot)).map((m) => m.data_url);
      // Acesso a documento é auditado — LGPD.
      I.auditar(store.id, user.id, "nota_compra.viewed", "avaliacao", a.id, { party_id: a.seller_party_id });
      I.salvar();
      return {
        protocolo: t?.state === "completed" ? t.public_protocol : null,
        registro_estado: t?.state ?? null,
        aceite_grade: t?.state === "completed" ? I.statusAceite(t.id).grade : null,
        concluido_em: t?.completed_at ?? null,
        loja: { nome: s.name, cnpj: formatarCnpj(s.cnpj), cidade: s.city },
        data: a.closed_at,
        aparelho: { descricao: a.device, marca: a.brand, modelo: a.model, memoria: a.memory, cor: a.color, imei: a.device_id ? I.imeiDoDevice(a.device_id) || null : null },
        vendedor: {
          nome: seller.display_name, cpf: ident ? formatarCpf(await I.decifrarDemo(ident.value_encrypted)) : "",
          rg: det?.rg_encrypted ? await I.decifrarDemo(det.rg_encrypted) : null,
          endereco: det?.endereco_encrypted ? await I.decifrarDemo(det.endereco_encrypted) : null,
          bairro: det?.bairro_encrypted ? await I.decifrarDemo(det.bairro_encrypted) : null,
          telefone: tel,
        },
        valor: formatarCentavos(a.final_price_centavos ?? 0),
        forma_pagamento: a.payment_method ?? "—",
        pix_key: a.pix_key, pix_key_holder: a.pix_key_holder,
        checklist: perguntas.filter((q) => a.answers[q.key]).map((q) => ({ pergunta: q.key, resposta: a.answers[q.key] })),
        fotos: { documento: fotos(["documento", "selfie"]), aparelho: fotos(["frente_ligada", "traseira", "tela_imei", "laterais", "avarias"]), comprovante: fotos(["comprovante"]) },
        link_certificado: t?.state === "completed" ? `${location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}/certificado/${t.public_protocol}` : null,
      };
    },
  },

  async notaVenda(transaction_id): Promise<NotaVenda> {
    await I.delay(60);
    const { store, user } = I.sessao();
    const db = I.db();
    const t = db.transactions.find((x) => x.id === transaction_id && x.store_id === store.id);
    if (!t || t.state !== "completed" || t.kind !== "pj_pf") throw new DomainError("venda", "Nota de venda só existe para venda concluída.", 404);
    const tv = I.txView(t.id);
    const buyer = tv.parties.find((p) => p.role === "buyer")!;
    const ident = db.party_identifiers.find((i) => i.party_id === buyer.party_id);
    const tel = db.party_contacts.find((c) => c.party_id === buyer.party_id && c.kind === "phone")?.value ?? null;
    const s = db.stores.find((x) => x.id === store.id)!;
    const p = tv.terms!.payload;
    I.auditar(store.id, user.id, "nota_venda.viewed", "transaction", t.id);
    I.salvar();
    return {
      protocolo: t.public_protocol, aceite_grade: tv.aceite.grade, concluido_em: t.completed_at!,
      loja: { nome: s.name, cnpj: formatarCnpj(s.cnpj), cidade: s.city },
      aparelho: { descricao: [tv.device?.brand, tv.device?.model, tv.device?.storage, tv.device?.color].filter(Boolean).join(" "), imei: I.imeiDoDevice(tv.device!.device_id) },
      comprador: { nome: buyer.display_name, cpf: ident ? formatarCpf(await I.decifrarDemo(ident.value_encrypted)) : "", telefone: tel },
      valor: formatarCentavos(p.valor_centavos), forma_pagamento: p.forma_pagamento, garantia: p.garantia || "não informada",
      estado_declarado: p.estado_aparelho, defeitos_declarados: p.defeitos || "nenhum",
      consulta: tv.check ? { resultado: tv.check.result, fonte: tv.check.provider, data: tv.check.checked_at } : null,
      link_certificado: `${location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}/certificado/${t.public_protocol}`,
    };
  },

  erp: {
    async enviar(transaction_id): Promise<ErpEnvio> {
      await I.delay(500);
      const { store, user } = I.sessao();
      const db = I.db();
      const t = db.transactions.find((x) => x.id === transaction_id && x.store_id === store.id);
      if (!t || t.state !== "completed") throw new DomainError("erp", "Só compras e vendas concluídas no Cartório vão para o ERP.", 409);
      const erp = cfg<ErpCfgInterno>(store.id, CFG.erp, ERP_PADRAO);
      if (!erp.ativo) throw new DomainError("erp_inativo", "A integração com o ERP está desligada. Ative em Configurações → Integração ERP.", 409);
      const tipo: "compra" | "venda" = t.kind === "pj_pf" ? "venda" : "compra";
      if (tipo === "compra" && !erp.enviar_compras) throw new DomainError("erp", "O envio de compras ao ERP está desligado.", 409);
      if (tipo === "venda" && !erp.enviar_vendas) throw new DomainError("erp", "O envio de vendas ao ERP está desligado.", 409);
      const tv = I.txView(t.id);
      const payload = montarPayloadErp(tv, tipo, erp.solicitar_nfe);
      // Demonstração: não há ERP na outra ponta. Registra como "simulado" com
      // a referência que o ERP devolveria. Em produção a Edge Function `erp`
      // faz o POST e grava a resposta real.
      const envio = { ...I.row(), store_id: store.id, transaction_id, tipo, status: "simulado" as const, erp_ref: `DP-${t.public_protocol}`, nfe_status: erp.solicitar_nfe ? "aguardando módulo fiscal do ERP" : "não solicitada", mensagem: "Demonstração: nenhum ERP foi chamado. Payload pronto para o Sheik Company ERP (POST /device-purchases).", payload };
      db.erp_envios.push(envio);
      db.outbox.push({ ...I.row(), topic: `erp.${tipo}.sent`, store_id: store.id, payload: { transaction_id, erp_ref: envio.erp_ref }, processed_at: I.agora() });
      I.auditar(store.id, user.id, "erp.sent", "transaction", transaction_id, { tipo, status: envio.status });
      I.salvar();
      const { payload: _p, store_id: _s, ...pub } = envio;
      return pub;
    },
    async envios(transaction_id) {
      const { store } = I.sessao();
      return I.db().erp_envios.filter((e) => e.store_id === store.id && e.transaction_id === transaction_id).map(({ payload: _p, store_id: _s, ...pub }) => pub);
    },
  },
};

/** Payload que vai para o ERP — espelha o DevicePurchase / venda do Sheik Company ERP. */
export function montarPayloadErp(tv: ReturnType<typeof I.txView>, tipo: "compra" | "venda", solicitarNfe: boolean) {
  const p = tv.terms!.payload;
  return {
    origem: "cartorio-do-celular",
    protocolo: tv.public_protocol,
    tipo,
    solicitar_nfe: solicitarNfe,
    aparelho: { device_id: tv.device?.device_id, marca: tv.device?.brand, modelo: tv.device?.model, armazenamento: tv.device?.storage, cor: tv.device?.color, imei_mascarado: tv.device?.imei_mascarado },
    partes: tv.parties.map((x) => ({ party_id: x.party_id, papel: x.role, loja: x.is_tenant_side })),
    valor_centavos: p.valor_centavos,
    forma_pagamento: p.forma_pagamento,
    garantia: p.garantia,
    declarado: { estado: p.estado_aparelho, defeitos: p.defeitos, ...(p.declaracoes ?? {}) },
    consulta: tv.check ? { resultado: tv.check.result, fonte: tv.check.provider, data: tv.check.checked_at } : null,
    aceite: tv.aceite.grade,
    concluido_em: tv.completed_at,
  };
}

// Recálculo de oferta para a interface (sem chamar o servidor).
export { recalcularOferta };
