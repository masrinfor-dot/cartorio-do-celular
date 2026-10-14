// Identificação do tipo real da imagem pelos BYTES e remoção de metadados
// (EXIF/XMP/ICC). Selfie e foto de documento carregam coordenada de GPS —
// isso nunca entra no armazenamento. Puro, sem dependências.

export type TipoImagem = "image/jpeg" | "image/png" | "image/webp" | "image/heic";

export function detectarTipo(b: Uint8Array): TipoImagem | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  if (b.length > 12 && ascii(b, 4, 8) === "ftyp" && /^(heic|heix|hevc|mif1|msf1)/.test(ascii(b, 8, 12))) return "image/heic";
  return null;
}

function ascii(b: Uint8Array, i: number, j: number): string {
  return String.fromCharCode(...b.subarray(i, j));
}

/**
 * Remove metadados. JPEG, PNG e WebP são reescritos sem os blocos; HEIC tem os
 * itens EXIF/XMP zerados no lugar (sem mover nenhum byte, então os offsets do
 * arquivo continuam válidos). Se o arquivo não puder ser lido com segurança,
 * `suportado` vem false e quem chamou decide (documento/selfie são recusados).
 */
export function removerMetadados(b: Uint8Array, tipo: TipoImagem): { bytes: Uint8Array; removeu: boolean; suportado: boolean } {
  try {
    if (tipo === "image/jpeg") return { ...limparJpeg(b), suportado: true };
    if (tipo === "image/png") return { ...limparPng(b), suportado: true };
    if (tipo === "image/webp") return { ...limparWebp(b), suportado: true };
    if (tipo === "image/heic") return { ...limparHeic(b), suportado: true };
  } catch { /* arquivo malformado: cai no não suportado */ }
  return { bytes: b, removeu: false, suportado: false };
}

