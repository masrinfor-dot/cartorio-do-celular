// Hash, HMAC, cifra e protocolo. Usa só Web Crypto — funciona em Deno, no
// navegador e no Node 20+.

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * JSON canônico: chaves em ordem alfabética, sem espaço supérfluo. O mesmo
 * conteúdo produz sempre a mesma string — e portanto o mesmo hash.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortKeys(val);
    }
    return out;
  }
  return v;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

export async function hashTerms(payload: unknown): Promise<string> {
  return sha256Hex(canonicalJson(payload));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** Hash de busca exata de CPF/CNPJ: HMAC com pepper. Nunca o valor em claro. */
export function hashDocumento(pepper: string, documento: string): Promise<string> {
  return hmacSha256Hex(pepper, `doc:${documento}`);
}

/** HMAC do código de aceite, amarrado ao convite — o código não é gravado em claro. */
export function hashOtp(pepper: string, inviteId: string, codigo: string): Promise<string> {
  return hmacSha256Hex(pepper, `otp:${inviteId}:${codigo}`);
}

// ---------------------------------------------------------------------------
// AES-256-GCM para CPF/CNPJ. Formato gravado: base64(iv) + "." + base64(cipher)
// ---------------------------------------------------------------------------

async function aesKey(keyB64: string): Promise<CryptoKey> {
  const raw = fromBase64(keyB64);
  if (raw.length !== 32) throw new Error("REGISTRY_PII_KEY precisa ter 32 bytes em base64");
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function cifrar(keyB64: string, texto: string): Promise<string> {
  const key = await aesKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(texto));
  return `${toBase64(iv)}.${toBase64(new Uint8Array(ct))}`;
}

export async function decifrar(keyB64: string, blob: string): Promise<string> {
  const [ivB64, ctB64] = blob.split(".");
  const key = await aesKey(keyB64);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(ivB64) as BufferSource },
    key,
    fromBase64(ctB64) as BufferSource,
  );
  return new TextDecoder().decode(pt);
}

// ---------------------------------------------------------------------------
// Aleatoriedade
// ---------------------------------------------------------------------------

const BASE32 = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // sem I, L, O, U, 0, 1 — evita confusão lida em voz alta

/** Protocolo público: 10 caracteres, não sequencial, não enumerável. */
export function gerarProtocolo(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = "";
  for (const b of bytes) out += BASE32[b % BASE32.length];
  return out;
}

/** Token do link de aceite: 32 bytes aleatórios em base64url. */
export function gerarToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Código de 6 dígitos, com zero à esquerda. */
export function gerarOtp(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, "0");
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** Comparação em tempo constante de duas strings hex do mesmo tamanho. */
export function iguaisTempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
