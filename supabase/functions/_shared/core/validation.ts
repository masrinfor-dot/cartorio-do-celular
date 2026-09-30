// Validações de dado de entrada. Puras, sem I/O.

export function onlyDigits(s: string): string {
  return (s ?? "").replace(/\D+/g, "");
}

/** IMEI: 15 dígitos e dígito verificador de Luhn. */
export function imeiValido(raw: string): boolean {
  const p = onlyDigits(raw);
  if (!/^\d{15}$/.test(p)) return false;
  let soma = 0;
  let dobra = false;
  for (let i = 14; i >= 0; i--) {
    let d = Number(p[i]);
    if (dobra) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    soma += d;
    dobra = !dobra;
  }
  return soma % 10 === 0;
}

/** Completa um IMEI de 14 dígitos com o dígito de Luhn — útil para dados sintéticos. */
export function completarImei(base14: string): string {
  const p = onlyDigits(base14).slice(0, 14).padStart(14, "0");
  for (let d = 0; d <= 9; d++) {
    if (imeiValido(p + d)) return p + d;
  }
  throw new Error("não foi possível completar o IMEI");
}

export function cpfValido(raw: string): boolean {
  const c = onlyDigits(raw);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (len: number) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += Number(c[i]) * (len + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}

export function cnpjValido(raw: string): boolean {
  const c = onlyDigits(raw);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (len: number) => {
    const pesos = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let s = 0;
    for (let i = 0; i < len; i++) s += Number(c[i]) * pesos[i];
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
}

export function documentoValido(raw: string, tipo: "pf" | "pj"): boolean {
  return tipo === "pf" ? cpfValido(raw) : cnpjValido(raw);
}

export function mascararImei(imei: string): string {
  const p = onlyDigits(imei);
  if (p.length < 8) return "****";
  return `${p.slice(0, 4)}****${p.slice(-4)}`;
}

/** (31) 9****-1234 */
export function mascararTelefone(raw: string): string {
  const p = onlyDigits(raw);
  if (p.length < 8) return "****";
  const ddd = p.length >= 10 ? p.slice(0, 2) : "";
  const fim = p.slice(-4);
  const primeiro = p.length >= 11 ? p.slice(2, 3) : "";
  return `${ddd ? `(${ddd}) ` : ""}${primeiro}****-${fim}`;
}

/** Primeiro nome + inicial do sobrenome: "Maria S." */
export function nomeCurto(nome: string): string {
  const partes = (nome ?? "").trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "";
  if (partes.length === 1) return partes[0];
  return `${partes[0]} ${partes[partes.length - 1][0].toUpperCase()}.`;
}

export function primeiroNome(nome: string): string {
  return (nome ?? "").trim().split(/\s+/)[0] ?? "";
}

export function formatarCentavos(centavos: number): string {
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function formatarCpf(raw: string): string {
  const d = onlyDigits(raw);
  return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : raw;
}

export function formatarCnpj(raw: string): string {
  const d = onlyDigits(raw);
  return d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : raw;
}
