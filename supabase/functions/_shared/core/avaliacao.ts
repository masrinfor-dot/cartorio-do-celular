// Avaliação de usados — portado do módulo "Avaliação de Usados" do Sheik CRM
// (branch producao, set/2026). Lógica pura, sem I/O: questionário por marca
// (com opções que bloqueiam e desconto por resposta), tabelas de margem,
// tabela de valores base, estimativa determinística e recálculo de oferta.

import { DomainError } from "./types.ts";

// ---------------------------------------------------------------------------
// Listas de apoio (sugestões — o operador pode digitar outro)
// ---------------------------------------------------------------------------
export const MARCAS = ["Apple", "Samsung", "Motorola", "Xiaomi", "Realme", "Outra"];
export const MODELOS_POR_MARCA: Record<string, string[]> = {
  Apple: ["iPhone 8", "iPhone X", "iPhone XR", "iPhone 11", "iPhone 11 Pro", "iPhone 12", "iPhone 12 Pro", "iPhone 13", "iPhone 13 Pro", "iPhone 14", "iPhone 14 Pro", "iPhone 15", "iPhone 15 Pro", "iPhone 16", "iPhone 16 Pro", "iPhone 16 Pro Max"],
  Samsung: ["Galaxy A05", "Galaxy A15", "Galaxy A25", "Galaxy A35", "Galaxy A55", "Galaxy M15", "Galaxy S21", "Galaxy S22", "Galaxy S23", "Galaxy S24", "Galaxy Z Flip 5"],
  Motorola: ["Moto E14", "Moto G04", "Moto G24", "Moto G54", "Moto G84", "Edge 40", "Edge 50"],
  Xiaomi: ["Redmi 13C", "Redmi Note 12", "Redmi Note 13", "Redmi Note 13 Pro", "Poco X6", "Poco X6 Pro"],
  Realme: ["C53", "C61", "Note 50", "11 Pro"],
};
export const MEMORIAS = ["16GB", "32GB", "64GB", "128GB", "256GB", "512GB", "1TB"];
export const CORES = ["Preto", "Branco", "Azul", "Verde", "Roxo", "Dourado", "Prata", "Rosa", "Vermelho", "Grafite", "Titânio"];

export const marcaApple = (marca: string) => /apple|iphone/i.test(marca);

// ---------------------------------------------------------------------------
// Questionário (checklist) — editável por loja
// ---------------------------------------------------------------------------
export type OpcaoPergunta = { label: string; blocks: boolean; deductionPercent?: number };
export type Pergunta = { key: string; label: string; options: OpcaoPergunta[] };
export type QuestionarioConfig = { apple: Pergunta[]; android: Pergunta[] };

const COMUNS: Pergunta[] = [
  { key: "Liga", label: "O aparelho liga? (tela acende, sistema inicia e o toque na tela funciona)", options: [{ label: "Sim", blocks: false }, { label: "Não liga", blocks: true }] },
  { key: "Ligações", label: "Faz e recebe ligações pela rede móvel? (chip/operadora — não vale WhatsApp)", options: [{ label: "Sim", blocks: false }, { label: "Não faz ligações", blocks: true }] },
  { key: "Wi-Fi e Bluetooth", label: "Wi-Fi e Bluetooth funcionam normalmente? (conecta, navega e recebe arquivos)", options: [{ label: "Sim", blocks: false }, { label: "Não funciona", blocks: true }] },
  { key: "Marcas de uso", label: "Tem marcas de uso?", options: [{ label: "Sem marcas de uso", blocks: false }, { label: "Quase imperceptíveis", blocks: false, deductionPercent: 5 }, { label: "Marcas visíveis", blocks: false, deductionPercent: 12 }] },
  { key: "Carcaça / traseira", label: "Traseira ou laterais trincadas, rachadas, descascando, com peças faltando ou riscos?", options: [{ label: "Não", blocks: false }, { label: "Sim, com avarias", blocks: false, deductionPercent: 15 }] },
  { key: "Tela", label: "Tela quebrada, trincada, riscada ou com mancha/burn-in (tela fantasma, pixel queimado, LCD vazando)?", options: [{ label: "Não", blocks: false }, { label: "Sim, com avarias", blocks: false, deductionPercent: 30 }] },
  { key: "Câmeras", label: "As câmeras (frontal e traseira) abrem e registram fotos normalmente?", options: [{ label: "Sem problemas", blocks: false }, { label: "Com problema", blocks: true }] },
  { key: "Acessórios", label: "Acompanha acessórios?", options: [{ label: "Caixa e carregador originais", blocks: false }, { label: "Só carregador", blocks: false }, { label: "Sem acessórios", blocks: false, deductionPercent: 3 }] },
];