/** WebP (RIFF): descarta os blocos EXIF, XMP e ICCP e limpa os avisos no VP8X. Sem VP8X não existe metadado. */
function limparWebp(b: Uint8Array): { bytes: Uint8Array; removeu: boolean } {
  const le32 = (i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  if (le32(4) + 8 > b.length) throw new Error("RIFF truncado");
  const partes: Uint8Array[] = [];
  let i = 12;
  let removeu = false;
  while (i + 8 <= b.length) {
    const id = ascii(b, i, i + 4);
    const tam = le32(i + 4);
    const fim = i + 8 + tam + (tam & 1);
    if (fim > b.length + 1) throw new Error("bloco além do arquivo");
    const trecho = b.slice(i, Math.min(fim, b.length));
    if (id === "EXIF" || id === "XMP " || id === "ICCP") removeu = true;
    else {
      if (id === "VP8X") trecho[8] &= ~(0x20 | 0x08 | 0x04); // ICC, EXIF, XMP
      partes.push(trecho);
    }
    i = fim;
  }
  const corpo = concat(partes);
  const out = new Uint8Array(12 + corpo.length);
  out.set(b.subarray(0, 12), 0);
  out.set(corpo, 12);
  const riff = out.length - 8;
  out[4] = riff & 0xff; out[5] = (riff >> 8) & 0xff; out[6] = (riff >> 16) & 0xff; out[7] = (riff >>> 24) & 0xff;
  return { bytes: out, removeu };
}

/**
 * HEIC (ISO-BMFF): acha os itens "Exif" e XMP (mime application/rdf+xml) em
 * meta/iinf e os dados deles em meta/iloc, e ZERA esses bytes no lugar.
 * Nada muda de tamanho nem de posição.
 */
function limparHeic(b: Uint8Array): { bytes: Uint8Array; removeu: boolean } {
  const u = (i: number, n: number) => { let v = 0; for (let k = 0; k < n; k++) v = v * 256 + b[i + k]; return v; };
  type Caixa = { tipo: string; ini: number; corpo: number; fim: number };
  const caixas = (de: number, ate: number): Caixa[] => {
    const out: Caixa[] = [];
    let i = de;
    while (i + 8 <= ate) {
      let tam = u(i, 4); let cab = 8;
      const tipo = ascii(b, i + 4, i + 8);
      if (tam === 1) { tam = u(i + 8, 8); cab = 16; } else if (tam === 0) tam = ate - i;
      if (tam < cab || i + tam > ate) throw new Error("caixa inválida");
      out.push({ tipo, ini: i, corpo: i + cab, fim: i + tam });
      i += tam;
    }
    return out;
  };
  const meta = caixas(0, b.length).find((c) => c.tipo === "meta");
  if (!meta) return { bytes: b, removeu: false };
  const filhas = caixas(meta.corpo + 4, meta.fim); // meta é FullBox: pula versão+flags
  const iinf = filhas.find((c) => c.tipo === "iinf");
  const iloc = filhas.find((c) => c.tipo === "iloc");
  if (!iinf || !iloc) return { bytes: b, removeu: false };

  // Itens a apagar
  const alvos = new Set<number>();
  const vInf = b[iinf.corpo];
  const infes = caixas(iinf.corpo + 4 + (vInf === 0 ? 2 : 4), iinf.fim);
  for (const e of infes) {
    if (e.tipo !== "infe") continue;
    const v = b[e.corpo];
    if (v < 2) continue;
    let p = e.corpo + 4;
    const id = v === 2 ? u(p, 2) : u(p, 4); p += v === 2 ? 2 : 4;
    p += 2; // item_protection_index
    const tipoItem = ascii(b, p, p + 4); p += 4;
    if (tipoItem === "Exif") alvos.add(id);
    else if (tipoItem === "mime") {
      while (p < e.fim && b[p] !== 0) p++; p++; // item_name
      let q = p; while (q < e.fim && b[q] !== 0) q++;
      const ct = String.fromCharCode(...b.subarray(p, q)).toLowerCase();
      if (ct.includes("xmp") || ct.includes("rdf+xml")) alvos.add(id);
    }
  }
  if (alvos.size === 0) return { bytes: b, removeu: false };

  // Onde estão os dados deles
  const out = b.slice();
  const vLoc = b[iloc.corpo];
  let p = iloc.corpo + 4;
  const offSz = b[p] >> 4, lenSz = b[p] & 15; p++;
  const baseSz = b[p] >> 4, idxSz = vLoc >= 1 ? b[p] & 15 : 0; p++;
  const n = vLoc < 2 ? u(p, 2) : u(p, 4); p += vLoc < 2 ? 2 : 4;
  let removeu = false;
  for (let k = 0; k < n; k++) {
    const id = vLoc < 2 ? u(p, 2) : u(p, 4); p += vLoc < 2 ? 2 : 4;
    let metodo = 0;
    if (vLoc >= 1) { metodo = u(p, 2) & 15; p += 2; }
    p += 2; // data_reference_index
    const base = u(p, baseSz); p += baseSz;
    const ne = u(p, 2); p += 2;
    for (let e = 0; e < ne; e++) {
      p += idxSz;
      const off = u(p, offSz); p += offSz;
      const len = u(p, lenSz); p += lenSz;
      if (alvos.has(id) && metodo === 0 && base + off + len <= out.length) { out.fill(0, base + off, base + off + len); removeu = true; }
    }
  }
  return { bytes: out, removeu };
}

/** JPEG: descarta APP1 (EXIF/XMP), APP2 (ICC), APP13 (IPTC) e COM. Mantém APP0 (JFIF) e APP14 (Adobe). */
function limparJpeg(b: Uint8Array): { bytes: Uint8Array; removeu: boolean } {
  const partes: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  let removeu = false;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) break;
    const marcador = b[i + 1];
    if (marcador === 0xda) { partes.push(b.subarray(i)); i = b.length; break; } // SOS: daqui em diante é imagem
    if (marcador === 0xd8 || (marcador >= 0xd0 && marcador <= 0xd7) || marcador === 0x01) { partes.push(b.subarray(i, i + 2)); i += 2; continue; }
    const tam = (b[i + 2] << 8) | b[i + 3];
    const descartar = marcador === 0xe1 || marcador === 0xe2 || marcador === 0xed || marcador === 0xfe;
    if (descartar) removeu = true; else partes.push(b.subarray(i, i + 2 + tam));
    i += 2 + tam;
  }
  if (i < b.length) partes.push(b.subarray(i));
  return { bytes: concat(partes), removeu };
}

/** PNG: descarta tEXt, zTXt, iTXt, eXIf, tIME. Mantém o resto. */
function limparPng(b: Uint8Array): { bytes: Uint8Array; removeu: boolean } {
  const partes: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  let removeu = false;
  const remover = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);
  while (i + 12 <= b.length) {
    const len = (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
    const tipo = ascii(b, i + 4, i + 8);
    const fim = i + 12 + len;
    if (remover.has(tipo)) removeu = true; else partes.push(b.subarray(i, fim));
    i = fim;
    if (tipo === "IEND") break;
  }
  return { bytes: concat(partes), removeu };
}

function concat(partes: Uint8Array[]): Uint8Array {
  const total = partes.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of partes) { out.set(p, o); o += p.length; }
  return out;
}
