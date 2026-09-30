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

/** Remove metadados. JPEG e PNG são reescritos sem os segmentos; WebP/HEIC voltam intactos (marcados). */
export function removerMetadados(b: Uint8Array, tipo: TipoImagem): { bytes: Uint8Array; removeu: boolean; suportado: boolean } {
  if (tipo === "image/jpeg") return { ...limparJpeg(b), suportado: true };
  if (tipo === "image/png") return { ...limparPng(b), suportado: true };
  return { bytes: b, removeu: false, suportado: false };
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
