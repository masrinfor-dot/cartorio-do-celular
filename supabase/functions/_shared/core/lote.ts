// Venda em lote entre lojas (PJ→PJ). Cada aparelho continua sendo uma transação
// própria (protocolo, certificado e elo próprios); o lote só junta o ACEITE:
// um link e um código para a loja compradora aceitar o conjunto.
import { sha256Hex } from "./hash.ts";
import { DomainError, type TransactionKind } from "./types.ts";

export const LOTE_MAX_ITENS = 50;
export const ORIGEM_LOTE = "lote_pj";

export interface ItemLoteEntrada { device_id: string; valor_centavos: number }

/** Valida o que a loja mandou antes de criar qualquer coisa. */
export function validarItensLote(itens: ItemLoteEntrada[]): void {
  if (!Array.isArray(itens) || itens.length === 0) throw new DomainError("lote_vazio", "Escolha ao menos um aparelho para o lote.");
  if (itens.length > LOTE_MAX_ITENS) throw new DomainError("lote_grande", `Um lote tem no máximo ${LOTE_MAX_ITENS} aparelhos. Divida em dois.`);
  const vistos = new Set<string>();
  for (const i of itens) {
    if (!i.device_id) throw new DomainError("lote_item", "Há um item sem aparelho.");
    if (vistos.has(i.device_id)) throw new DomainError("lote_duplicado", "O mesmo aparelho aparece duas vezes no lote.");
    vistos.add(i.device_id);
    if (!Number.isInteger(i.valor_centavos) || i.valor_centavos <= 0) throw new DomainError("valor", "Informe o valor de cada aparelho do lote.");
  }
}

/**
 * Impressão digital do que a loja compradora vai aceitar: transação + hash dos
 * termos de cada item, em ordem estável. Se qualquer termo mudar depois do
 * envio, a impressão muda e o link deixa de valer — o aceite em bloco não
 * esconde alteração de um item.
 */
export async function impressaoDigitalLote(itens: Array<{ transaction_id: string; terms_hash: string }>): Promise<string> {
  const linhas = itens.map((i) => `${i.transaction_id}:${i.terms_hash}`).sort();
  return sha256Hex(linhas.join("\n"));
}

/** Aparelho do lote que a loja pode mesmo vender: já passou pela consulta de procedência e foi liberado. */
export function itemPodeEntrarNoConvite(estado: string): boolean {
  return estado === "awaiting_seller" || estado === "awaiting_buyer" || estado === "ready_to_complete";
}

/**
 * Fotos obrigatórias são dispensadas em duas situações, ambas com o aparelho já
 * fora das mãos de quem teria que fotografar ou já documentado pela própria loja:
 *  - comunicação de venda entre pessoas (o aparelho não está mais com o vendedor);
 *  - lote entre lojas (a loja vendedora é a titular registrada: o aparelho entrou
 *    no Cartório por uma transação que já exigiu as fotos, ou por outro lote).
 * Mesma regra do banco (registry_complete_transaction).
 */
export function fotosDispensadas(kind: TransactionKind, origem: string | undefined): boolean {
  return (kind === "pf_pf" && origem === "comunicacao_de_venda") || (kind === "pj_pj" && origem === ORIGEM_LOTE);
}
