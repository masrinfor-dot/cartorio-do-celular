// Certificado em PDF (A4). Gerado no navegador a partir do MESMO dado que a
// página pública mostra — então o PDF nunca diz mais nem menos que a tela.
// Fontes padrão do PDF (Helvetica/Courier): sem arquivo de fonte, sem rede.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { CertificadoView } from "@/api/index.ts";
import { ROTULO_DECL, ROTULO_KIND, ROTULO_VALOR } from "./certificadoTextos.ts";

const TINTA = rgb(0.184, 0.231, 0.612);
const GRAFITE = rgb(0.09, 0.09, 0.12);
const CINZA = rgb(0.29, 0.29, 0.33);
const LINHA = rgb(0.84, 0.82, 0.76);
const DECLARADO_FUNDO = rgb(0.953, 0.906, 0.788);
const VERIFICADO_FUNDO = rgb(0.867, 0.882, 0.957);

const L = 595.28, A = 841.89, M = 48;

/** Fontes padrão só têm Latin-1: troca o que não existe nela, sem quebrar o PDF. */
function limpar(t: string): string {
  return t.replace(/→/g, "para").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/…/g, "...").replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff—–•]/g, "");
}
function data(iso: string): string {
  return iso ? new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "";
}
function quebrar(texto: string, fonte: PDFFont, tam: number, largura: number): string[] {
  const out: string[] = [];
  for (const par of limpar(texto).split("\n")) {
    let linha = "";
    for (const palavra of par.split(/\s+/)) {
      const tenta = linha ? `${linha} ${palavra}` : palavra;
      if (fonte.widthOfTextAtSize(tenta, tam) <= largura) linha = tenta;
      else { if (linha) out.push(linha); linha = palavra; }
    }
    out.push(linha);
  }
  return out;
}