export const QUESTIONARIO_PADRAO: QuestionarioConfig = {
  apple: [
    ...COMUNS.slice(0, 6),
    { key: "Biometria", label: "Face ID / Touch ID funciona e cadastra nova biometria?", options: [{ label: "Funciona", blocks: false }, { label: "Não funciona", blocks: true }, { label: "Não tem", blocks: false }] },
    COMUNS[6],
    { key: "Saúde da bateria", label: "Qual o nível de saúde da bateria (Ajustes → Bateria)?", options: [{ label: "Superior a 90%", blocks: false }, { label: "Entre 80% e 90%", blocks: false, deductionPercent: 5 }, { label: "Inferior a 80%", blocks: false, deductionPercent: 12 }] },
    { key: "Peça não genuína", label: "Aparece mensagem de \"peça não genuína ou desconhecida\" (Ajustes → Bateria)?", options: [{ label: "Não", blocks: false }, { label: "Sim, aparece", blocks: false, deductionPercent: 10 }] },
    COMUNS[7],
    { key: "Conta desvinculada", label: "iCloud (Buscar iPhone) já desvinculado?", options: [{ label: "Sim", blocks: false }, { label: "Ainda não", blocks: false }] },
  ],
  android: [
    ...COMUNS.slice(0, 6),
    { key: "Biometria", label: "Leitor de digital / desbloqueio facial funciona e cadastra nova biometria?", options: [{ label: "Funciona", blocks: false }, { label: "Não funciona", blocks: true }, { label: "Não tem", blocks: false }] },
    COMUNS[6],
    { key: "Bateria", label: "Como está a bateria?", options: [{ label: "Segura bem a carga", blocks: false }, { label: "Descarrega rápido", blocks: false, deductionPercent: 10 }, { label: "Ruim / estufada", blocks: false, deductionPercent: 25 }] },
    COMUNS[7],
    { key: "Conta desvinculada", label: "Conta Google já desvinculada?", options: [{ label: "Sim", blocks: false }, { label: "Ainda não", blocks: false }] },
  ],
};

/** Sanitiza a configuração vinda do admin. Devolve a config ou um erro legível. */
export function sanitizarQuestionario(input: unknown): { config?: QuestionarioConfig; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "Configuração inválida" };
  const out: QuestionarioConfig = { apple: [], android: [] };
  for (const grupo of ["apple", "android"] as const) {
    const lista = (input as Record<string, unknown>)[grupo];
    if (!Array.isArray(lista)) return { error: `Lista de perguntas inválida (${grupo})` };
    if (lista.length === 0) return { error: `Inclua pelo menos 1 pergunta (${grupo === "apple" ? "Apple" : "Android"})` };
    if (lista.length > 30) return { error: "Máximo de 30 perguntas por marca" };
    const chaves = new Set<string>();
    for (const raw of lista) {
      if (!raw || typeof raw !== "object") return { error: "Pergunta inválida" };
      const q = raw as Record<string, unknown>;
      const key = typeof q.key === "string" ? q.key.trim().slice(0, 60) : "";
      const label = typeof q.label === "string" ? q.label.trim().slice(0, 200) : "";
      if (!key || !label) return { error: "Toda pergunta precisa de título curto e texto" };
      if (chaves.has(key)) return { error: `Título curto repetido: "${key}"` };
      chaves.add(key);
      if (!Array.isArray(q.options) || q.options.length < 2) return { error: `A pergunta "${key}" precisa de pelo menos 2 opções` };
      if (q.options.length > 8) return { error: `Máximo de 8 opções por pergunta ("${key}")` };
      const options: OpcaoPergunta[] = [];
      const vistos = new Set<string>();
      for (const rawOpt of q.options) {
        const o = rawOpt as Record<string, unknown> | null;
        const oLabel = o && typeof o.label === "string" ? o.label.trim().slice(0, 80) : "";
        if (!oLabel) return { error: `Opção sem texto na pergunta "${key}"` };
        if (vistos.has(oLabel)) return { error: `Opção repetida na pergunta "${key}": "${oLabel}"` };
        vistos.add(oLabel);
        const dedRaw = Number(o?.deductionPercent);
        const deductionPercent = Number.isFinite(dedRaw) ? Math.max(0, Math.min(100, Math.round(dedRaw))) : 0;
        options.push({ label: oLabel, blocks: Boolean(o?.blocks), ...(deductionPercent > 0 ? { deductionPercent } : {}) });
      }
      if (options.every((o) => o.blocks)) return { error: `A pergunta "${key}" não pode ter todas as opções bloqueando` };
      out[grupo].push({ key, label, options });
    }
  }
  return { config: out };
}

export type Respostas = Record<string, string>;

