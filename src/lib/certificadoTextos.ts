// Rótulos do certificado — usados na tela e no PDF, para os dois dizerem a mesma coisa.
export const ROTULO_DECL: Record<string, string> = { conta_icloud_google: "Conta iCloud / Google", origem: "Origem declarada" };
export const ROTULO_VALOR: Record<string, string> = { desvinculada: "desvinculada", vinculada: "ainda vinculada", nao_verificado: "não verificado", compra_com_nota: "compra com nota fiscal", compra_sem_nota: "compra sem nota fiscal", presente: "presente", outra: "outra", venda_entre_pessoas: "venda entre pessoas", comunicacao_de_venda: "comunicação de venda" };
export const ROTULO_KIND = { pf_pj: "Entrada: pessoa física para loja", pj_pf: "Revenda: loja para pessoa física", pf_pf: "Pessoa física para pessoa física", pj_pj: "Loja para loja" } as const;
