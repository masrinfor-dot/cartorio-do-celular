import { describe, expect, it } from "vitest";
import { LOTE_MAX_ITENS, fotosDispensadas, impressaoDigitalLote, itemPodeEntrarNoConvite, validarItensLote } from "@core/index.ts";

describe("lote PJ→PJ — validação", () => {
  const ok = [{ device_id: "a", valor_centavos: 100000 }, { device_id: "b", valor_centavos: 90000 }];
  it("aceita itens válidos", () => expect(() => validarItensLote(ok)).not.toThrow());
  it("recusa lote vazio", () => expect(() => validarItensLote([])).toThrow(/ao menos um/));
  it("recusa aparelho repetido", () => expect(() => validarItensLote([ok[0], ok[0]])).toThrow(/duas vezes/));
  it("recusa valor zerado, negativo ou quebrado", () => {
    for (const v of [0, -5, 10.5]) expect(() => validarItensLote([{ device_id: "a", valor_centavos: v }])).toThrow(/valor/);
  });
  it("recusa lote acima do máximo", () => {
    const grande = Array.from({ length: LOTE_MAX_ITENS + 1 }, (_, i) => ({ device_id: `d${i}`, valor_centavos: 1000 }));
    expect(() => validarItensLote(grande)).toThrow(/no máximo/);
  });
});

describe("lote PJ→PJ — impressão digital do aceite", () => {
  const a = { transaction_id: "t1", terms_hash: "h1" };
  const b = { transaction_id: "t2", terms_hash: "h2" };
  it("não depende da ordem dos itens", async () => expect(await impressaoDigitalLote([a, b])).toBe(await impressaoDigitalLote([b, a])));
  it("muda se os termos de UM item mudarem", async () => expect(await impressaoDigitalLote([a, b])).not.toBe(await impressaoDigitalLote([a, { ...b, terms_hash: "h2-alterado" }])));
  it("muda se um item sair do lote", async () => expect(await impressaoDigitalLote([a, b])).not.toBe(await impressaoDigitalLote([a])));
});

describe("lote PJ→PJ — quem entra no convite e a dispensa de fotos", () => {
  it("só entra no convite quem passou pela consulta", () => {
    for (const s of ["awaiting_seller", "awaiting_buyer", "ready_to_complete"]) expect(itemPodeEntrarNoConvite(s)).toBe(true);
    for (const s of ["blocked", "under_review", "awaiting_checks", "draft", "cancelled", "expired"]) expect(itemPodeEntrarNoConvite(s)).toBe(false);
  });
  it("fotos dispensadas só em comunicação PF→PF e em lote PJ→PJ", () => {
    expect(fotosDispensadas("pj_pj", "lote_pj")).toBe(true);
    expect(fotosDispensadas("pf_pf", "comunicacao_de_venda")).toBe(true);
    expect(fotosDispensadas("pj_pf", "lote_pj")).toBe(false);   // lote não vale para venda ao consumidor
    expect(fotosDispensadas("pf_pj", "lote_pj")).toBe(false);   // nem para entrada
    expect(fotosDispensadas("pj_pj", undefined)).toBe(false);
    expect(fotosDispensadas("pj_pj", "comunicacao_de_venda")).toBe(false);
  });
});
