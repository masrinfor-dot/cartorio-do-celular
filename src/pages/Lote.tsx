// Venda em lote para outra loja (PJ→PJ). Uma transação por aparelho (protocolo,
// certificado e elo próprios); um link e um código para a loja compradora aceitar
// o conjunto. Itens que a consulta de procedência não liberou ficam de fora do
// convite, com o motivo à vista — o lote nunca "arrasta" um aparelho com restrição.

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type EstoqueItem, type LoteItemView, type LoteResumo, type LoteView } from "@/api/index.ts";
import { formatarCentavos, formatarCnpj, onlyDigits, parseReais, rotuloEstado } from "@core/index.ts";
import { Aviso, Botao, Campo, Carregando, Erro, Rotulo, formatarData } from "@/components/ui.tsx";
import { mensagemDeErro } from "@/lib/session.tsx";

const nomeAparelho = (d: { brand: string | null; model: string | null; storage: string | null; color: string | null }) => [d.brand, d.model, d.storage, d.color].filter(Boolean).join(" ") || "Aparelho";

const TEXTO_CONSULTA: Record<string, string> = {
  clear: "Sem restrição na consulta",
  restricted: "Consta restrição na base consultada — fora do lote",
  inconclusive: "Consulta inconclusiva — em revisão, fora do lote",
  unavailable: "Consulta indisponível — fora do lote",
  expired: "Consulta vencida — refaça",
};

