import { describe, it, expect } from "vitest";
import {
  imeiValido,
  completarImei,
  cpfValido,
  cnpjValido,
  mascararImei,
  mascararTelefone,
  nomeCurto,
  canonicalJson,
  hashTerms,
  cifrar,
  decifrar,
  gerarProtocolo,
  gerarOtp,
  transicaoPermitida,
  exigirTransicao,
  simularConsulta,
  exigirProcedenciaLiberada,
  consultaVigente,
  acceptanceStatus,
  exigirAceiteAssistidoPermitido,
  DomainError,
  type TransactionParty,
  type Acceptance,
} from "../supabase/functions/_shared/core/index.ts";

describe("IMEI", () => {
  it("aceita IMEI com Luhn válido e recusa dígito trocado", () => {
    const ok = completarImei("35692008000000");
    expect(imeiValido(ok)).toBe(true);
    const trocado = ok.slice(0, 5) + ((Number(ok[5]) + 1) % 10) + ok.slice(6);
    expect(imeiValido(trocado)).toBe(false);
    expect(imeiValido("1234")).toBe(false);
  });
  it("mascara", () => {
    expect(mascararImei("356920080000009")).toBe("3569****0009");
  });
});

describe("CPF / CNPJ", () => {
  it("valida dígitos verificadores de verdade", () => {
    expect(cpfValido("529.982.247-25")).toBe(true);
    expect(cpfValido("529.982.247-26")).toBe(false);
    expect(cpfValido("111.111.111-11")).toBe(false);
    expect(cnpjValido("11.222.333/0001-81")).toBe(true);
    expect(cnpjValido("11.222.333/0001-82")).toBe(false);
  });
  it("mascara telefone e nome", () => {
    expect(mascararTelefone("31988881234")).toBe("(31) 9****-1234");
    expect(nomeCurto("Maria da Silva")).toBe("Maria S.");
  });
});

describe("Termos e hash", () => {
  it("json canônico ignora ordem das chaves", async () => {
    const a = { valor_centavos: 100, forma_pagamento: "pix", estado_aparelho: "bom", defeitos: "", garantia: "" };
    const b = { garantia: "", defeitos: "", estado_aparelho: "bom", forma_pagamento: "pix", valor_centavos: 100 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(await hashTerms(a)).toBe(await hashTerms(b));
    expect(await hashTerms({ ...a, valor_centavos: 101 })).not.toBe(await hashTerms(a));
  });
  it("cifra e decifra CPF, sem repetir o blob", async () => {
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const c1 = await cifrar(key, "52998224725");
    const c2 = await cifrar(key, "52998224725");
    expect(c1).not.toBe(c2);
    expect(c1).not.toContain("52998224725");
    expect(await decifrar(key, c1)).toBe("52998224725");
  });
  it("protocolo e otp têm o formato certo", () => {
    expect(gerarProtocolo()).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{10}$/);
    expect(gerarOtp()).toMatch(/^\d{6}$/);
  });
});

describe("Máquina de estados", () => {
  it("recusa pular o aceite", () => {
    expect(transicaoPermitida("awaiting_checks", "completed")).toBe(false);
    expect(() => exigirTransicao("awaiting_checks", "completed")).toThrow(/aceite/);
  });
  it("recusa pular a consulta", () => {
    expect(() => exigirTransicao("awaiting_data", "ready_to_complete")).toThrow(/consulta/);
  });
  it("concluída só sai para contestada", () => {
    expect(() => exigirTransicao("completed", "draft")).toThrow(DomainError);
    expect(() => exigirTransicao("completed", "cancelled")).toThrow(DomainError);
    expect(transicaoPermitida("completed", "disputed")).toBe(true);
  });
  it("caminho feliz", () => {
    const seq = ["draft", "awaiting_data", "awaiting_checks", "awaiting_seller", "awaiting_buyer", "ready_to_complete", "completed"] as const;
    for (let i = 0; i < seq.length - 1; i++) expect(transicaoPermitida(seq[i], seq[i + 1])).toBe(true);
  });
});

describe("Consulta de procedência", () => {
  it("simulador segue o último dígito", () => {
    expect(simularConsulta("356920080000000").result).toBe("restricted");
    expect(simularConsulta("356920080000001").result).toBe("inconclusive");
    expect(simularConsulta("356920080000002").result).toBe("unavailable");
    expect(simularConsulta("356920080000009").result).toBe("clear");
  });
  it("só clear libera — unavailable NÃO libera", () => {
    expect(() => exigirProcedenciaLiberada("clear")).not.toThrow();
    expect(() => exigirProcedenciaLiberada("unavailable")).toThrow(/indisponível/);
    expect(() => exigirProcedenciaLiberada("restricted")).toThrow(/restrição/);
    expect(() => exigirProcedenciaLiberada("inconclusive")).toThrow();
    expect(() => exigirProcedenciaLiberada("expired")).toThrow(/venceu/);
    expect(() => exigirProcedenciaLiberada(null)).toThrow();
  });
  it("consulta vencida vira expired", () => {
    const c = simularConsulta("356920080000009", new Date("2026-01-01T00:00:00Z"));
    expect(consultaVigente(c, new Date("2026-01-01T12:00:00Z"))).toBe("clear");
    expect(consultaVigente(c, new Date("2026-01-03T00:00:00Z"))).toBe("expired");
  });
});

