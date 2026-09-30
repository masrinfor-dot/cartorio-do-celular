import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";

export function Botao({ variante = "primario", grande, className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variante?: "primario" | "secundario" | "perigo"; grande?: boolean }) {
  return <button {...p} className={`btn btn-${variante} ${grande ? "btn-grande" : ""} ${className}`} />;
}

export const Campo = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { erro?: string | null }>(function Campo({ erro, className = "", ...p }, ref) {
  return <input ref={ref} {...p} className={`campo ${erro ? "campo-erro" : ""} ${className}`} aria-invalid={!!erro} />;
});

export function Rotulo({ children, htmlFor, obrigatorio }: { children: ReactNode; htmlFor?: string; obrigatorio?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-sm font-semibold text-slate-700">
      {children}
      {obrigatorio && <span className="text-red-600"> *</span>}
    </label>
  );
}

export function Erro({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <p className="mt-1 text-sm font-medium text-red-700" role="alert">{children}</p>;
}

export function Aviso({ tom = "neutro", titulo, children }: { tom?: "ok" | "alerta" | "bloqueio" | "neutro" | "info"; titulo?: ReactNode; children?: ReactNode }) {
  const cls = {
    ok: "bg-teal-50 border-teal-300 text-teal-950",
    alerta: "bg-amber-50 border-amber-300 text-amber-950",
    bloqueio: "bg-red-50 border-red-300 text-red-950",
    neutro: "bg-slate-50 border-slate-300 text-slate-800",
    info: "bg-sky-50 border-sky-300 text-sky-950",
  }[tom];
  return (
    <div className={`rounded-lg border-2 px-4 py-3 ${cls}`} role={tom === "bloqueio" ? "alert" : undefined}>
      {titulo && <p className="font-bold">{titulo}</p>}
      {children && <div className="text-sm leading-snug">{children}</div>}
    </div>
  );
}

export function Selo({ tipo }: { tipo: "verificado" | "declarado" | "assistido" | "forte" }) {
  const rot = { verificado: "Verificado", declarado: "Declarado", assistido: "Aceite assistido", forte: "Aceite forte" }[tipo];
  return <span className={`selo selo-${tipo}`}>{rot}</span>;
}

export function Carregando({ texto = "Carregando…" }: { texto?: string }) {
  return (
    <div className="flex items-center gap-3 text-slate-600" role="status">
      <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-teal-700" />
      {texto}
    </div>
  );
}

export function formatarData(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export function mmss(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