// ---------------------------------------------------------------------------
// /lotes — lista
// ---------------------------------------------------------------------------
export function ListaLotes() {
  const [lista, setLista] = useState<LoteResumo[] | null>(null);
  useEffect(() => { api.lote.listar().then(setLista); }, []);
  if (!lista) return <Carregando />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <h1 className="text-2xl font-black tracking-tight">Vendas em lote</h1>
          <p className="text-slate-600">Vários aparelhos para outra loja, com um único aceite. Cada aparelho continua com protocolo e certificado próprios.</p>
        </div>
        <Link to="/lote/novo"><Botao>Novo lote</Botao></Link>
      </div>
      {lista.length === 0 && <Aviso tom="neutro" titulo="Nenhum lote ainda">Escolha os aparelhos de que a loja é titular, informe a loja compradora e envie.</Aviso>}
      <ul className="space-y-2">
        {lista.map((l) => (
          <li key={l.id} className="cartao flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-semibold">{l.comprador}</span>
            <span className="text-sm text-slate-600">{l.itens} aparelho(s) · {formatarCentavos(l.total_centavos)}</span>
            <span className="text-xs text-slate-500">{formatarData(l.criado_em)}</span>
            <span className="text-xs font-semibold">{l.concluidos}/{l.itens} concluído(s)</span>
            <Link className="ml-auto" to={`/lote/${l.id}`}><Botao variante="secundario">Abrir</Botao></Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// /lote/novo
// ---------------------------------------------------------------------------
export function NovoLote() {
  const nav = useNavigate();
  const chave = useRef(crypto.randomUUID());
  const [estoque, setEstoque] = useState<EstoqueItem[] | null>(null);
  const [sel, setSel] = useState<Record<string, string>>({}); // device_id → valor digitado (vazio = marcado sem valor)
  const [padrao, setPadrao] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [nome, setNome] = useState("");
  const [tel, setTel] = useState("");
  const [forma, setForma] = useState("pix");
  const [garantia, setGarantia] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => { api.estoque.listar().then(setEstoque); }, []);

  const marcados = Object.keys(sel);
  const total = useMemo(() => marcados.reduce((n, id) => n + parseReais(sel[id]), 0), [sel, marcados]);
  if (!estoque) return <Carregando />;

  const alternar = (id: string) => setSel((s) => { const n = { ...s }; if (id in n) delete n[id]; else n[id] = padrao; return n; });
  const marcarTodos = () => setSel((s) => (marcados.length === estoque.length ? {} : Object.fromEntries(estoque.map((i) => [i.device.device_id, s[i.device.device_id] ?? padrao]))));
  const aplicarPadrao = () => setSel((s) => Object.fromEntries(Object.keys(s).map((id) => [id, padrao])));

  async function criar(e: FormEvent) {
    e.preventDefault(); setErro(null);
    if (marcados.length === 0) return setErro("Marque ao menos um aparelho.");
    const semValor = marcados.filter((id) => !(parseReais(sel[id]) > 0));
    if (semValor.length) return setErro(`Informe o valor de ${semValor.length} aparelho(s) marcado(s).`);
    setOcupado(true);
    try {
      const l = await api.lote.criar({
        comprador: { documento: cnpj, nome, telefone: tel },
        itens: marcados.map((id) => ({ device_id: id, valor_centavos: parseReais(sel[id]) })),
        forma_pagamento: forma.trim(), garantia: garantia.trim(), idempotency_key: chave.current,
      });
      nav(`/lote/${l.id}`);
    } catch (err) { setErro(mensagemDeErro(err)); } finally { setOcupado(false); }
  }

  return (
    <form onSubmit={criar} className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight">Novo lote para outra loja</h1>
        <p className="text-slate-600">Só entram aparelhos de que esta loja é a titular registrada. Cada um passa pela consulta de procedência; quem não for liberado fica fora do lote.</p>
      </div>

      <section className="cartao space-y-3">
        <h2 className="font-bold">Loja compradora</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Rotulo htmlFor="lcnpj" obrigatorio>CNPJ</Rotulo><Campo id="lcnpj" inputMode="numeric" value={cnpj} onChange={(e) => setCnpj(onlyDigits(e.target.value).length === 14 ? formatarCnpj(e.target.value) : e.target.value)} /></div>
          <div><Rotulo htmlFor="lnome" obrigatorio>Nome da loja</Rotulo><Campo id="lnome" value={nome} onChange={(e) => setNome(e.target.value)} /></div>
          <div className="sm:col-span-2"><Rotulo htmlFor="ltel" obrigatorio>WhatsApp do responsável (o código chega por ele)</Rotulo><Campo id="ltel" inputMode="tel" value={tel} onChange={(e) => setTel(e.target.value)} /></div>
        </div>
      </section>

      <section className="cartao space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-bold flex-1">Aparelhos ({marcados.length} de {estoque.length})</h2>
          <button type="button" className="text-sm underline text-teal-800" onClick={marcarTodos}>{marcados.length === estoque.length ? "Desmarcar todos" : "Marcar todos"}</button>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div><Rotulo htmlFor="lpadrao">Mesmo valor para os marcados (R$)</Rotulo><Campo id="lpadrao" inputMode="decimal" value={padrao} onChange={(e) => setPadrao(e.target.value)} className="!w-40" /></div>
          <Botao type="button" variante="secundario" onClick={aplicarPadrao} disabled={marcados.length === 0 || !padrao}>Aplicar</Botao>
        </div>
        {estoque.length === 0 && <p className="text-slate-600">Nenhum aparelho em estoque. Conclua uma compra em Comprar.</p>}
        <ul className="space-y-2">
          {estoque.map((i) => {
            const id = i.device.device_id;
            const on = id in sel;
            return (
              <li key={id} className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border-2 px-3 py-2 ${on ? "border-teal-700 bg-teal-50" : "border-slate-200"}`}>
                <label className="flex flex-1 min-w-[14rem] cursor-pointer items-center gap-3">
                  <input type="checkbox" className="h-6 w-6 accent-teal-700" checked={on} onChange={() => alternar(id)} aria-label={`Incluir ${nomeAparelho(i.device)}`} />
                  <span><span className="font-semibold block">{nomeAparelho(i.device)}</span><span className="font-mono text-xs text-slate-600">IMEI {i.device.imei_mascarado}</span></span>
                </label>
                {on && <Campo aria-label={`Valor de ${nomeAparelho(i.device)}`} inputMode="decimal" placeholder="R$ valor" className="!w-36" value={sel[id]} onChange={(e) => setSel((s) => ({ ...s, [id]: e.target.value }))} />}
              </li>
            );
          })}
        </ul>
        {marcados.length > 0 && <p className="text-sm font-semibold">Total do lote: {formatarCentavos(total)}</p>}
      </section>

      <section className="cartao space-y-3">
        <h2 className="font-bold">Condições (valem para todo o lote)</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Rotulo htmlFor="lforma" obrigatorio>Forma de pagamento</Rotulo><Campo id="lforma" value={forma} onChange={(e) => setForma(e.target.value)} /></div>
          <div><Rotulo htmlFor="lgar">Garantia</Rotulo><Campo id="lgar" placeholder="Sem garantia" value={garantia} onChange={(e) => setGarantia(e.target.value)} /></div>
        </div>
        <p className="text-xs text-slate-600">As fotos obrigatórias são dispensadas no lote porque a loja vendedora é a titular registrada: o aparelho já entrou no Cartório com a documentação dele.</p>
      </section>

      <Erro>{erro}</Erro>
      <Botao type="submit" grande disabled={ocupado}>{ocupado ? "Criando o lote e consultando…" : `Criar lote com ${marcados.length} aparelho(s)`}</Botao>
    </form>
  );
}

// ---------------------------------------------------------------------------
// /lote/:id
// ---------------------------------------------------------------------------
function Linha({ i }: { i: LoteItemView }) {
  const liberado = i.consulta === "clear";
  return (
    <li className={`rounded-lg border-2 px-3 py-2 ${liberado || i.state === "completed" ? "border-slate-200" : "border-amber-300 bg-amber-50"}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-semibold">{nomeAparelho(i.device)}</span>
        <span className="font-mono text-xs text-slate-600">IMEI {i.device.imei_mascarado}</span>
        <span className="text-sm">{formatarCentavos(i.valor_centavos)}</span>
        <span className="ml-auto text-xs font-semibold">{rotuloEstado(i.state)}</span>
      </div>
      <p className="text-xs text-slate-600">
        {i.consulta ? TEXTO_CONSULTA[i.consulta] : "Ainda sem consulta"}
        {i.no_convite ? ` · ${i.loja_aceitou ? "loja aceitou" : "loja não aceitou"} · ${i.comprador_aceitou ? "comprador aceitou" : "aguardando o comprador"}` : ""}
        {i.state === "completed" && <> · protocolo <span className="font-mono">{i.protocolo}</span> · <Link className="underline" to={`/certificado/${i.protocolo}`}>certificado</Link> · <Link className="underline" to={`/vendas/${i.transaction_id}/nota`}>nota de venda</Link></>}
      </p>
    </li>
  );
}

export function LotePagina() {
  const { id = "" } = useParams();
  const [l, setL] = useState<LoteView | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [resultados, setResultados] = useState<Array<{ protocolo: string; ok: boolean; erro?: string }> | null>(null);

  useEffect(() => {
    let vivo = true;
    const carregar = () => api.lote.obter(id).then((x) => { if (vivo) setL(x); }).catch((e) => { if (vivo) setErro(mensagemDeErro(e)); });
    carregar();
    const t = setInterval(carregar, 3000); // o aceite acontece no celular de outra pessoa
    return () => { vivo = false; clearInterval(t); };
  }, [id]);

  async function enviar() {
    setErro(null); setOcupado(true);
    try { const r = await api.lote.enviar(id); setL(r.lote); setLink(r.link); } catch (e) { setErro(mensagemDeErro(e)); } finally { setOcupado(false); }
  }
  async function concluir() {
    setErro(null); setOcupado(true);
    try { const r = await api.lote.concluir(id); setL(r.lote); setResultados(r.resultados); } catch (e) { setErro(mensagemDeErro(e)); } finally { setOcupado(false); }
  }

  if (!l) return erro ? <Aviso tom="bloqueio">{erro}</Aviso> : <Carregando />;
  const foraDoConvite = l.itens.filter((i) => i.state !== "completed" && !i.no_convite && i.consulta && i.consulta !== "clear");
  const falhas = resultados?.filter((r) => !r.ok) ?? [];

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm"><Link to="/lotes" className="underline text-teal-800">← Lotes</Link></p>
        <h1 className="text-2xl font-black tracking-tight">Lote para {l.comprador.display_name}</h1>
        <p className="text-slate-600">{l.itens.length} aparelho(s) · {formatarCentavos(l.total_centavos)} · criado em {formatarData(l.criado_em)} · {l.concluidos}/{l.itens.length} concluído(s)</p>
      </div>

      {foraDoConvite.length > 0 && (
        <Aviso tom="alerta" titulo={`${foraDoConvite.length} aparelho(s) ficaram fora do lote`}>
          A consulta de procedência não liberou estes itens. Eles não entram no convite e não podem ser transferidos enquanto isso não mudar. Nenhuma conclusão sobre o aparelho — o Cartório só registra o que a consulta apontou na data.
        </Aviso>
      )}

      <ul className="space-y-2">{l.itens.map((i) => <Linha key={i.transaction_id} i={i} />)}</ul>

      {l.convite && !l.convite.aceito && (
        <Aviso tom={l.convite.valido ? "info" : "alerta"} titulo={l.convite.valido ? "Aguardando a loja compradora" : "O convite venceu"}>
          Código e link enviados ao WhatsApp {l.convite.destino_mascarado} em {formatarData(l.convite.enviado_em)}; {l.convite.valido ? `vale até ${formatarData(l.convite.expires_at)}` : "envie de novo"}.
        </Aviso>
      )}
      {l.convite?.aceito && l.concluidos < l.itens.length && <Aviso tom="ok" titulo="A loja compradora aceitou o lote">Agora é só concluir: cada aparelho vira um elo com protocolo próprio.</Aviso>}

      {link && (
        <Aviso tom="info" titulo="Link do convite (aparece só agora)">
          <p className="break-all font-mono text-xs">{link}</p>
          <p className="mt-1">Já foi enviado ao WhatsApp do responsável. Guarde só se precisar reenviar por outro canal.</p>
        </Aviso>
      )}

      <Erro>{erro}</Erro>
      <div className="flex flex-wrap gap-2">
        {l.pode_enviar && <Botao onClick={enviar} disabled={ocupado}>{l.convite ? "Reenviar ao comprador" : "Aceitar pela loja e enviar ao comprador"}</Botao>}
        {l.pode_concluir && <Botao onClick={concluir} disabled={ocupado}>{ocupado ? "Concluindo…" : "Concluir lote"}</Botao>}
      </div>

      {resultados && (
        <Aviso tom={falhas.length ? "alerta" : "ok"} titulo={falhas.length ? `${resultados.length - falhas.length} concluído(s), ${falhas.length} com pendência` : "Lote concluído"}>
          {falhas.length ? <ul className="list-disc pl-5">{falhas.map((f) => <li key={f.protocolo}><span className="font-mono">{f.protocolo}</span>: {f.erro}</li>)}</ul> : "Cada aparelho agora tem protocolo, certificado e nota de venda próprios."}
        </Aviso>
      )}
    </div>
  );
}