/**
 * Validação ESTRITA das respostas contra o questionário: nenhuma chave
 * desconhecida, toda pergunta respondida, cada valor uma opção configurada,
 * e opção que bloqueia → recusa (a loja não avalia). Sem isso, dá para burlar
 * o bloqueio chamando a API direto.
 */
export function validarRespostas(perguntas: Pergunta[], respostas: Respostas): { ok: true } | { ok: false; status: 400 | 422; error: string } {
  const porChave = new Map(perguntas.map((q) => [q.key, q]));
  for (const key of Object.keys(respostas)) {
    if (!porChave.has(key)) return { ok: false, status: 400, error: `Pergunta desconhecida no questionário: "${key}". Recarregue a página e tente novamente.` };
  }
  for (const q of perguntas) {
    const val = respostas[q.key];
    if (!val) return { ok: false, status: 400, error: `Responda a pergunta "${q.key}" para avaliar.` };
    const opt = q.options.find((o) => o.label === val);
    if (!opt) return { ok: false, status: 400, error: `Resposta inválida para "${q.key}". Recarregue a página e tente novamente.` };
    if (opt.blocks) return { ok: false, status: 422, error: `Não avaliamos aparelho com parte sem funcionar (${q.key.toLowerCase()}: "${val}").` };
  }
  return { ok: true };
}

export function exigirRespostasValidas(perguntas: Pergunta[], respostas: Respostas): void {
  const v = validarRespostas(perguntas, respostas);
  if (!v.ok) throw new DomainError("questionario", v.error, v.status);
}

/** Soma o desconto (%) das respostas marcadas, limitado a 90. */
export function descontoTotalPercent(perguntas: Pergunta[], respostas: Respostas): number {
  let total = 0;
  for (const q of perguntas) {
    const opt = q.options.find((o) => o.label === respostas[q.key]);
    total += opt?.deductionPercent ?? 0;
  }
  return Math.min(90, total);
}

/** Resumo do estado em uma frase, para os termos e para a nota. */
export function resumirEstado(perguntas: Pergunta[], respostas: Respostas): { estado: string; defeitos: string } {
  const comDesconto = perguntas
    .filter((q) => (q.options.find((o) => o.label === respostas[q.key])?.deductionPercent ?? 0) > 0)
    .map((q) => `${q.key}: ${respostas[q.key]}`);
  const pct = descontoTotalPercent(perguntas, respostas);
  const estado = pct === 0 ? "Excelente" : pct <= 10 ? "Bom" : pct <= 25 ? "Regular" : "Com avarias";
  return { estado, defeitos: comDesconto.join("; ") };
}

// ---------------------------------------------------------------------------
// Margens e formas de pagamento
// ---------------------------------------------------------------------------
export type Margens = { t1: number; t2: number; t3: number };
export const MARGENS_PADRAO: Margens = { t1: 40, t2: 30, t3: 20 };
export type TabelaMargem = 1 | 2 | 3;
export const TABELAS_MARGEM: Array<{ table: TabelaMargem; key: keyof Margens; label: string }> = [
  { table: 1, key: "t1", label: "Margem maior" },
  { table: 2, key: "t2", label: "Margem média" },
  { table: 3, key: "t3", label: "Margem menor" },
];

export function sanitizarMargens(input: unknown): Margens {
  const p = (input ?? {}) as Partial<Margens>;
  const norm = (v: unknown, d: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 1 && n <= 90 ? n : d; };
  return { t1: norm(p.t1, MARGENS_PADRAO.t1), t2: norm(p.t2, MARGENS_PADRAO.t2), t3: norm(p.t3, MARGENS_PADRAO.t3) };
}

export function margemDaTabela(m: Margens, t: TabelaMargem): number {
  return t === 1 ? m.t1 : t === 2 ? m.t2 : m.t3;
}

export const FORMAS_PAGAMENTO_PADRAO = ["Dinheiro", "Pix", "Cartão de débito", "Cartão de crédito", "Transferência bancária", "Troca", "Outro"];

export function sanitizarFormasPagamento(input: unknown): { methods?: string[]; error?: string } {
  if (!Array.isArray(input)) return { error: "Lista de formas de pagamento inválida" };
  if (input.length === 0) return { error: "Inclua pelo menos 1 forma de pagamento" };
  if (input.length > 20) return { error: "Máximo de 20 formas de pagamento" };
  const out: string[] = [];
  const vistos = new Set<string>();
  for (const raw of input) {
    const label = typeof raw === "string" ? raw.trim().slice(0, 40) : "";
    if (!label) return { error: "Toda forma de pagamento precisa de um nome" };
    if (vistos.has(label.toLowerCase())) return { error: `Forma de pagamento repetida: "${label}"` };
    vistos.add(label.toLowerCase());
    out.push(label);
  }
  return { methods: out };
}

