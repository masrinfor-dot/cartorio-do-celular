// Prazos do Cartório: expiração de transações paradas e garantia declarada.
// Regras puras — o banco e a interface só chamam isto.
import type { TransactionState } from "./types.ts";

const DIA_MS = 86_400_000;

/** Quantos dias uma transação aberta pode ficar sem nenhuma movimentação. */
export const PRAZO_PARADA_DIAS = 7;
/** Avisar o comprador quando faltarem até este número de dias para a garantia acabar. */
export const LEMBRETE_GARANTIA_DIAS = 7;

/** Estados que o motor de estados deixa passar para "expired". */
const EXPIRAVEIS: TransactionState[] = ["draft", "awaiting_data", "awaiting_checks", "awaiting_seller", "awaiting_buyer", "ready_to_complete", "under_review"];

/** Parada há mais de PRAZO_PARADA_DIAS sem movimentação (updated_at)? "blocked" não expira: só se cancela. */
export function deveExpirar(state: TransactionState, ultimaMovimentacao: string, agora: Date = new Date()): boolean {
  if (!EXPIRAVEIS.includes(state)) return false;
  const t = Date.parse(ultimaMovimentacao);
  if (Number.isNaN(t)) return false;
  return agora.getTime() - t > PRAZO_PARADA_DIAS * DIA_MS;
}

/** Quando a intenção vai expirar se ninguém mexer nela. */
export function expiraEm(ultimaMovimentacao: string): string {
  return new Date(Date.parse(ultimaMovimentacao) + PRAZO_PARADA_DIAS * DIA_MS).toISOString();
}

/**
 * Lê o prazo da garantia que a loja digitou ("90 dias", "3 meses", "1 ano",
 * "6 meses de garantia"). Devolve null quando não dá para ter certeza —
 * nunca chuta: sem prazo legível, não há lembrete.
 */
export function prazoGarantiaDias(texto: string): number | null {
  const t = (texto ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  if (!t || /^(sem|nao|nenhuma)\b/.test(t)) return null;
  const m = t.match(/(\d{1,3})\s*(dias?|d\b|mes(?:es)?|m\b|anos?|a\b)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  const u = m[2];
  if (u.startsWith("d")) return n;
  if (u.startsWith("m")) return n * 30;
  return n * 365;
}

export type SituacaoGarantia = "vigente" | "vence_em_breve" | "vencida";
export interface GarantiaView { ate: string; dias_restantes: number; situacao: SituacaoGarantia; texto: string }

/** Garantia contada a partir da conclusão do registro. Null se não houver prazo legível. */
export function garantiaDe(concluidoEm: string | null, texto: string, agora: Date = new Date()): GarantiaView | null {
  if (!concluidoEm) return null;
  const dias = prazoGarantiaDias(texto);
  if (!dias) return null;
  const ate = new Date(Date.parse(concluidoEm) + dias * DIA_MS);
  const restantes = Math.ceil((ate.getTime() - agora.getTime()) / DIA_MS);
  const situacao: SituacaoGarantia = restantes < 0 ? "vencida" : restantes <= LEMBRETE_GARANTIA_DIAS ? "vence_em_breve" : "vigente";
  return { ate: ate.toISOString(), dias_restantes: restantes, situacao, texto };
}
