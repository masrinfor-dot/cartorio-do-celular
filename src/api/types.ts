// Contrato da API — o mesmo para o backend de demonstração (navegador) e para
// o Supabase (Edge Functions). A interface só conhece este contrato.

import type {
  Estimativa,
  Margens,
  QuestionarioConfig,
  TabelaMargem,
  ValorBase,
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

/** Declaração ativa de furto/roubo/perda feita pelo titular registrado — sem PII. */
export interface OcorrenciaView {
  tipo: "furto" | "roubo" | "perda";
  bo_numero: string | null;
  bo_data: string | null;
  cidade: string | null;
  uf: string | null;
  declarada_em: string;
}

export interface BuscaAparelho {
  encontrado: boolean;
  device?: DeviceView;
  elos: number;
  linha_do_tempo: EventoView[];
  /** true quando a loja é a titular atual (permite revenda). */
  loja_e_titular?: boolean;
  ocorrencia_ativa?: OcorrenciaView | null;
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
  /** Declaração ativa de furto/roubo/perda pelo titular registrado — bloqueia a conclusão. */
  ocorrencia_ativa?: OcorrenciaView | null;
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
  ocorrencia_ativa?: OcorrenciaView | null;
}

// ---------------------------------------------------------------------------
// Portal da pessoa física — "Meus aparelhos" (benchmark da Carteira Digital)
// ---------------------------------------------------------------------------

export interface PfSession {
  party_id: string;
  primeiro_nome: string;
  display_name: string;
  telefone_mascarado: string;
}

export interface MeuAparelho {
  device: DeviceView;
  desde: string;
  protocolo_entrada: string | null;
  link_certificado: string | null;
  /** Intenção de venda aberta (PF→PF) partindo deste aparelho. */
  intencao: { transaction_id: string; state: TransactionState; comprador: string; comprador_aceitou: boolean; vendedor_confirmou: boolean; declarada: boolean } | null;
  ocorrencia_ativa: OcorrenciaView | null;
}

export interface IniciarVendaPf {
  device_id: string;
  comprador: { cpf: string; nome: string; telefone: string };
  valor_centavos: number;
  forma_pagamento: string;
  estado_aparelho: string;
  defeitos: string;
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

// ---------------------------------------------------------------------------
// Avaliação de usados / compra (portado do Sheik CRM), PDV e integração ERP
// ---------------------------------------------------------------------------

export interface ErpConfig {
  ativo: boolean;
  url: string;
  token_definido: boolean;
  enviar_compras: boolean;
  enviar_vendas: boolean;
  solicitar_nfe: boolean;
}

export interface AvaliacaoConfig {
  margens: Margens;
  questionario: QuestionarioConfig;
  formas_pagamento: string[];
  valores_base: Array<ValorBase & { id: string }>;
  /** true quando há chave de IA configurada no servidor (pesquisa de preço). */
  ia_disponivel: boolean;
  erp: ErpConfig;
}

export interface AvaliacaoView {
  id: string;
  created_at: string;
  brand: string;
  model: string;
  memory: string | null;
  color: string | null;
  /** Texto composto: "Apple iPhone 13 128GB Azul". */
  device: string;
  customer_name: string | null;
  answers: Record<string, string>;
  estimativa: Estimativa | null;
  margem_tabela: TabelaMargem;
  // Fechamento (negócio fechado = compra)
  closed_at: string | null;
  final_price_centavos: number | null;
  payment_method: string | null;
  pix_key: string | null;
  pix_key_holder: string | null;
  seller_party_id: string | null;
  seller_display_name: string | null;
  seller_telefone_mascarado: string | null;
  device_id: string | null;
  imei_mascarado: string | null;
  imei_pendente: boolean;
  transaction_id: string | null;
  transaction_state: TransactionState | null;
  protocolo: string | null;
  aceite_grade: AcceptanceGrade | null;
  store_name: string | null;
}

export interface FecharNegocio {
  vendedor: { nome: string; cpf: string; telefone: string; rg?: string; endereco?: string; bairro?: string };
  imei?: string;
  final_price_centavos: number;
  payment_method: string;
  pix_key?: string;
  pix_key_holder?: string;
  tabela: TabelaMargem;
}

export interface NotaCompra {
  protocolo: string | null;
  registro_estado: TransactionState | null;
  aceite_grade: AcceptanceGrade | null;
  concluido_em: string | null;
  loja: { nome: string; cnpj: string; cidade: string | null };
  data: string;
  aparelho: { descricao: string; marca: string; modelo: string; memoria: string | null; cor: string | null; imei: string | null };
  vendedor: { nome: string; cpf: string; rg: string | null; endereco: string | null; bairro: string | null; telefone: string | null };
  valor: string;
  forma_pagamento: string;
  pix_key: string | null;
  pix_key_holder: string | null;
  checklist: Array<{ pergunta: string; resposta: string }>;
  fotos: { documento: string[]; aparelho: string[]; comprovante: string[] };
  link_certificado: string | null;
}

export interface NotaVenda {
  protocolo: string;
  aceite_grade: AcceptanceGrade;
  concluido_em: string;
  loja: { nome: string; cnpj: string; cidade: string | null };
  aparelho: { descricao: string; imei: string };
  comprador: { nome: string; cpf: string; telefone: string | null };
  valor: string;
  forma_pagamento: string;
  garantia: string;
  estado_declarado: string;
  defeitos_declarados: string;
  consulta: { resultado: string; fonte: string; data: string } | null;
  link_certificado: string;
}

export interface ErpEnvio {
  id: string;
  transaction_id: string;
  tipo: "compra" | "venda";
  status: "enviado" | "erro" | "simulado";
  erp_ref: string | null;
  nfe_status: string | null;
  mensagem: string | null;
  created_at: string;
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

  avaliacao: {
    config(): Promise<AvaliacaoConfig>;
    salvarConfig(patch: {
      margens?: Margens;
      questionario?: QuestionarioConfig;
      formas_pagamento?: string[];
      valores_base_texto?: string;
      erp?: Partial<ErpConfig> & { token?: string };
    }): Promise<AvaliacaoConfig>;
    removerValorBase(id: string): Promise<void>;
    /** Etapas 1–3: cria a avaliação (orçamento) e calcula a sugestão. */
    estimar(dados: { brand: string; model: string; memory: string; color: string; customer_name: string; answers: Record<string, string>; tabela: TabelaMargem; imei?: string }): Promise<AvaliacaoView>;
    listar(): Promise<AvaliacaoView[]>;
    obter(id: string): Promise<AvaliacaoView>;
    /** Etapa 4: fecha o negócio → cria pessoa, aparelho, transação e termos do Cartório. */
    fechar(id: string, dados: FecharNegocio): Promise<AvaliacaoView>;
    completarImei(id: string, imei: string): Promise<AvaliacaoView>;
    /** Só antes da conclusão do registro (o lastro é append-only). */
    excluir(id: string): Promise<void>;
    notaCompra(id: string): Promise<NotaCompra>;
  };

  notaVenda(transaction_id: string): Promise<NotaVenda>;

  /** Portal da pessoa física. Sessão própria (CPF + código no WhatsApp), sem loja. */
  pf: {
    sessao(): Promise<PfSession | null>;
    pedirCodigo(dados: { cpf: string; telefone: string; nome?: string }): Promise<{ destino_mascarado: string; novo_cadastro: boolean }>;
    confirmar(codigo: string): Promise<PfSession>;
    sair(): Promise<void>;
    meusAparelhos(): Promise<MeuAparelho[]>;
    transacao(transaction_id: string): Promise<TransacaoView>;
    /** Vender: o comprador aceita primeiro no celular dele; o vendedor confirma por último. */
    iniciarVenda(dados: IniciarVendaPf): Promise<TransacaoView>;
    enviarFoto(transaction_id: string, slot: MediaSlot, arquivo: File | Blob): Promise<MediaView>;
    reenviarConvite(transaction_id: string): Promise<ConviteCriado>;
    confirmarVenda(transaction_id: string): Promise<ConclusaoResultado>;
    cancelarVenda(transaction_id: string): Promise<void>;
    /** Comunicação de venda: declaração unilateral do vendedor; vira elo forte se o comprador aceitar depois. */
    comunicarVenda(dados: { device_id: string; comprador: { cpf: string; nome?: string; telefone?: string }; data_venda: string; valor_centavos?: number }): Promise<TransacaoView>;
    registrarOcorrencia(dados: { device_id: string; tipo: "furto" | "roubo" | "perda"; bo_numero?: string; bo_data?: string; cidade?: string; uf?: string }): Promise<OcorrenciaView>;
    retirarOcorrencia(device_id: string, motivo: string): Promise<void>;
  };

  erp: {
    enviar(transaction_id: string): Promise<ErpEnvio>;
    envios(transaction_id: string): Promise<ErpEnvio[]>;
  };
}
