import { describe, expect, it } from "vitest";
import { deveExpirar, garantiaDe, prazoGarantiaDias, PRAZO_PARADA_DIAS } from "@core/index.ts";

const agora = new Date("2026-10-10T12:00:00Z");
const dias = (n: number) => new Date(agora.getTime() - n * 86_400_000).toISOString();

describe("expiração de transações paradas", () => {
  it("expira aberta e parada há mais que o prazo", () => expect(deveExpirar("awaiting_buyer", dias(PRAZO_PARADA_DIAS + 1), agora)).toBe(true));
  it("não expira dentro do prazo", () => expect(deveExpirar("awaiting_buyer", dias(PRAZO_PARADA_DIAS - 1), agora)).toBe(false));
  it("nunca mexe em estados encerrados nem bloqueados", () => {
    for (const s of ["completed", "cancelled", "expired", "disputed", "blocked"] as const) expect(deveExpirar(s, dias(90), agora)).toBe(false);
  });
  it("data inválida não expira", () => expect(deveExpirar("draft", "ontem", agora)).toBe(false));
});

describe("prazo de garantia", () => {
  it.each([["90 dias", 90], ["3 meses", 90], ["1 ano", 365], ["6 meses de garantia", 180], ["Garantia de 30 Dias", 30], ["12m", 360]])("%s → %s", (t, d) => expect(prazoGarantiaDias(t)).toBe(d));
  it.each(["", "Sem garantia", "não informada", "garantia da loja", "0 dias"])("sem prazo legível: %j", (t) => expect(prazoGarantiaDias(t)).toBeNull());
  it("situação: vigente, vence em breve, vencida", () => {
    expect(garantiaDe(dias(10), "90 dias", agora)?.situacao).toBe("vigente");
    expect(garantiaDe(dias(85), "90 dias", agora)?.situacao).toBe("vence_em_breve");
    expect(garantiaDe(dias(85), "90 dias", agora)?.dias_restantes).toBe(5);
    expect(garantiaDe(dias(100), "90 dias", agora)?.situacao).toBe("vencida");
  });
  it("registro não concluído ou sem prazo não tem garantia", () => {
    expect(garantiaDe(null, "90 dias", agora)).toBeNull();
    expect(garantiaDe(dias(1), "Sem garantia", agora)).toBeNull();
  });
});
