// Compras — "Celulares comprados" e "Últimas avaliações", com totais, busca e
// as ações do CRM: Completar IMEI, Reimprimir nota, Editar/continuar registro,
// Certificado, Enviar ao ERP, Excluir (só antes da conclusão — o lastro é append-only).

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type AvaliacaoView } from "@/api/index.ts";
import { formatarCentavos, rotuloEstado } from "@core/index.ts";
import { Aviso, Botao, Carregando, Selo, formatarData } from "@/components/ui.tsx";
import { mensagemDeErro } from "@/lib/session.tsx";
import { CompletarImei } from "./Avaliacao.tsx";
import { EnviarErp } from "@/components/EnviarErp.tsx";

export function Compras() {
  const [lista, setLista] = useState<AvaliacaoView[] | null>(null);
  const [aba, setAba] = useState<"comprados" | "avaliacoes">("comprados");
  const [busca, setBusca] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [imeiAberto, setImeiAberto] = useState<string | null>(null);

  const recarregar = () => api.avaliacao.listar().then(setLista).catch((e) => setErro(mensagemDeErro(e)));
  useEffect(() => { recarregar(); }, []);

  const comprados = useMemo(() => (lista ?? []).filter((a) => a.closed_at), [lista]);
  const abertas = useMemo(() => (lista ?? []).filter((a) => !a.closed_at), [lista]);
  const mesAtual = (d: string | null) => { if (!d) return false; const x = new Date(d), n = new Date(); return x.getMonth() === n.getMonth() && x.getFullYear() === n.getFullYear(); };
  const totais = {
    total: comprados.length,
    pago: comprados.reduce((s, a) => s + (a.final_price_centavos ?? 0), 0),
    mes: comprados.filter((a) => mesAtual(a.closed_at)).length,
    pagoMes: comprados.filter((a) => mesAtual(a.closed_at)).reduce((s, a) => s + (a.final_price_centavos ?? 0), 0),
  };
  const porPagamento = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of comprados) m.set(a.payment_method ?? "Não informado", (m.get(a.payment_method ?? "Não informado") ?? 0) + 1);
    return [...m.entries()];
  }, [comprados]);

  const filtro = (a: AvaliacaoView) => {
    const q = busca.trim().toLowerCase();
    if (!q) return true;
    return [a.device, a.brand, a.model, a.customer_name, a.seller_display_name, a.imei_mascarado, a.protocolo].filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
  };

  async function excluir(a: AvaliacaoView) {
    if (!confirm(`Excluir ${a.closed_at ? "esta compra" : "esta avaliação"}? ${a.closed_at ? "A transação do Cartório será cancelada." : ""}`)) return;
    try { await api.avaliacao.excluir(a.id); await recarregar(); } catch (e) { setErro(mensagemDeErro(e)); }
  }

  if (!lista) return <Carregando />;
  const itens = (aba === "comprados" ? comprados : abertas).filter(filtro);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-black tracking-tight">Avaliação de Usados</h1>
        <div className="ml-auto flex gap-2">
          <button className={`rounded-lg border-2 px-3 py-1.5 text-sm font-semibold ${aba === "comprados" ? "border-teal-700 bg-teal-50" : "border-slate-300 bg-white"}`} onClick={() => setAba("comprados")}>📱 Celulares comprados</button>
          <button className={`rounded-lg border-2 px-3 py-1.5 text-sm font-semibold ${aba === "avaliacoes" ? "border-teal-700 bg-teal-50" : "border-slate-300 bg-white"}`} onClick={() => setAba("avaliacoes")}>🕓 Últimas avaliações</button>
          <Link to="/avaliacao"><Botao>Nova avaliação</Botao></Link>
        </div>
      </div>
      {erro && <Aviso tom="bloqueio">{erro}</Aviso>}

      <div className="cartao space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[["Total comprado", String(totais.total)], ["Valor total pago", formatarCentavos(totais.pago)], ["Este mês", String(totais.mes)], ["Valor este mês", formatarCentavos(totais.pagoMes)]].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-slate-200 p-3"><p className="text-[11px] font-bold uppercase text-slate-500">{k}</p><p className="text-xl font-black">{v}</p></div>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">{porPagamento.map(([k, n]) => <span key={k} className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold">{k}: {n}</span>)}</div>
        <input className="campo" placeholder="Pesquisar aparelho, marca, modelo, cliente, IMEI ou protocolo…" value={busca} onChange={(e) => setBusca(e.target.value)} />

        {itens.length === 0 && <p className="py-6 text-center text-slate-600">{aba === "comprados" ? "Nenhuma compra ainda." : "Nenhuma avaliação em aberto."}</p>}
        <ul className="divide-y divide-slate-200">
          {itens.map((a) => (
            <li key={a.id} className="py-3 space-y-1.5">
              <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
                <div className="min-w-0 flex-1">
                  <p className="font-bold">{a.device}</p>
                  <p className="text-sm text-slate-600">{a.seller_display_name ?? a.customer_name ?? "—"}{a.seller_telefone_mascarado ? ` · ${a.seller_telefone_mascarado}` : ""}</p>
                  <p className="text-xs text-slate-500">{a.closed_at ? `Comprado ${formatarData(a.closed_at)}` : `Avaliado ${formatarData(a.created_at)}`}{a.store_name ? ` · ${a.store_name}` : ""}</p>
                </div>
                <span className="rounded-md bg-teal-100 px-2 py-0.5 font-bold text-teal-900">{formatarCentavos(a.final_price_centavos ?? a.estimativa?.sugestao_centavos ?? 0)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                {a.closed_at ? (
                  <>
                    {a.imei_pendente ? <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-900">IMEI pendente</span> : <span className="font-mono text-xs">IMEI {a.imei_mascarado}</span>}
                    {a.transaction_state && <span className={`rounded-md px-2 py-0.5 text-xs font-bold uppercase ${a.transaction_state === "completed" ? "bg-teal-100 text-teal-900" : a.transaction_state === "blocked" ? "bg-red-100 text-red-900" : "bg-slate-200 text-slate-800"}`}>{rotuloEstado(a.transaction_state)}</span>}
                    {a.protocolo && <span className="font-mono text-xs font-bold tracking-wider">{a.protocolo}</span>}
                    {a.aceite_grade && <Selo tipo={a.aceite_grade === "assistido" ? "assistido" : "forte"} />}
                    {a.payment_method && <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs">{a.payment_method}</span>}
                    {a.imei_pendente && <button className="font-semibold text-teal-800 underline" onClick={() => setImeiAberto(imeiAberto === a.id ? null : a.id)}>Completar IMEI</button>}
                    {!a.imei_pendente && a.transaction_state !== "completed" && <Link className="font-semibold text-teal-800 underline" to={`/avaliacao?id=${a.id}`}>Continuar registro</Link>}
                    <Link className="underline" to={`/compras/${a.id}/nota`}>🖨 Reimprimir nota</Link>
                    {a.protocolo && <Link className="underline" to={`/certificado/${a.protocolo}`}>Certificado</Link>}
                    {a.transaction_id && a.transaction_state === "completed" && <EnviarErp transaction_id={a.transaction_id} compacto />}
                    {a.transaction_state !== "completed" && <button className="text-red-700 underline" onClick={() => excluir(a)}>Excluir</button>}
                  </>
                ) : (
                  <>
                    <span className="text-xs text-slate-500">{a.estimativa ? `Tabela ${a.margem_tabela} · ${a.estimativa.metodo}` : "sem sugestão automática"}</span>
                    <Link className="font-semibold text-teal-800 underline" to={`/avaliacao?id=${a.id}`}>Fechar negócio</Link>
                    <button className="text-red-700 underline" onClick={() => excluir(a)}>Excluir</button>
                  </>
                )}
              </div>
              {imeiAberto === a.id && a.imei_pendente && <CompletarImei avaliacao={a} onFeito={async () => { setImeiAberto(null); await recarregar(); }} />}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
