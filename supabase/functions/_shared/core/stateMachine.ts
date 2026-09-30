import { DomainError, type TransactionState } from "./types.ts";

/** Transições permitidas. Tudo que não está aqui é recusado. */
const TRANSICOES: Record<TransactionState, TransactionState[]> = {
  draft: ["awaiting_data", "cancelled", "expired"],
  awaiting_data: ["awaiting_checks", "cancelled", "expired"],
  awaiting_checks: ["awaiting_seller", "under_review", "blocked", "cancelled", "expired"],
  awaiting_seller: ["awaiting_buyer", "ready_to_complete", "awaiting_checks", "cancelled", "expired"],
  awaiting_buyer: ["ready_to_complete", "awaiting_seller", "awaiting_checks", "cancelled", "expired"],
  ready_to_complete: ["completed", "awaiting_seller", "awaiting_checks", "cancelled", "expired"],
  under_review: ["awaiting_checks", "blocked", "cancelled", "expired"],
  blocked: ["cancelled"],
  completed: ["disputed"],
  cancelled: [],
  expired: [],
  disputed: [],
};

export const ESTADOS_TERMINAIS: TransactionState[] = ["completed", "cancelled", "expired", "disputed"];

export function transicaoPermitida(de: TransactionState, para: TransactionState): boolean {
  return TRANSICOES[de]?.includes(para) ?? false;
}

const MOTIVOS: Partial<Record<`${TransactionState}->${TransactionState}`, string>> = {
  "awaiting_checks->completed": "Não dá para concluir antes do aceite das partes.",
  "awaiting_data->ready_to_complete": "Não dá para pular a consulta de procedência.",
  "awaiting_data->completed": "Não dá para concluir sem consulta de procedência nem aceite.",
  "awaiting_seller->completed": "Ainda falta o vendedor aceitar.",
  "awaiting_buyer->completed": "Ainda falta o comprador aceitar.",
  "completed->draft": "Um registro concluído não volta atrás. Abra uma contestação.",
  "completed->cancelled": "Um registro concluído não pode ser cancelado. Abra uma contestação.",
  "blocked->completed": "A consulta apontou restrição. Esta transação não pode ser concluída.",
  "under_review->completed": "A consulta ficou inconclusiva. Refaça a consulta antes de seguir.",
};

/** Lança DomainError com mensagem em português quando a transição é inválida. */
export function exigirTransicao(de: TransactionState, para: TransactionState): void {
  if (transicaoPermitida(de, para)) return;
  const motivo =
    MOTIVOS[`${de}->${para}`] ??
    (ESTADOS_TERMINAIS.includes(de)
      ? `Esta transação já está encerrada (${rotuloEstado(de)}).`
      : `Não dá para ir de "${rotuloEstado(de)}" para "${rotuloEstado(para)}".`);
  throw new DomainError("transicao_invalida", motivo, 409);
}

export function rotuloEstado(s: TransactionState): string {
  const r: Record<TransactionState, string> = {
    draft: "rascunho",
    awaiting_data: "aguardando dados",
    awaiting_checks: "aguardando consulta",
    awaiting_seller: "aguardando o vendedor",
    awaiting_buyer: "aguardando o comprador",
    ready_to_complete: "pronta para concluir",
    completed: "concluída",
    under_review: "em revisão",
    blocked: "bloqueada",
    cancelled: "cancelada",
    expired: "expirada",
    disputed: "contestada",
  };
  return r[s];
}
