import { describe, it, expect } from "vitest";
import {
  QUESTIONARIO_PADRAO, sanitizarQuestionario, validarRespostas, descontoTotalPercent, resumirEstado,
  sanitizarMargens, acharValorBase, importarValoresBase, estimarPelaTabela, recalcularOferta, parseReais,
  sanitizarFormasPagamento, MARGENS_PADRAO,
} from "../supabase/functions/_shared/core/avaliacao.ts";

const apple = QUESTIONARIO_PADRAO.apple;
const perfeito = Object.fromEntries(apple.map((q) => [q.key, q.options[0].label]));

describe("Questionário", () => {
  it("valida respostas completas e recusa pergunta desconhecida", () => {
    expect(validarRespostas(apple, perfeito).ok).toBe(true);
    expect(validarRespostas(apple, { ...perfeito, Inventada: "x" })).toMatchObject({ ok: false, status: 400 });
  });
  it("opção que bloqueia → 422", () => {
    expect(validarRespostas(apple, { ...perfeito, Liga: "Não liga" })).toMatchObject({ ok: false, status: 422 });
  });
  it("falta resposta → 400", () => {
    const { Tela: _t, ...semTela } = perfeito;
    expect(validarRespostas(apple, semTela)).toMatchObject({ ok: false, status: 400 });
  });
  it("soma descontos e resume o estado", () => {
    const r = { ...perfeito, Tela: "Sim, com avarias", "Marcas de uso": "Marcas visíveis" };
    expect(descontoTotalPercent(apple, r)).toBe(42);
    expect(resumirEstado(apple, r).estado).toBe("Com avarias");
    expect(resumirEstado(apple, perfeito).estado).toBe("Excelente");
  });
  it("sanitiza config do admin", () => {
    expect(sanitizarQuestionario(QUESTIONARIO_PADRAO).config).toBeTruthy();
    expect(sanitizarQuestionario({ apple: [], android: [] }).error).toMatch(/pelo menos 1/);
    expect(sanitizarQuestionario({ apple: [{ key: "A", label: "a?", options: [{ label: "x", blocks: true }, { label: "y", blocks: true }] }], android: apple }).error).toMatch(/bloqueando/);
  });
});

describe("Margens, valores base e estimativa", () => {
  it("margens fora da faixa caem no padrão", () => {
    expect(sanitizarMargens({ t1: 95, t2: "abc", t3: 15 })).toEqual({ t1: 40, t2: 30, t3: 15 });
  });
  const linhas = importarValoresBase("Apple;iPhone 13;128GB;2000\nApple;iPhone 13;;1800\nSamsung;Galaxy S23;;1500").linhas;
  it("importa e casa por marca/modelo/armazenamento", () => {
    expect(linhas.length).toBe(3);
    expect(acharValorBase(linhas, "apple", "IPHONE  13", "128gb")?.baseValue).toBe(2000);
    expect(acharValorBase(linhas, "Apple", "iPhone 13", "256GB")?.baseValue).toBe(1800);
    expect(acharValorBase(linhas, "Apple", "iPhone 15", null)).toBeNull();
  });
  it("estimativa determinística: base × (1 − margem) × (1 − desconto), de 10 em 10", () => {
    const e = estimarPelaTabela({ linhas, brand: "Apple", model: "iPhone 13", memory: "128GB", perguntas: apple, respostas: perfeito, margens: MARGENS_PADRAO, tabela: 2 })!;
    expect(e.metodo).toBe("tabela");
    expect(e.sugestao_centavos).toBe(140000); // 2000 × 0,70
    const e3 = estimarPelaTabela({ linhas, brand: "Apple", model: "iPhone 13", memory: "128GB", perguntas: apple, respostas: { ...perfeito, Tela: "Sim, com avarias" }, margens: MARGENS_PADRAO, tabela: 3 })!;
    expect(e3.sugestao_centavos).toBe(112000); // 2000 × 0,80 × 0,70
  });
  it("recalcula a oferta ao trocar a tabela", () => {
    expect(recalcularOferta(360000, MARGENS_PADRAO, 3, 1)).toBe(270000); // 3600 × 60/80
    expect(recalcularOferta(360000, MARGENS_PADRAO, 3, 3)).toBe(360000);
  });
  it("parseReais aceita os formatos do balcão", () => {
    expect(parseReais("R$ 1.800")).toBe(180000);
    expect(parseReais("1800,50")).toBe(180050);
    expect(parseReais("")).toBe(0);
  });
  it("formas de pagamento sem repetição", () => {
    expect(sanitizarFormasPagamento(["Pix", "pix"]).error).toMatch(/repetida/);
    expect(sanitizarFormasPagamento(["Pix", "Dinheiro"]).methods).toEqual(["Pix", "Dinheiro"]);
  });
});
