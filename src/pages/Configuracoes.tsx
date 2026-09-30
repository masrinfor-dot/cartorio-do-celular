// Configurações da loja: tabelas de margem, questionário de avaliação
// (Apple × Android), formas de pagamento, tabela de valores base e integração
// com o ERP. Tudo por loja, como no CRM.

import { useEffect, useState, type FormEvent } from "react";
import { api, type AvaliacaoConfig } from "@/api/index.ts";
import { formatarCentavos, type Pergunta, type QuestionarioConfig } from "@core/index.ts";
import { Aviso, Botao, Campo, Carregando, Rotulo } from "@/components/ui.tsx";
import { mensagemDeErro } from "@/lib/session.tsx";

export function Configuracoes() {
  const [c, setC] = useState<AvaliacaoConfig | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [aba, setAba] = useState<"margens" | "perguntas" | "pagamentos" | "valores" | "erp">("margens");
  useEffect(() => { api.avaliacao.config().then(setC).catch((e) => setErro(mensagemDeErro(e))); }, []);

  async function salvar(patch: Parameters<typeof api.avaliacao.salvarConfig>[0], msg = "Salvo.") {
    setErro(null); setOk(null);
    try { setC(await api.avaliacao.salvarConfig(patch)); setOk(msg); } catch (e) { setErro(mensagemDeErro(e)); }
  }

  if (!c) return <Carregando />;
  const abas = [["margens", "Margens"], ["perguntas", "Questionário"], ["pagamentos", "Pagamentos"], ["valores", "Valores base"], ["erp", "Integração ERP"]] as const;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-black tracking-tight">Configurações</h1>
      <div className="flex flex-wrap gap-1">{abas.map(([k, r]) => <button key={k} onClick={() => { setAba(k); setOk(null); setErro(null); }} className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${aba === k ? "bg-teal-700 text-white" : "bg-white border border-slate-300"}`}>{r}</button>)}</div>
      {erro && <Aviso tom="bloqueio">{erro}</Aviso>}
      {ok && <Aviso tom="ok">{ok}</Aviso>}

      {aba === "margens" && <Margens c={c} onSalvar={(m) => salvar({ margens: m })} />}
      {aba === "perguntas" && <Questionario c={c} onSalvar={(q) => salvar({ questionario: q })} />}
      {aba === "pagamentos" && <Pagamentos c={c} onSalvar={(f) => salvar({ formas_pagamento: f })} />}
      {aba === "valores" && <ValoresBase c={c} onImportar={(t) => salvar({ valores_base_texto: t }, "Tabela importada.")} onRemover={async (id) => { await api.avaliacao.removerValorBase(id); setC(await api.avaliacao.config()); }} />}
      {aba === "erp" && <Erp c={c} onSalvar={(e) => salvar({ erp: e })} />}
    </div>
  );
}

function Margens({ c, onSalvar }: { c: AvaliacaoConfig; onSalvar: (m: AvaliacaoConfig["margens"]) => void }) {
  const [m, setM] = useState(c.margens);
  return (
    <form className="cartao space-y-3" onSubmit={(e) => { e.preventDefault(); onSalvar(m); }}>
      <p className="text-sm text-slate-600">Margem da loja sobre o valor de revenda. A sugestão de compra é o valor base × (100 − margem)%. Entre 1 e 90.</p>
      <div className="grid grid-cols-3 gap-3">
        {(["t1", "t2", "t3"] as const).map((k, i) => (
          <div key={k}><Rotulo>Tabela {i + 1} · {["maior", "média", "menor"][i]} (%)</Rotulo><Campo inputMode="numeric" value={m[k]} onChange={(e) => setM({ ...m, [k]: Number(e.target.value) })} /></div>
        ))}
      </div>
      <Botao type="submit">Salvar margens</Botao>
    </form>
  );
}

function Questionario({ c, onSalvar }: { c: AvaliacaoConfig; onSalvar: (q: QuestionarioConfig) => void }) {
  const [q, setQ] = useState<QuestionarioConfig>(JSON.parse(JSON.stringify(c.questionario)));
  const [grupo, setGrupo] = useState<"apple" | "android">("apple");
  const lista = q[grupo];
  const set = (nova: Pergunta[]) => setQ({ ...q, [grupo]: nova });
  const upd = (i: number, p: Partial<Pergunta>) => set(lista.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <form className="cartao space-y-4" onSubmit={(e) => { e.preventDefault(); onSalvar(q); }}>
      <div className="flex gap-2">
        {(["apple", "android"] as const).map((g) => <button key={g} type="button" onClick={() => setGrupo(g)} className={`rounded-full border-2 px-4 py-1.5 font-semibold ${grupo === g ? "border-teal-700 bg-teal-700 text-white" : "border-slate-300"}`}>{g === "apple" ? "Apple" : "Android"}</button>)}
        <p className="ml-auto self-center text-xs text-slate-500">"Bloqueia" recusa a avaliação; "desconto" reduz a sugestão de compra.</p>
      </div>
      {lista.map((p, i) => (
        <div key={i} className="rounded-lg border-2 border-slate-200 p-3 space-y-2">
          <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
            <Campo placeholder="Título curto" value={p.key} onChange={(e) => upd(i, { key: e.target.value })} />
            <Campo placeholder="Pergunta" value={p.label} onChange={(e) => upd(i, { label: e.target.value })} />
            <button type="button" className="text-sm text-red-700 underline" onClick={() => set(lista.filter((_, j) => j !== i))}>Remover</button>
          </div>
          <div className="space-y-1">
            {p.options.map((o, k) => (
              <div key={k} className="flex flex-wrap items-center gap-2 text-sm">
                <input className="campo !w-56 !py-1.5 !text-sm" placeholder="Opção" value={o.label} onChange={(e) => upd(i, { options: p.options.map((x, l) => (l === k ? { ...x, label: e.target.value } : x)) })} />
                <label className="flex items-center gap-1"><input type="checkbox" checked={o.blocks} onChange={(e) => upd(i, { options: p.options.map((x, l) => (l === k ? { ...x, blocks: e.target.checked } : x)) })} /> bloqueia</label>
                <label className="flex items-center gap-1">desconto <input className="campo !w-16 !py-1 !text-sm" inputMode="numeric" value={o.deductionPercent ?? 0} onChange={(e) => upd(i, { options: p.options.map((x, l) => (l === k ? { ...x, deductionPercent: Number(e.target.value) || 0 } : x)) })} />%</label>
                <button type="button" className="text-xs text-red-700 underline" onClick={() => upd(i, { options: p.options.filter((_, l) => l !== k) })}>tirar</button>
              </div>
            ))}
            <button type="button" className="text-xs underline" onClick={() => upd(i, { options: [...p.options, { label: "", blocks: false }] })}>+ opção</button>
          </div>
        </div>
      ))}
      <div className="flex gap-3">
        <Botao type="button" variante="secundario" onClick={() => set([...lista, { key: "", label: "", options: [{ label: "", blocks: false }, { label: "", blocks: false }] }])}>+ pergunta</Botao>
        <Botao type="submit">Salvar questionário</Botao>
      </div>
    </form>
  );
}

function Pagamentos({ c, onSalvar }: { c: AvaliacaoConfig; onSalvar: (f: string[]) => void }) {
  const [txt, setTxt] = useState(c.formas_pagamento.join("\n"));
  return (
    <form className="cartao space-y-3" onSubmit={(e) => { e.preventDefault(); onSalvar(txt.split(/\n/).map((s) => s.trim()).filter(Boolean)); }}>
      <p className="text-sm text-slate-600">Uma forma de pagamento por linha (até 20).</p>
      <textarea className="campo min-h-40 font-mono text-sm" value={txt} onChange={(e) => setTxt(e.target.value)} />
      <Botao type="submit">Salvar formas de pagamento</Botao>
    </form>
  );
}

function ValoresBase({ c, onImportar, onRemover }: { c: AvaliacaoConfig; onImportar: (t: string) => void; onRemover: (id: string) => Promise<void> }) {
  const [txt, setTxt] = useState("");
  return (
    <div className="space-y-4">
      <form className="cartao space-y-3" onSubmit={(e) => { e.preventDefault(); onImportar(txt); setTxt(""); }}>
        <p className="text-sm text-slate-600">Valor de referência de um aparelho em <strong>estado perfeito</strong>. Com o modelo aqui, a sugestão sai na hora, sem IA. Formato: <code>Marca;Modelo;Armazenamento;Valor</code> — armazenamento em branco vale para qualquer tamanho.</p>
        <textarea className="campo min-h-32 font-mono text-sm" placeholder={"Apple;iPhone 13;128GB;2000\nApple;iPhone 13;256GB;2300\nSamsung;Galaxy S23;;1800"} value={txt} onChange={(e) => setTxt(e.target.value)} />
        <Botao type="submit" disabled={!txt.trim()}>Importar linhas</Botao>
      </form>
      <div className="cartao">
        {c.valores_base.length === 0 && <p className="text-sm text-slate-600">Nenhum valor cadastrado.</p>}
        <ul className="divide-y divide-slate-200 text-sm">
          {c.valores_base.map((v) => (
            <li key={v.id} className="flex items-center gap-3 py-1.5"><span className="flex-1">{v.brand} {v.model} {v.storage ?? "(qualquer)"}</span><span className="font-semibold">{formatarCentavos(Math.round(v.baseValue * 100))}</span><button className="text-xs text-red-700 underline" onClick={() => onRemover(v.id)}>remover</button></li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Erp({ c, onSalvar }: { c: AvaliacaoConfig; onSalvar: (e: Partial<AvaliacaoConfig["erp"]> & { token?: string }) => void }) {
  const [e, setE] = useState({ ...c.erp, token: "" });
  function enviar(ev: FormEvent) { ev.preventDefault(); const { token_definido: _t, ...resto } = e; onSalvar({ ...resto, token: e.token || undefined }); }
  return (
    <form className="cartao space-y-3" onSubmit={enviar}>
      <p className="text-sm text-slate-600">Para quem usa o Cartório junto com o <strong>Sheik Company ERP</strong>: compras e vendas concluídas aqui são enviadas ao ERP, que dá entrada no estoque e emite a NF-e. O banco do Cartório continua separado — o ERP só recebe o que foi concluído. Quem usa só o Cartório deixa isto desligado e trabalha com as notas de compra e venda daqui.</p>
      <label className="flex items-center gap-2 font-semibold"><input type="checkbox" checked={e.ativo} onChange={(ev) => setE({ ...e, ativo: ev.target.checked })} /> Integração ativa</label>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><Rotulo>URL da API do ERP</Rotulo><Campo placeholder="https://erp.suaempresa.com.br/api" value={e.url} onChange={(ev) => setE({ ...e, url: ev.target.value })} /></div>
        <div><Rotulo>Token de acesso {c.erp.token_definido && <span className="text-xs text-teal-800">(já definido — preencha para trocar)</span>}</Rotulo><Campo type="password" value={e.token} onChange={(ev) => setE({ ...e, token: ev.target.value })} /></div>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-1"><input type="checkbox" checked={e.enviar_compras} onChange={(ev) => setE({ ...e, enviar_compras: ev.target.checked })} /> enviar compras</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={e.enviar_vendas} onChange={(ev) => setE({ ...e, enviar_vendas: ev.target.checked })} /> enviar vendas</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={e.solicitar_nfe} onChange={(ev) => setE({ ...e, solicitar_nfe: ev.target.checked })} /> solicitar NF-e ao ERP</label>
      </div>
      <Botao type="submit">Salvar integração</Botao>
    </form>
  );
}
