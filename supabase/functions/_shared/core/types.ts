// Tipos do domínio — compartilhados entre Edge Functions (Deno), o backend de
// demonstração (navegador) e a interface. Nenhuma dependência externa.

export type PartyKind = "pf" | "pj";
export type TransactionKind = "pf_pj" | "pj_pf" | "pf_pf" | "pj_pj";

export type TransactionState =
  | "draft"
  | "awaiting_data"
  | "awaiting_checks"
  | "awaiting_seller"
  | "awaiting_buyer"
  | "ready_to_complete"
  | "completed"
  | "under_review"
  | "blocked"
  | "cancelled"
  | "expired"
  | "disputed";

export type CheckResult = "clear" | "restricted" | "inconclusive" | "unavailable" | "expired";

export type AcceptanceChannel = "otp_whatsapp" | "portal" | "operator_pj" | "presencial_assistido";
export type AcceptanceGrade = "forte" | "assistido";

export type MediaSlot =
  | "frente_ligada"
  | "traseira"
  | "tela_imei"
  | "laterais"
  | "avarias"
  | "documento"
  | "selfie"
  | "comprovante";

export const REQUIRED_MEDIA_SLOTS: MediaSlot[] = ["frente_ligada", "traseira", "tela_imei"];
/** Slots únicos por transação (reenviar substitui); os demais aceitam várias fotos. */
export const UNIQUE_MEDIA_SLOTS: MediaSlot[] = ["frente_ligada", "traseira", "tela_imei"];

export type PartyRole = "seller" | "buyer" | "representative" | "witness";

/** Payload dos termos congelados. As chaves são ordenadas antes do hash. */
export interface TermsPayload {
  valor_centavos: number;
  forma_pagamento: string;
  estado_aparelho: string;
  defeitos: string;
  garantia: string;
  /** Declarações do vendedor — registradas como afirmação, nunca como fato verificado. */
  declaracoes?: Record<string, string | boolean>;
}

export interface TermsVersion {
  version: number;
  content_hash: string;
  payload: TermsPayload;
  frozen_at: string;
}

export interface Acceptance {
  party_id: string;
  terms_version: number;
  terms_hash: string;
  channel: AcceptanceChannel;
  accepted_at: string;
}

export interface TransactionParty {
  party_id: string;
  role: PartyRole;
  is_tenant_side: boolean;
}

export interface AcceptanceStatus {
  complete: boolean;
  grade: AcceptanceGrade;
  /** Partes que ainda não aceitaram a versão vigente. */
  missing: TransactionParty[];
  accepted: TransactionParty[];
}

export interface Invite {
  id: string;
  party_id: string;
  terms_version: number;
  terms_hash: string;
  consumed_at: string | null;
  revoked_at: string | null;
  expires_at: string;
}

/** Erro de domínio — a mensagem fala com o operador, não com o programador. */
export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