export async function gerarPdfCertificado(c: CertificadoView, urlPublica: string, qrDataUrl: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Certificado de registro ${c.protocolo}`);
  pdf.setAuthor("Cartório do Celular");
  pdf.setSubject("Registro de passagem de aparelho — declarado e verificado na data indicada");
  pdf.setCreationDate(new Date(c.emitido_em || Date.now())); // determinístico: a data é a do registro
  pdf.setModificationDate(new Date(c.emitido_em || Date.now()));
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const neg = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const monoNeg = await pdf.embedFont(StandardFonts.CourierBold);
  const qr = await pdf.embedPng(qrDataUrl);

  let page: PDFPage = pdf.addPage([L, A]);
  let y = A - M;
  const largura = L - 2 * M;
  const nova = () => { page = pdf.addPage([L, A]); y = A - M; };
  const garantir = (h: number) => { if (y - h < M + 40) nova(); };
  const texto = (t: string, x: number, tam: number, f: PDFFont, cor = GRAFITE) => page.drawText(limpar(t), { x, y, size: tam, font: f, color: cor });

  // Cabeçalho
  page.drawRectangle({ x: 0, y: A - 70, width: L, height: 70, color: TINTA });
  page.drawText("cartório do celular", { x: M, y: A - 44, size: 20, font: neg, color: rgb(0.957, 0.945, 0.914) });
  page.drawText("CERTIFICADO DE REGISTRO", { x: L - M - neg.widthOfTextAtSize("CERTIFICADO DE REGISTRO", 9), y: A - 40, size: 9, font: neg, color: rgb(0.957, 0.945, 0.914) });
  y = A - 70 - 34;

  // Protocolo + QR
  page.drawImage(qr, { x: L - M - 84, y: y - 66, width: 84, height: 84 });
  texto("PROTOCOLO", M, 8, neg, CINZA); y -= 26;
  texto(c.protocolo, M, 28, monoNeg, GRAFITE); y -= 20;
  texto(`${ROTULO_KIND[c.kind]} · emitido em ${data(c.emitido_em)}`, M, 10, reg, CINZA); y -= 15;
  texto(c.grade === "assistido" ? "ACEITE PRESENCIAL ASSISTIDO — prova de grau menor" : "ACEITE POR CANAL PRÓPRIO DAS PARTES", M, 8, neg, c.grade === "assistido" ? rgb(0.48, 0.31, 0.03) : TINTA);
  y -= 46;

  // Dados
  const linhas: Array<[string, string]> = [
    ["Aparelho", `${c.aparelho || "—"} · IMEI ${c.imei_mascarado}`], ["Loja", c.loja], ["Vendedor", c.vendedor], ["Comprador", c.comprador],
    ["Valor", `${c.valor} · ${c.forma_pagamento}`], ["Garantia", c.garantia],
  ];
  for (const [k, v] of linhas) {
    const ls = quebrar(v, neg, 10.5, largura - 90);
    garantir(ls.length * 14 + 4);
    texto(k, M, 10, reg, CINZA);
    ls.forEach((l, i) => { page.drawText(l, { x: M + 90, y: y - i * 14, size: 10.5, font: neg, color: GRAFITE }); });
    y -= ls.length * 14 + 4;
  }
  y -= 10;

  const bloco = (titulo: string, tag: string, fundo: ReturnType<typeof rgb>, itens: Array<[string, string]>) => {
    garantir(40);
    texto(titulo, M, 12, neg, GRAFITE);
    const w = neg.widthOfTextAtSize(titulo, 12) + 8;
    page.drawRectangle({ x: M + w, y: y - 3, width: neg.widthOfTextAtSize(tag, 7) + 10, height: 12, color: fundo, borderColor: tag === "DECLARADO" ? rgb(0.48, 0.31, 0.03) : TINTA, borderWidth: 0.6, borderDashArray: tag === "DECLARADO" ? [2, 2] : undefined });
    page.drawText(tag, { x: M + w + 5, y: y, size: 7, font: neg, color: tag === "DECLARADO" ? rgb(0.48, 0.31, 0.03) : TINTA });
    y -= 20;
    for (const [esq, dir] of itens) {
      const le = quebrar(esq, reg, 9.5, largura - 190);
      const ld = quebrar(dir, reg, 8.5, 170);
      const h = Math.max(le.length, ld.length) * 12 + 8;
      garantir(h);
      page.drawRectangle({ x: M, y: y - h + 10, width: largura, height: h - 2, color: fundo });
      le.forEach((l, i) => page.drawText(l, { x: M + 8, y: y - 2 - i * 12, size: 9.5, font: reg, color: GRAFITE }));
      ld.forEach((l, i) => page.drawText(l, { x: L - M - 8 - reg.widthOfTextAtSize(l, 8.5), y: y - 2 - i * 12, size: 8.5, font: reg, color: CINZA }));
      y -= h;
    }
    y -= 10;
  };

  bloco("O que foi verificado", "VERIFICADO", VERIFICADO_FUNDO, c.verificado.map((v) => [v.item, `${data(v.data)} · ${v.fonte}`]));
  bloco("O que foi declarado", "DECLARADO", DECLARADO_FUNDO, c.declarado.map((d) => [ROTULO_DECL[d.item] ?? d.item, ROTULO_VALOR[d.valor] ?? d.valor]));
  garantir(30);
  for (const l of quebrar("Declarações são afirmações das partes, registradas como tal. O Cartório não as verificou.", reg, 8.5, largura)) { texto(l, M, 8.5, reg, CINZA); y -= 11; }

  // Rodapé (sempre no fim da última página)
  const rodape = [
    `Valide este certificado em: ${urlPublica}`,
    `hash ${c.content_hash}`,
    "O Cartório registra passagens declaradas e verificadas na data indicada. Não é órgão público e não substitui boletim de ocorrência, nota fiscal ou vistoria técnica.",
  ];
  const topo = M + 8 + 34 + 12;
  page.drawLine({ start: { x: M, y: topo }, end: { x: L - M, y: topo }, thickness: 0.6, color: LINHA });
  const ls: Array<{ t: string; f: PDFFont; s: number }> = [];
  for (const l of quebrar(rodape[0], reg, 8, largura)) ls.push({ t: l, f: reg, s: 8 });
  for (const l of quebrar(rodape[1], mono, 6.5, largura)) ls.push({ t: l, f: mono, s: 6.5 });
  for (const l of quebrar(rodape[2], reg, 7.5, largura)) ls.push({ t: l, f: reg, s: 7.5 });
  ls.forEach((l, i) => page.drawText(l.t, { x: M, y: M + 8 + 34 - i * 10, size: l.s, font: l.f, color: CINZA }));

  return pdf.save({ useObjectStreams: false });
}