const vendedor: TransactionParty = { party_id: "p1", role: "seller", is_tenant_side: false };
const loja: TransactionParty = { party_id: "p2", role: "buyer", is_tenant_side: true };

describe("Aceite", () => {
  it("mudar os termos derruba os aceites sozinho", () => {
    const acc: Acceptance[] = [
      { party_id: "p1", terms_version: 1, terms_hash: "h1", channel: "otp_whatsapp", accepted_at: "" },
      { party_id: "p2", terms_version: 1, terms_hash: "h1", channel: "operator_pj", accepted_at: "" },
    ];
    expect(acceptanceStatus("pf_pj", [vendedor, loja], acc, 1, "h1").complete).toBe(true);
    const depois = acceptanceStatus("pf_pj", [vendedor, loja], acc, 2, "h2");
    expect(depois.complete).toBe(false);
    expect(depois.missing.length).toBe(2);
  });
  it("uma parte assistida rebaixa o conjunto", () => {
    const acc: Acceptance[] = [
      { party_id: "p1", terms_version: 1, terms_hash: "h1", channel: "presencial_assistido", accepted_at: "" },
      { party_id: "p2", terms_version: 1, terms_hash: "h1", channel: "operator_pj", accepted_at: "" },
    ];
    expect(acceptanceStatus("pf_pj", [vendedor, loja], acc, 1, "h1").grade).toBe("assistido");
  });
  it("sem termos congelados não está completo", () => {
    expect(acceptanceStatus("pf_pj", [vendedor, loja], [], 0, "").complete).toBe(false);
  });
});

describe("Aceite presencial assistido — as cinco travas", () => {
  const convite = { id: "i1", party_id: "p1", terms_version: 1, terms_hash: "h1", consumed_at: null, revoked_at: null, expires_at: "" };
  const base = { party: vendedor, invite: convite, termsVersion: 1, reason: "WhatsApp da loja fora do ar", operatorUserId: "u1" };
  it("passa quando tudo está certo", () => {
    expect(() => exigirAceiteAssistidoPermitido(base)).not.toThrow();
  });
  it("1. sem convite", () => {
    expect(() => exigirAceiteAssistidoPermitido({ ...base, invite: null })).toThrow(/envie o código/);
  });
  it("1b. convite de outra versão", () => {
    expect(() => exigirAceiteAssistidoPermitido({ ...base, invite: { ...convite, terms_version: 0 } })).toThrow();
  });
  it("2. convite já consumido", () => {
    expect(() => exigirAceiteAssistidoPermitido({ ...base, invite: { ...convite, consumed_at: "x" } })).toThrow(/já aceitou/);
  });
  it("3. motivo curto", () => {
    expect(() => exigirAceiteAssistidoPermitido({ ...base, reason: "caiu" })).toThrow(/motivo/);
  });
  it("4. sem operador", () => {
    expect(() => exigirAceiteAssistidoPermitido({ ...base, operatorUserId: null })).toThrow(/operador/);
  });
  it("5. a loja para si mesma", () => {
    expect(() => exigirAceiteAssistidoPermitido({ ...base, party: loja })).toThrow(/loja/);
  });
});

import { detectarTipo, removerMetadados } from "../supabase/functions/_shared/core/imagem.ts";

describe("Imagem: tipo real e remoção de metadados", () => {
  it("detecta JPEG/PNG pelos bytes e recusa o resto", () => {
    expect(detectarTipo(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("image/jpeg");
    expect(detectarTipo(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(detectarTipo(new TextEncoder().encode("<html>"))).toBeNull();
  });
  it("remove o APP1 (EXIF) de um JPEG e mantém o JFIF", () => {
    const soi = [0xff, 0xd8];
    const app0 = [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46];        // APP0 tamanho 4
    const app1 = [0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
    const sos = [0xff, 0xda, 0x00, 0x02, 0x01, 0x02, 0xff, 0xd9];
    const jpeg = new Uint8Array([...soi, ...app0, ...app1, ...sos]);
    const r = removerMetadados(jpeg, "image/jpeg");
    expect(r.removeu).toBe(true);
    expect(Array.from(r.bytes)).toEqual([...soi, ...app0, ...sos]);
    expect(new TextDecoder().decode(r.bytes)).not.toContain("Exif");
  });
  it("remove tEXt de um PNG", () => {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const chunk = (tipo: string, dados: number[]) => [0, 0, 0, dados.length, ...tipo.split("").map((c) => c.charCodeAt(0)), ...dados, 0, 0, 0, 0];
    const png = new Uint8Array([...sig, ...chunk("IHDR", [1, 2, 3, 4]), ...chunk("tEXt", [0x47, 0x50, 0x53]), ...chunk("IEND", [])]);
    const r = removerMetadados(png, "image/png");
    expect(r.removeu).toBe(true);
    expect(new TextDecoder().decode(r.bytes)).not.toContain("tEXt");
    expect(new TextDecoder().decode(r.bytes)).toContain("IHDR");
  });
});