// ---------------------------------------------------------------------------
// Tabela de valores base e estimativa determinística
// ---------------------------------------------------------------------------
export type ValorBase = { brand: string; model: string; storage: string | null; baseValue: number };

export function normalizarChave(v: string | null | undefined): string {
  return (v ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

/** Melhor linha para marca/modelo/armazenamento: exato → sem armazenamento (coringa) → primeira do modelo. */
export function acharValorBase(linhas: ValorBase[], brand: string, model: string, storage: string | null): ValorBase | null {
  const nb = normalizarChave(brand), nm = normalizarChave(model), ns = normalizarChave(storage);
  const doModelo = linhas.filter((r) => normalizarChave(r.brand) === nb && normalizarChave(r.model) === nm);
  if (doModelo.length === 0) return null;
  const exato = doModelo.find((r) => ns !== "" && normalizarChave(r.storage) === ns);
  if (exato) return exato;
  return doModelo.find((r) => !r.storage) ?? doModelo[0] ?? null;
}

/** Importa linhas "Marca;Modelo;Armazenamento;Valor" (uma por linha). */
export function importarValoresBase(texto: string): { linhas: ValorBase[]; erros: string[] } {
  const linhas: ValorBase[] = [];
  const erros: string[] = [];
  texto.split(/\r?\n/).forEach((l, i) => {
    const t = l.trim();
    if (!t) return;
    const partes = t.split(/[;\t]/).map((p) => p.trim());
    if (partes.length < 4) { erros.push(`Linha ${i + 1}: use Marca;Modelo;Armazenamento;Valor`); return; }
    const valor = Number(partes[3].replace(/[R$\s.]/g, "").replace(",", "."));
    if (!partes[0] || !partes[1] || !(valor > 0)) { erros.push(`Linha ${i + 1}: marca, modelo e valor são obrigatórios`); return; }
    linhas.push({ brand: partes[0], model: partes[1], storage: partes[2] || null, baseValue: Math.round(valor * 100) / 100 });
  });
  return { linhas, erros };
}

export interface Estimativa {
  metodo: "tabela" | "ia" | "manual";
  /** Valor de revenda (perfeito estado) em centavos, quando conhecido. */
  valor_base_centavos: number | null;
  faixa_mercado: string | null;
  /** Sugestão de compra em centavos, já com margem e descontos. */
  sugestao_centavos: number;
  margem_tabela: TabelaMargem;
  margem_pct: number;
  desconto_pct: number;
  justificativa: string;
}

/**
 * Estimativa pela tabela de valores base (sem IA):
 * sugestão = base × (100 − margem)/100 × (1 − desconto/100), arredondada de 10 em 10.
 */
export function estimarPelaTabela(opts: { linhas: ValorBase[]; brand: string; model: string; memory: string | null; perguntas: Pergunta[]; respostas: Respostas; margens: Margens; tabela: TabelaMargem }): Estimativa | null {
  const match = acharValorBase(opts.linhas, opts.brand, opts.model, opts.memory);
  if (!match) return null;
  const margem_pct = margemDaTabela(opts.margens, opts.tabela);
  const desconto_pct = descontoTotalPercent(opts.perguntas, opts.respostas);
  const baseCent = Math.round(match.baseValue * 100);
  const sug = Math.max(0, Math.round((baseCent * ((100 - margem_pct) / 100) * (1 - desconto_pct / 100)) / 1000) * 1000);
  return {
    metodo: "tabela",
    valor_base_centavos: baseCent,
    faixa_mercado: null,
    sugestao_centavos: sug,
    margem_tabela: opts.tabela,
    margem_pct,
    desconto_pct,
    justificativa: `Valor base da tabela da loja (${match.brand} ${match.model}${match.storage ? " " + match.storage : ""}) com margem de ${margem_pct}%${desconto_pct ? ` e ${desconto_pct}% de desconto pelo estado declarado` : ""}.`,
  };
}

/** Recalcula a sugestão ao trocar de tabela: novo = atual × (100 − nova) / (100 − original), de 10 em 10. */
export function recalcularOferta(sugestaoCent: number, margens: Margens, tabelaOriginal: TabelaMargem, tabelaNova: TabelaMargem): number {
  if (tabelaOriginal === tabelaNova) return sugestaoCent;
  const pagaOrig = 100 - margemDaTabela(margens, tabelaOriginal);
  const pagaNova = 100 - margemDaTabela(margens, tabelaNova);
  if (pagaOrig <= 0) return sugestaoCent;
  return Math.round((sugestaoCent * pagaNova) / pagaOrig / 1000) * 1000;
}

/** Lê "R$ 1.800", "1800", "1.800,50" → centavos. */
export function parseReais(v: string | null | undefined): number {
  const m = (v ?? "").replace(/\./g, "").replace(",", ".").match(/(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
