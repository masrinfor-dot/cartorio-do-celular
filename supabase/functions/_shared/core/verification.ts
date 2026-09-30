import { DomainError, type CheckResult } from "./types.ts";
import { onlyDigits } from "./validation.ts";

export interface CheckOutcome {
  provider: string;
  result: CheckResult;
  checked_at: string;
  valid_until: string | null;
  raw: Record<string, unknown>;
}

/** Validade padrão de uma consulta: 24 horas. */
export const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * SIMULADOR de consulta de procedência, com o contrato de um provedor real.
 * Para testar: IMEI terminado em 0 → restricted, 1 → inconclusive,
 * 2 → unavailable, o resto → clear.
 */
export function simularConsulta(imei: string, agora = new Date()): CheckOutcome {
  const p = onlyDigits(imei);
  const ultimo = p.slice(-1);
  const result: CheckResult =
    ultimo === "0" ? "restricted" : ultimo === "1" ? "inconclusive" : ultimo === "2" ? "unavailable" : "clear";
  const checked_at = agora.toISOString();
  const valid_until = result === "unavailable" ? null : new Date(agora.getTime() + CHECK_TTL_MS).toISOString();
  return {
    provider: "simulador",
    result,
    checked_at,
    valid_until,
    raw: {
      simulado: true,
      fonte: "Simulador interno — nenhuma base oficial foi consultada",
      regra: "último dígito do IMEI",
    },
  };
}

/** Uma consulta gravada é válida se não venceu. */
export function consultaVigente(check: { result: CheckResult; valid_until: string | null }, agora = new Date()): CheckResult {
  if (check.result === "unavailable") return "unavailable";
  if (check.valid_until && new Date(check.valid_until).getTime() < agora.getTime()) return "expired";
  return check.result;
}

/**
 * O gate. SÓ 'clear' libera. 'unavailable' NÃO libera — se liberasse, bastaria
 * derrubar a consulta para registrar qualquer aparelho.
 */
export function exigirProcedenciaLiberada(result: CheckResult | null): void {
  if (result === "clear") return;
  const msg: Record<Exclude<CheckResult, "clear">, string> = {
    restricted: "Consta restrição para este aparelho na consulta feita. A transação fica bloqueada.",
    inconclusive: "A consulta ficou inconclusiva. Refaça a consulta antes de concluir.",
    unavailable: "A consulta de procedência está indisponível no momento. Sem consulta, não há conclusão — tente de novo em instantes.",
    expired: "A consulta de procedência venceu. Consulte de novo antes de concluir.",
  };
  throw new DomainError(
    "procedencia_nao_liberada",
    result ? msg[result] : "Ainda não foi feita a consulta de procedência deste aparelho.",
    409,
  );
}

/** Texto neutro para a tela — sempre com a data. Nunca "aparelho limpo", nunca "roubado". */
export function descreverConsulta(c: CheckOutcome | null, agora = new Date()): { titulo: string; detalhe: string; tom: "ok" | "alerta" | "bloqueio" | "neutro" } {
  if (!c) return { titulo: "Consulta ainda não feita", detalhe: "", tom: "neutro" };
  const quando = new Date(c.checked_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  const vig = consultaVigente(c, agora);
  switch (vig) {
    case "clear":
      return { titulo: "Sem restrição na consulta", detalhe: `Consulta de ${quando}, fonte: ${c.provider}.`, tom: "ok" };
    case "restricted":
      return { titulo: "Consta restrição", detalhe: `Restrição na base ${c.provider} em ${quando}.`, tom: "bloqueio" };
    case "inconclusive":
      return { titulo: "Consulta inconclusiva", detalhe: `A fonte ${c.provider} não confirmou nem negou em ${quando}.`, tom: "alerta" };
    case "unavailable":
      return { titulo: "Consulta indisponível", detalhe: `A fonte ${c.provider} não respondeu em ${quando}. Isso não libera o registro.`, tom: "alerta" };
    case "expired":
      return { titulo: "Consulta vencida", detalhe: `A consulta de ${quando} perdeu a validade. Consulte de novo.`, tom: "alerta" };
  }
}
