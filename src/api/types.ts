// Contrato da API — o mesmo para o backend de demonstração (navegador) e para
// o Supabase (Edge Functions). A interface só conhece este contrato.

import type {
  AcceptanceGrade,
  AcceptanceStatus,
  CheckOutcome,
  MediaSlot,
  PartyKind,
  TermsPayload,
  TermsVersion,
  TransactionKind,
  TransactionParty,
  TransactionState,
} from "@core/index.ts";

export interface Store {
  id: string;
  name: string;
  cnpj: string;
  city: string | null;
  state: string | null;
  tier: "cadastrada" | "verificada" | "fundadora";
}

export interface Session {
  user_id: string;
  email: string;
  store: Store | null;
}

export interface PartyView {
  party_id: string;
  display_name: string;
  kind: PartyKind;
  telefone_mascarado: string | null;
}

export interface BuscaIdentidade {
  encontrado: boolean;
  /** false quando a pessoa existe na plataforma mas não tem vínculo com esta loja — o nome NÃO vem. */
  vinculo?: boolean;
  party_id?: string;
  display_name?: string;
  telefone_mascarado?: string | null;
}

export interface DeviceView {
  device_id: string;
  imei_mascarado: string;
  brand: string | null;
  model: string | null;
  storage: string | null;
  color: string | null;
}

export interface EventoView {
  tipo: string;
  data: string;
  dados: Record<string, unknown>;
}

export interface BuscaAparelho {
  encontrado: boolean;
  device?: DeviceView;
  elos: number;
  linha_do_tempo: EventoView[];
  /** true quando a loja é a titular atual (permite revenda). */
  loja_e_titular?: boolean;
}

export type CriarAparelhoResultado =
  | { conflito: false; device_id: string }
  | { conflito: true; existente: BuscaAparelho };

export interface MediaView {
  media_id: string;
  slot: MediaSlot;
  sha256: string;
  /** URL assinada de curta duração (ou data URL na demonstração). */
  url: string;
}

export interface TransacaoView {
  id: string;
  kind: TransactionKind;
  state: TransactionState;
  public_protocol: string;
  current_terms_version: number;
  created_at: string;
  completed_at: string | null;
  parties: Array<TransactionParty & { display_name: string; kind: PartyKind; telefone_mascarado: string | null }>;
  device: DeviceView | null;
  terms: TermsVersion | null;
  check: CheckOutcome | null;
  media: MediaView[];
  aceite: AcceptanceStatus;
  /** Situação dos convites vivos (nunca token, nunca código). */
  convites: Array<{ invite_id: string; party_id: string; terms_version: number; destino_mascarado: string | null; consumed_at: string | null; revoked_at: string | null; expires_at: string }>;
}

export interface ConviteCriado {
  invite_id: string;
  /** Devolvido UMA vez. Não é recuperável depois. */
  link: string;
  destino_mascarado: string;
  expires_at: string;
  reaproveitado: boolean;
}

export interface ResumoAceitePublico {
  valido: boolean;
  motivo?: string;
  primeiro_nome?: string;
  papel?: "seller" | "buyer";
  loja?: string;
  imei_mascarado?: string;
  aparelho?: string;
  valor?: string;
  forma_pagamento?: string;
  resumo_termos?: string[];
  tentativas_restantes?: number;
  aceito?: boolean;
}

export interface ConclusaoResultado {
  protocolo: string;
  grade: AcceptanceGrade;
  completed_at: string;
  repetida: boolean;
}

export interface PassaporteResultado {
  encontrado: boolean;
  aviso?: string;
  imei_mascarado?: string;
  elos?: number;
  linha_do_tempo?: EventoView[];
  limites?: string;
}

export interface CertificadoView {
  protocolo: string;
  content_hash: string;
  kind: TransactionKind;
  emitido_em: string;
  imei_mascarado: string;
  aparelho: string;
  loja: string;
  vendedor: string;
  comprador: string;
  grade: AcceptanceGrade;
  verificado: Array<{ item: string; data: string; fonte: string }>;
  declarado: Array<{ item: string; valor: string }>;
  valor: string;
  forma_pagamento: string;
  garantia: string;
}

export interface EstoqueItem {
  device: DeviceView;
  desde: string;
  protocolo_entrada: string | null;
}

export interface RegistryApi {
  readonly modo: "demo" | "supabase";

  auth: {
    session(): Promise<Session | null>;
    signIn(email: string, senha: string): Promise<Session>;
    signUp(email: string, senha: string): Promise<Session>;
    signOut(): Promise<void>;
    onChange(cb: (s: Session | null) => void): () => void;
  };

  loja: {
    criar(dados: { nome: string; cnpj: string; cidade: string; uf: string }): Promise<Store>;
  };

  identidade: {
    buscar(documento: string): Promise<BuscaIdentidade>;
    criar(dados: { documento: string; tipo: PartyKind; nome: string; telefone: string }): Promise<PartyView>;
  };

  aparelho: {
    buscarPorImei(imei: string): Promise<BuscaAparelho>;
    criar(dados: { imei: string; marca: string; modelo: string; armazenamento: string; cor: string }): Promise<CriarAparelhoResultado>;
  };

  transacao: {
    criar(dados: {
      kind: TransactionKind;
      device_id: string;
      seller_party_id: string;
      buyer_party_id: string;
      idempotency_key: string;
    }): Promise<TransacaoView>;
    obter(id: string): Promise<TransacaoView>;
    listar(): Promise<TransacaoView[]>;
    mudarEstado(id: string, novo: TransactionState): Promise<TransacaoView>;
    congelarTermos(id: string, termos: TermsPayload): Promise<{ version: number; content_hash: string; unchanged: boolean }>;
  };

  consulta: {
    executar(transaction_id: string): Promise<CheckOutcome>;
  };

  midia: {
    enviar(transaction_id: string, slot: MediaSlot, arquivo: File | Blob): Promise<MediaView>;
  };

  convite: {
    criar(transaction_id: string, party_id: string): Promise<ConviteCriado>;
  };

  /** Rotas SEM sessão. Nunca olham para quem está logado. */
  aceitePublico: {
    resumo(token: string): Promise<ResumoAceitePublico>;
    pedirCodigo(token: string): Promise<{ enviado: boolean; destino_mascarado: string }>;
    confirmar(token: string, codigo: string): Promise<{ aceito: boolean }>;
  };

  aceiteLoja: {
    registrar(transaction_id: string, party_id: string): Promise<AcceptanceStatus>;
  };

  aceiteAssistido: {
    registrar(transaction_id: string, party_id: string, motivo: string): Promise<AcceptanceStatus>;
  };

  concluir(transaction_id: string, idempotency_key: string): Promise<ConclusaoResultado>;

  estoque: {
    listar(): Promise<EstoqueItem[]>;
    /** Prepara uma revenda PJ→PF a partir de um aparelho de que a loja é titular. */
    partyDaLoja(): Promise<PartyView>;
  };

  publico: {
    passaporte(imei: string): Promise<PassaporteResultado>;
    certificado(protocolo: string): Promise<CertificadoView | null>;
  };
}
