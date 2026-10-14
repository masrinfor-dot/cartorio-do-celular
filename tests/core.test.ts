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

  it("remove EXIF/XMP/ICC de um WebP, atualiza o VP8X e o tamanho do RIFF", () => {
    const le = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
    const asc = (s: string) => s.split("").map((c) => c.charCodeAt(0));
    const chunk = (id: string, d: number[]) => [...asc(id), ...le(d.length), ...d, ...(d.length & 1 ? [0] : [])];
    const vp8x = chunk("VP8X", [0x2c, 0, 0, 0, 9, 0, 0, 9, 0, 0]); // flags: ICC|EXIF|XMP ligados
    const gps = asc("GPS-SECRETO!"); // 12 bytes
    const corpo = [...asc("WEBP"), ...vp8x, ...chunk("ICCP", [1, 2, 3, 4]), ...chunk("VP8 ", [7, 7, 7, 7, 7, 7]), ...chunk("EXIF", gps), ...chunk("XMP ", asc("<x/>"))];
    const webp = new Uint8Array([...asc("RIFF"), ...le(corpo.length), ...corpo]);
    expect(detectarTipo(webp)).toBe("image/webp");
    const r = removerMetadados(webp, "image/webp");
    expect(r.removeu).toBe(true);
    expect(r.suportado).toBe(true);
    const txt = new TextDecoder().decode(r.bytes);
    expect(txt).not.toContain("GPS-SECRETO");
    expect(txt).not.toContain("EXIF");
    expect(txt).not.toContain("ICCP");
    expect(txt).toContain("VP8 ");
    expect(r.bytes[20] & (0x20 | 0x08 | 0x04)).toBe(0); // flags do VP8X limpas
    const riff = r.bytes[4] | (r.bytes[5] << 8) | (r.bytes[6] << 16);
    expect(riff).toBe(r.bytes.length - 8);
  });
  it("WebP sem metadados volta igual", () => {
    const le = (n: number) => [n & 255, (n >> 8) & 255, 0, 0];
    const asc = (s: string) => s.split("").map((c) => c.charCodeAt(0));
    const corpo = [...asc("WEBP"), ...asc("VP8 "), ...le(4), 1, 2, 3, 4];
    const webp = new Uint8Array([...asc("RIFF"), ...le(corpo.length), ...corpo]);
    const r = removerMetadados(webp, "image/webp");
    expect(r.removeu).toBe(false);
    expect(Array.from(r.bytes)).toEqual(Array.from(webp));
  });
  it("HEIC: zera o item Exif no lugar, sem mexer em tamanho nem em offsets", () => {
    const u32 = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
    const u16 = (n: number) => [(n >> 8) & 255, n & 255];
    const asc = (s: string) => s.split("").map((c) => c.charCodeAt(0));
    const box = (tipo: string, ...corpo: number[][]) => { const c = corpo.flat(); return [...u32(8 + c.length), ...asc(tipo), ...c]; };
    const ftyp = box("ftyp", asc("heic"), u32(0), asc("mif1"));
    const infe = (id: number, tipo: string) => box("infe", [2, 0, 0, 0], u16(id), u16(0), asc(tipo), [0]);
    const iinf = box("iinf", [0, 0, 0, 0], u16(2), infe(1, "hvc1"), infe(2, "Exif"));
    const foto = asc("PIXELS-DA-FOTO"); // 14 bytes
    const exif = asc("..GPS-23.5S-46.6W.."); // 20 bytes
    // iloc v0: offset_size=4,length_size=4 | base_size=0 ; 2 itens, 1 extent cada
    const montarIloc = (offFoto: number, offExif: number) => box("iloc", [0, 0, 0, 0], [0x44, 0x00], u16(2),
      u16(1), u16(0), u16(1), u32(offFoto), u32(foto.length),
      u16(2), u16(0), u16(1), u32(offExif), u32(exif.length));
    const meta = (offFoto: number, offExif: number) => box("meta", [0, 0, 0, 0], iinf, montarIloc(offFoto, offExif));
    const tamMeta = meta(0, 0).length;
    const ini = ftyp.length + tamMeta + 8; // início dos dados do mdat
    const heic = new Uint8Array([...ftyp, ...meta(ini, ini + foto.length), ...box("mdat", foto, exif)]);
    expect(detectarTipo(heic)).toBe("image/heic");
    const r = removerMetadados(heic, "image/heic");
    expect(r.removeu).toBe(true);
    expect(r.suportado).toBe(true);
    expect(r.bytes.length).toBe(heic.length);
    const txt = new TextDecoder().decode(r.bytes);
    expect(txt).not.toContain("GPS-23");
    expect(txt).toContain("PIXELS-DA-FOTO");
    // a entrada original não foi alterada
    expect(new TextDecoder().decode(heic)).toContain("GPS-23");
  });
  it("arquivo malformado não quebra: volta como não suportado", () => {
    const lixo = new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 9, 9, 9, 9]);
    expect(() => removerMetadados(lixo, "image/heic")).not.toThrow();
    expect(removerMetadados(lixo, "image/heic").removeu).toBe(false);
  });
});
