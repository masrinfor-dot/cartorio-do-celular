import {
  DomainError,
  type Acceptance,
  type AcceptanceStatus,
  type Invite,
  type TransactionKind,
  type TransactionParty,
} from "./types.ts";

/** Papéis cujo aceite é exigido em cada modalidade. */
export function papeisExigidos(_kind: TransactionKind): Array<"seller" | "buyer"> {
  return ["seller", "buyer"];
}

/**
 * Status do aceite. Só contam os aceites da versão VIGENTE dos termos, com o
 * hash vigente. Mudar os termos derruba os aceites por definição — sem rotina
 * de limpeza.
 */
export function acceptanceStatus(
  kind: TransactionKind,
  parties: TransactionParty[],
  acceptances: Acceptance[],
  termsVersion: number,
  termsHash: string,
): AcceptanceStatus {
  const exigidas = parties.filter((p) => (papeisExigidos(kind) as string[]).includes(p.role));
  const validos = acceptances.filter((a) => a.terms_version === termsVersion && a.terms_hash === termsHash);
  const accepted: TransactionParty[] = [];
  const missing: TransactionParty[] = [];
  for (const p of exigidas) {
    if (validos.some((a) => a.party_id === p.party_id)) accepted.push(p);
    else missing.push(p);
  }
  // A corrente vale o elo mais fraco: uma parte assistida basta para o conjunto.
  const grade = validos.some((a) => a.channel === "presencial_assistido") ? "assistido" : "forte";
  return { complete: missing.length === 0 && termsVersion > 0, grade, missing, accepted };
}

export function descreverFaltantes(status: AcceptanceStatus): string {
  if (status.complete) return "As duas partes aceitaram.";
  const nomes = status.missing.map((p) => (p.role === "seller" ? "o vendedor" : p.role === "buyer" ? "o comprador" : p.role));
  if (nomes.length === 1) return `Ainda falta ${nomes[0]} aceitar.`;
  return `Ainda faltam ${nomes.join(" e ")} aceitar.`;
}

// ---------------------------------------------------------------------------
// Aceite presencial assistido — política pura, testada sem banco.
// ---------------------------------------------------------------------------

export interface AssistedAcceptanceInput {
  party: TransactionParty;
  invite: Invite | null;
  termsVersion: number;
  reason: string;
  operatorUserId: string | null | undefined;
}

export const ASSISTED_REASON_MIN = 10;

/**
 * As cinco travas. Cada uma existe porque sem ela o aceite assistido vira o
 * operador assinando pelo cliente com um nome bonito.
 */
export function exigirAceiteAssistidoPermitido(i: AssistedAcceptanceInput): void {
  // 5. A loja não usa esse canal para si mesma.
  if (i.party.is_tenant_side) {
    throw new DomainError("assistido_loja", "A loja não usa o aceite assistido: ela já tem o operador logado.", 403);
  }
  // 4. Operador identificado.
  if (!i.operatorUserId) {
    throw new DomainError("assistido_sem_operador", "O aceite assistido precisa de um operador identificado.", 403);
  }
  // 3. Motivo escrito.
  if ((i.reason ?? "").trim().length < ASSISTED_REASON_MIN) {
    throw new DomainError("assistido_sem_motivo", `Escreva o motivo do aceite presencial (mínimo ${ASSISTED_REASON_MIN} caracteres).`);
  }
  // 1. Convite antes, para esta versão dos termos.
  if (!i.invite || i.invite.terms_version !== i.termsVersion || i.invite.revoked_at) {
    throw new DomainError(
      "assistido_sem_convite",
      "Antes do aceite presencial, envie o código para o celular do vendedor. Só se ele não chegar é que este caminho abre.",
      409,
    );
  }
  // 2. Convite não consumido.
  if (i.invite.consumed_at) {
    throw new DomainError("assistido_ja_aceito", "O vendedor já aceitou pelo celular dele. Não se troca prova boa por prova pior.", 409);
  }
}

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
