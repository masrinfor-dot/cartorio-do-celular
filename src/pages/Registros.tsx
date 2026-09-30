import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type TransacaoView } from "@/api/index.ts";
import { rotuloEstado } from "@core/index.ts";
import { Carregando, formatarData, Botao } from "@/components/ui.tsx";

const ROTULO_KIND = { pf_pj: "Entrada (PF → loja)", pj_pf: "Revenda (loja → PF)", pf_pf: "Pessoa → pessoa", pj_pj: "Loja → loja" };

export function Registros() {
  const [lista, setLista] = useState<TransacaoView[] | null>(null);
  useEffect(() => { api.transacao.listar().then(setLista); }, []);
  if (!lista) return <Carregando />;
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-black tracking-tight">Registros da loja</h1>
        <Link to="/balcao"><Botao>Nova entrada</Botao></Link>
      </div>
      {lista.length === 0 && <p className="text-slate-600">Nenhum registro ainda. Comece pelo balcão.</p>}
      <ul className="space-y-2">
        {lista.map((t) => (
          <li key={t.id} className="cartao flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-mono text-lg font-bold tracking-wider">{t.public_protocol}</span>
            <span className="text-sm text-slate-600">{ROTULO_KIND[t.kind]}</span>
            <span className="text-sm">{t.device ? `${t.device.brand ?? ""} ${t.device.model ?? ""} · IMEI ${t.device.imei_mascarado}` : "—"}</span>
            <span className={`ml-auto rounded-md px-2 py-0.5 text-xs font-bold uppercase ${t.state === "completed" ? "bg-teal-100 text-teal-900" : t.state === "blocked" ? "bg-red-100 text-red-900" : "bg-slate-200 text-slate-800"}`}>{rotuloEstado(t.state)}</span>
            <span className="text-xs text-slate-500">{formatarData(t.created_at)}</span>
            {t.state === "completed" ? (
              <Link className="text-sm text-teal-800 underline" to={`/certificado/${t.public_protocol}`}>Certificado</Link>
            ) : ["cancelled", "expired", "blocked", "disputed"].includes(t.state) ? null : (
              <Link className="text-sm text-teal-800 underline" to={`/${t.kind === "pj_pf" ? "revenda" : "balcao"}?tx=${t.id}`}>Continuar</Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
