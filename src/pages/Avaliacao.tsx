// Avaliação de Usados — portada do Sheik CRM e ligada ao Cartório.
// Etapas: 1 Aparelho · 2 Condições (checklist) · 3 Oferta (margem) ·
// 4 Fechar negócio (vendedor, IMEI, pagamento, fotos) · 5 Registro no Cartório
// (consulta, aceite pelo celular do vendedor, protocolo) → nota de compra.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, MODO_DEMO, type AvaliacaoConfig, type AvaliacaoView, type MediaView, type TransacaoView } from "@/api/index.ts";
import {
  CORES, MARCAS, MEMORIAS, MODELOS_POR_MARCA, REQUIRED_MEDIA_SLOTS, TABELAS_MARGEM,
  cpfValido, formatarCentavos, imeiValido, marcaApple, margemDaTabela, onlyDigits, parseReais, recalcularOferta, uuid,
  type MediaSlot, type TabelaMargem,
} from "@core/index.ts";
import { Aviso, Botao, Campo, Carregando, Erro, Rotulo, Selo, mmss } from "@/components/ui.tsx";
import { META_MS, useCronometro } from "@/lib/cronometro.ts";
import { mensagemDeErro, useSession } from "@/lib/session.tsx";
import { EtapaAceite, EtapaConsulta, fotoSintetica } from "./FluxoTransacao.tsx";
import { EnviarErp } from "@/components/EnviarErp.tsx";
import { demoAdmin } from "@/api/demo.ts";

const ETAPAS = [
  { n: 1, label: "Aparelho", hint: "Marca, modelo e detalhes" },
  { n: 2, label: "Condições", hint: "Estado do aparelho" },
  { n: 3, label: "Oferta", hint: "Valor sugerido" },
  { n: 4, label: "Fechar negócio", hint: "Dados do vendedor e valor final" },
  { n: 5, label: "Registro", hint: "Aceite e protocolo" },
] as const;
type Etapa = 1 | 2 | 3 | 4 | 5 | 6;

interface FotosLocais { documento: File[]; frente_ligada: File | null; traseira: File | null; tela_imei: File | null; avarias: File[]; comprovante: File[] }
const fotosVazias = (): FotosLocais => ({ documento: [], frente_ligada: null, traseira: null, tela_imei: null, avarias: [], comprovante: [] });

export function Avaliacao() {
  const { sessao } = useSession();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const crono = useCronometro();
  const [config, setConfig] = useState<AvaliacaoConfig | null>(null);
  const [etapa, setEtapa] = useState<Etapa>(1);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [carregando, setCarregando] = useState(true);

  // Etapa 1
  const [brand, setBrand] = useState("Apple");
  const [outraMarca, setOutraMarca] = useState("");
  const [model, setModel] = useState("");
  const [memory, setMemory] = useState("");
  const [color, setColor] = useState("");
  const [customerName, setCustomerName] = useState("");
  // Etapa 2
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // Etapa 3
  const [avaliacao, setAvaliacao] = useState<AvaliacaoView | null>(null);
  const [tabela, setTabela] = useState<TabelaMargem>(2);
  const [ofertaManual, setOfertaManual] = useState("");
  // Etapa 4
  const [deal, setDeal] = useState({ nome: "", cpf: "", telefone: "", rg: "", endereco: "", bairro: "", imei: "", valor: "", pagamento: "", pixKey: "", pixHolder: "" });
  const [fotos, setFotos] = useState<FotosLocais>(fotosVazias());
  // Etapa 5
  const [tx, setTx] = useState<TransacaoView | null>(null);
  const idemConcluir = useRef(uuid());
  const [conclusao, setConclusao] = useState<{ protocolo: string; grade: "forte" | "assistido"; tempo: number } | null>(null);

  const marcaEfetiva = brand === "Outra" ? outraMarca.trim() : brand;
  const perguntas = useMemo(() => (config ? (marcaApple(marcaEfetiva) ? config.questionario.apple : config.questionario.android) : []), [config, marcaEfetiva]);

  const recarregarTx = useCallback(async (id: string) => { const t = await api.transacao.obter(id); setTx(t); return t; }, []);

  useEffect(() => {
    (async () => {
      try {
        const c = await api.avaliacao.config();
        setConfig(c);
        const id = params.get("id");
        if (id) {
          const a = await api.avaliacao.obter(id);
          carregarAvaliacao(a);
          if (a.closed_at && a.transaction_id) {
            const t = await recarregarTx(a.transaction_id);
            setEtapa(t.state === "completed" ? 6 : 5);
          } else {
            setTabela(a.margem_tabela);
            setEtapa(a.estimativa ? 3 : 3);
          }
        }
      } catch (e) { setErro(mensagemDeErro(e)); } finally { setCarregando(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function carregarAvaliacao(a: AvaliacaoView) {
    setAvaliacao(a);
    if (MARCAS.includes(a.brand)) setBrand(a.brand); else { setBrand("Outra"); setOutraMarca(a.brand); }
    setModel(a.model); setMemory(a.memory ?? ""); setColor(a.color ?? ""); setCustomerName(a.customer_name ?? "");
    setAnswers(a.answers);
    if (a.estimativa) setOfertaManual(String(a.estimativa.sugestao_centavos / 100));
    setDeal((d) => ({ ...d, nome: a.customer_name ?? d.nome, valor: a.final_price_centavos ? String(a.final_price_centavos / 100) : d.valor, pagamento: a.payment_method ?? d.pagamento }));
  }

  async function executar<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setErro(null); setOcupado(true);
    try { return await fn(); } catch (e) { setErro(mensagemDeErro(e)); } finally { setOcupado(false); }
  }

  // Oferta exibida: sugestão recalculada pela tabela escolhida, ou manual.
  const sugestaoCent = useMemo(() => {
    if (!avaliacao?.estimativa || !config) return parseReais(ofertaManual);
    return recalcularOferta(avaliacao.estimativa.sugestao_centavos, config.margens, avaliacao.estimativa.margem_tabela, tabela);
  }, [avaliacao, config, tabela, ofertaManual]);

  if (!sessao?.store) return <Aviso tom="alerta">Cadastre a loja antes de avaliar aparelhos.</Aviso>;
  if (carregando || !config) return <Carregando texto="Abrindo a avaliação…" />;
  const dentroDaMeta = crono.decorrido <= META_MS;
  const descricao = [marcaEfetiva, model, memory, color].filter(Boolean).join(" ");

  // ------------------------------------------------------------------ ações
  async function avancarEtapa1(e: FormEvent) {
    e.preventDefault();
    if (!marcaEfetiva || !model.trim()) { setErro("Informe a marca e o modelo do aparelho."); return; }
    setErro(null); setEtapa(2);
  }
  async function avancarEtapa2(e: FormEvent) {
    e.preventDefault();
    const faltando = perguntas.find((q) => !answers[q.key]);
    if (faltando) { setErro(`Responda a pergunta "${faltando.key}" para avaliar.`); return; }
    const a = await executar(() => api.avaliacao.estimar({ brand: marcaEfetiva, model: model.trim(), memory, color, customer_name: customerName, answers, tabela }));
    if (!a) return;
    setAvaliacao(a);
    if (a.estimativa) setOfertaManual(String(a.estimativa.sugestao_centavos / 100));
    setEtapa(3);
  }
  function irParaFechar() {
    setDeal((d) => ({ ...d, valor: sugestaoCent ? String(sugestaoCent / 100).replace(".", ",") : d.valor, nome: d.nome || customerName, pagamento: d.pagamento || config!.formas_pagamento[0] || "" }));
    setEtapa(4);
  }
  async function fecharNegocio(e: FormEvent) {
    e.preventDefault();
    if (!avaliacao) return;
    if (!deal.nome.trim()) { setErro("Informe o nome do cliente vendedor."); return; }
    if (!cpfValido(deal.cpf)) { setErro("Esse CPF não confere. Confira os dígitos."); return; }
    if (onlyDigits(deal.telefone).length < 10) { setErro("Informe o WhatsApp do vendedor com DDD — é por ele que o aceite chega."); return; }
    if (deal.imei && !imeiValido(deal.imei)) { setErro("Esse IMEI não confere. Confira os 15 dígitos — ou deixe em branco e complete depois."); return; }
    const valorCent = parseReais(deal.valor);
    if (!(valorCent > 0)) { setErro("Informe o valor final negociado."); return; }
    if (!deal.pagamento) { setErro("Informe a forma de pagamento."); return; }
    const r = await executar(async () => {
      const a = await api.avaliacao.fechar(avaliacao.id, {
        vendedor: { nome: deal.nome, cpf: deal.cpf, telefone: deal.telefone, rg: deal.rg, endereco: deal.endereco, bairro: deal.bairro },
        imei: deal.imei || undefined, final_price_centavos: valorCent, payment_method: deal.pagamento,
        pix_key: deal.pixKey || undefined, pix_key_holder: deal.pixHolder || undefined, tabela,
      });
      // Fotos entram na transação recém-criada (hash + EXIF removido no servidor).
      const txId = a.transaction_id!;
      const envios: Array<[MediaSlot, File]> = [];
      for (const f of fotos.documento) envios.push(["documento", f]);
      if (fotos.frente_ligada) envios.push(["frente_ligada", fotos.frente_ligada]);
      if (fotos.traseira) envios.push(["traseira", fotos.traseira]);
      if (fotos.tela_imei) envios.push(["tela_imei", fotos.tela_imei]);
      for (const f of fotos.avarias) envios.push(["avarias", f]);
      for (const f of fotos.comprovante) envios.push(["comprovante", f]);
      for (const [slot, f] of envios) await api.midia.enviar(txId, slot, f);
      setAvaliacao(a);
      await recarregarTx(txId);
      return a;
    });
    if (r) setEtapa(5);
  }
  async function concluir() {
    if (!tx) return;
    const r = await executar(() => api.concluir(tx.id, idemConcluir.current));
    if (r) {
      crono.parar();
      setConclusao({ protocolo: r.protocolo, grade: r.grade, tempo: crono.decorrido });
      const a = await api.avaliacao.obter(avaliacao!.id);
      setAvaliacao(a);
      await recarregarTx(tx.id);
      setEtapa(6);
    }
  }
  function novaAvaliacao() {
    crono.zerar(); setEtapa(1); setErro(null);
    setBrand("Apple"); setOutraMarca(""); setModel(""); setMemory(""); setColor(""); setCustomerName("");
    setAnswers({}); setAvaliacao(null); setTabela(2); setOfertaManual("");
    setDeal({ nome: "", cpf: "", telefone: "", rg: "", endereco: "", bairro: "", imei: "", valor: "", pagamento: "", pixKey: "", pixHolder: "" });
    setFotos(fotosVazias()); setTx(null); setConclusao(null); idemConcluir.current = uuid();
    nav("/avaliacao", { replace: true });
  }

  const fotosObrigatoriasOk = !!(fotos.frente_ligada && fotos.traseira && fotos.tela_imei);
  const seller = tx?.parties.find((p) => p.role === "seller");

  return (
    <div className="mx-auto max-w-3xl" onKeyDownCapture={crono.iniciar} onPointerDownCapture={crono.iniciar}>
      <div className="mb-4 flex items-center gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight">Avaliação de Usados</h1>
          <p className="text-xs text-slate-500">Compra no balcão · a avaliação vira o primeiro elo do aparelho</p>
        </div>
        <Link to="/compras" className="ml-auto text-sm text-teal-800 underline">Celulares comprados</Link>
        <div className={`rounded-lg px-3 py-1.5 font-mono text-2xl font-bold tabular-nums ${crono.parado ? "bg-slate-200 text-slate-700" : dentroDaMeta ? "bg-slate-900 text-white" : "bg-red-700 text-white"}`} title="Trabalho ativo do operador. Para quando o código é enviado ao vendedor.">{mmss(crono.decorrido)}</div>
      </div>

      <ol className="mb-5 grid grid-cols-5 gap-1 text-[11px] font-bold uppercase tracking-wide">
        {ETAPAS.map((s) => (
          <li key={s.n} className={`rounded px-1 py-1 text-center ${s.n === etapa ? "bg-teal-700 text-white" : s.n < etapa ? "bg-teal-100 text-teal-900" : "bg-slate-200 text-slate-500"}`}>
            {s.label}<span className="block text-[9px] font-normal normal-case tracking-normal opacity-80">{s.hint}</span>
          </li>
        ))}
      </ol>

      {erro && <div className="mb-4"><Aviso tom="bloqueio">{erro}</Aviso></div>}

      {/* 1 — Aparelho */}
      {etapa === 1 && (
        <form onSubmit={avancarEtapa1} className="cartao space-y-4">
          <h2 className="text-lg font-bold">O aparelho</h2>
          <div>
            <Rotulo obrigatorio>Marca</Rotulo>
            <div className="flex flex-wrap gap-2">
              {MARCAS.map((m) => (
                <button key={m} type="button" onClick={() => setBrand(m)} className={`rounded-full border-2 px-4 py-2 font-semibold ${brand === m ? "border-teal-700 bg-teal-700 text-white" : "border-slate-300 bg-white"}`}>{m}</button>
              ))}
            </div>
            {brand === "Outra" && <Campo className="mt-2" placeholder="Qual marca?" value={outraMarca} onChange={(e) => setOutraMarca(e.target.value)} autoFocus />}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-1">
              <Rotulo htmlFor="modelo" obrigatorio>Modelo</Rotulo>
              <Campo id="modelo" list="modelos" autoFocus={brand !== "Outra"} value={model} onChange={(e) => setModel(e.target.value)} placeholder="iPhone 13" />
              <datalist id="modelos">{(MODELOS_POR_MARCA[marcaEfetiva] ?? []).map((m) => <option key={m} value={m} />)}</datalist>
            </div>
            <div>
              <Rotulo htmlFor="memoria">Armazenamento</Rotulo>
              <select id="memoria" className="campo" value={memory} onChange={(e) => setMemory(e.target.value)}><option value="">—</option>{MEMORIAS.map((m) => <option key={m}>{m}</option>)}</select>
            </div>
            <div>
              <Rotulo htmlFor="cor">Cor</Rotulo>
              <Campo id="cor" list="cores" value={color} onChange={(e) => setColor(e.target.value)} />
              <datalist id="cores">{CORES.map((c) => <option key={c} value={c} />)}</datalist>
            </div>
          </div>
          <div>
            <Rotulo htmlFor="cliente">Nome do cliente (opcional, só referência)</Rotulo>
            <Campo id="cliente" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
          </div>
          <Botao type="submit" grande>Continuar</Botao>
        </form>
      )}

      {/* 2 — Condições (checklist) */}
      {etapa === 2 && (
        <form onSubmit={avancarEtapa2} className="cartao space-y-5">
          <div>
            <h2 className="text-lg font-bold">Condições — {descricao}</h2>
            <p className="text-sm text-slate-600">Questionário {marcaApple(marcaEfetiva) ? "Apple" : "Android"} da loja. O que o vendedor responde entra no registro como <Selo tipo="declarado" />.</p>
          </div>
          {perguntas.map((q) => (
            <fieldset key={q.key}>
              <legend className="mb-1.5 text-sm font-semibold text-slate-800">{q.label}</legend>
              <div className="flex flex-wrap gap-2">
                {q.options.map((o) => {
                  const sel = answers[q.key] === o.label;
                  return (
                    <button key={o.label} type="button" onClick={() => setAnswers({ ...answers, [q.key]: o.label })}
                      className={`rounded-full border-2 px-3 py-1.5 text-sm font-semibold ${sel ? (o.blocks ? "border-red-700 bg-red-700 text-white" : "border-teal-700 bg-teal-700 text-white") : "border-slate-300 bg-white"}`}>
                      {o.label}{o.blocks && <span className="ml-1 text-[10px] opacity-80">bloqueia</span>}{!o.blocks && o.deductionPercent ? <span className="ml-1 text-[10px] opacity-80">−{o.deductionPercent}%</span> : null}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ))}
          {perguntas.some((q) => q.options.find((o) => o.label === answers[q.key])?.blocks) && (
            <Aviso tom="bloqueio" titulo="Não avaliamos aparelho com parte sem funcionar">Uma das respostas bloqueia a avaliação nesta loja. Ajuste o questionário em Configurações se a regra mudou.</Aviso>
          )}
          <div className="flex gap-3">
            <Botao type="button" variante="secundario" onClick={() => setEtapa(1)}>Voltar</Botao>
            <Botao type="submit" className="flex-1" disabled={ocupado}>{ocupado ? "Calculando…" : "Ver oferta"}</Botao>
          </div>
        </form>
      )}

      {/* 3 — Oferta */}
      {etapa === 3 && avaliacao && (
        <div className="cartao space-y-4">
          <h2 className="text-lg font-bold">{avaliacao.device}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border-2 border-slate-200 p-4">
              <p className="text-xs font-bold uppercase text-slate-500">Preço de revenda (referência)</p>
              <p className="text-xl font-bold">{avaliacao.estimativa?.valor_base_centavos ? formatarCentavos(avaliacao.estimativa.valor_base_centavos) : avaliacao.estimativa?.faixa_mercado ?? "Sem referência na tabela da loja"}</p>
            </div>
            <div className="rounded-lg bg-teal-700 p-4 text-white">
              <p className="text-xs font-bold uppercase opacity-80">Sugestão de valor de compra</p>
              {avaliacao.estimativa ? (
                <p className="text-3xl font-black">{formatarCentavos(sugestaoCent)}</p>
              ) : (
                <div className="flex items-center gap-2"><span>R$</span><input className="w-40 rounded px-2 py-1 text-xl font-black text-slate-900" inputMode="decimal" value={ofertaManual} onChange={(e) => setOfertaManual(e.target.value)} placeholder="0,00" /></div>
              )}
              <p className="text-xs opacity-80">{avaliacao.estimativa ? `Recalculado para a Tabela ${tabela}` : "Informe a oferta manualmente — cadastre este modelo em Configurações → Valores base para calcular sozinho."}</p>
            </div>
          </div>
          <div>
            <p className="mb-1 text-xs font-bold uppercase text-slate-500">Tabela de margem</p>
            <div className="grid grid-cols-3 gap-2">
              {TABELAS_MARGEM.map((t) => (
                <button key={t.table} type="button" onClick={() => setTabela(t.table)} className={`rounded-full border-2 px-3 py-2 text-sm font-bold ${tabela === t.table ? "border-teal-700 bg-teal-700 text-white" : "border-slate-300 bg-white"}`}>Tabela {t.table} · {margemDaTabela(config.margens, t.table)}%</button>
              ))}
            </div>
          </div>
          {avaliacao.estimativa && <p className="text-sm text-slate-700">{avaliacao.estimativa.justificativa}</p>}
          <p className="text-xs text-slate-500">⚠ Sugestão calculada pela tabela da loja e pelo estado declarado — confirme antes de fechar a compra.</p>
          <div className="flex flex-wrap gap-3">
            <Botao onClick={irParaFechar} disabled={!(sugestaoCent > 0)}>Fechar negócio</Botao>
            <Botao variante="secundario" onClick={() => setEtapa(2)}>Ajustar condições</Botao>
            <button type="button" className="text-sm underline" onClick={novaAvaliacao}>Fazer nova avaliação</button>
          </div>
        </div>
      )}

      {/* 4 — Fechar negócio */}
      {etapa === 4 && avaliacao && (
        <form onSubmit={fecharNegocio} className="cartao space-y-4">
          <h2 className="text-lg font-bold">Fechar negócio — {avaliacao.device}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Rotulo htmlFor="dnome" obrigatorio>Nome do cliente vendedor</Rotulo><Campo id="dnome" autoFocus value={deal.nome} onChange={(e) => setDeal({ ...deal, nome: e.target.value })} /></div>
            <div><Rotulo htmlFor="dcpf" obrigatorio>CPF</Rotulo><Campo id="dcpf" inputMode="numeric" placeholder="000.000.000-00" value={deal.cpf} onChange={(e) => setDeal({ ...deal, cpf: e.target.value })} /></div>
            <div><Rotulo htmlFor="dtel" obrigatorio>WhatsApp com DDD</Rotulo><Campo id="dtel" inputMode="tel" placeholder="(33) 99999-9999" value={deal.telefone} onChange={(e) => setDeal({ ...deal, telefone: e.target.value })} /><p className="mt-1 text-xs text-slate-500">É por ele que o código de aceite chega. Nunca aparece nesta tela.</p></div>
            <div><Rotulo htmlFor="drg">RG</Rotulo><Campo id="drg" placeholder="Opcional" value={deal.rg} onChange={(e) => setDeal({ ...deal, rg: e.target.value })} /></div>
            <div><Rotulo htmlFor="dend">Endereço</Rotulo><Campo id="dend" placeholder="Opcional" value={deal.endereco} onChange={(e) => setDeal({ ...deal, endereco: e.target.value })} /></div>
            <div><Rotulo htmlFor="dbai">Bairro</Rotulo><Campo id="dbai" placeholder="Opcional" value={deal.bairro} onChange={(e) => setDeal({ ...deal, bairro: e.target.value })} /></div>
            <div>
              <Rotulo htmlFor="dimei">IMEI do aparelho</Rotulo>
              <Campo id="dimei" inputMode="numeric" className="font-mono" placeholder="Opcional — dá pra preencher depois" value={deal.imei} onChange={(e) => setDeal({ ...deal, imei: e.target.value })} maxLength={17} />
              <p className="mt-1 text-xs text-slate-500">Sem IMEI a compra fica registrada, mas o elo do Cartório só nasce quando você completar em "Celulares comprados".{MODO_DEMO && <> <button type="button" className="underline" onClick={() => setDeal({ ...deal, imei: demoAdmin.imeiExemplo("clear") })}>gerar IMEI de teste</button></>}</p>
            </div>
            <div><Rotulo htmlFor="dvalor" obrigatorio>Valor final negociado (R$)</Rotulo><Campo id="dvalor" inputMode="decimal" value={deal.valor} onChange={(e) => setDeal({ ...deal, valor: e.target.value })} /></div>
            <div>
              <Rotulo htmlFor="dpag" obrigatorio>Forma de pagamento</Rotulo>
              <select id="dpag" className="campo" value={deal.pagamento} onChange={(e) => setDeal({ ...deal, pagamento: e.target.value })}><option value="">Selecione</option>{config.formas_pagamento.map((f) => <option key={f}>{f}</option>)}</select>
            </div>
            {/pix/i.test(deal.pagamento) && (
              <>
                <div><Rotulo htmlFor="dpix">Chave Pix</Rotulo><Campo id="dpix" value={deal.pixKey} onChange={(e) => setDeal({ ...deal, pixKey: e.target.value })} /></div>
                <div><Rotulo htmlFor="dpixh">Titular da chave Pix</Rotulo><Campo id="dpixh" placeholder="Se for de outra pessoa" value={deal.pixHolder} onChange={(e) => setDeal({ ...deal, pixHolder: e.target.value })} /></div>
              </>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <SeletorFotos rotulo="Fotos do documento" multiplas arquivos={fotos.documento} onChange={(fs) => setFotos({ ...fotos, documento: fs })} />
            <div>
              <p className="mb-1 text-xs font-bold uppercase text-slate-500">Fotos do aparelho *</p>
              <div className="grid grid-cols-3 gap-1">
                {(["frente_ligada", "traseira", "tela_imei"] as const).map((slot) => (
                  <label key={slot} className={`flex aspect-square cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed text-center text-[10px] font-semibold ${fotos[slot] ? "border-teal-600 bg-teal-50" : "border-slate-300 bg-slate-50"}`}>
                    {fotos[slot] ? "✔" : "📷"}<span>{{ frente_ligada: "Frente ligada", traseira: "Traseira", tela_imei: "Tela IMEI" }[slot]}</span>
                    <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) setFotos({ ...fotos, [slot]: f }); e.target.value = ""; }} />
                  </label>
                ))}
              </div>
              {MODO_DEMO && <button type="button" className="mt-1 text-[11px] underline text-slate-600" onClick={() => setFotos({ ...fotos, frente_ligada: fotoSintetica("frente_ligada"), traseira: fotoSintetica("traseira"), tela_imei: fotoSintetica("tela_imei") })}>fotos sintéticas</button>}
            </div>
            <SeletorFotos rotulo="Comprovante de pagamento" multiplas arquivos={fotos.comprovante} onChange={(fs) => setFotos({ ...fotos, comprovante: fs })} />
          </div>
          {!fotosObrigatoriasOk && <p className="text-xs text-amber-800">As três fotos do aparelho são obrigatórias para concluir o registro no Cartório. Você pode fechar sem elas e completar depois.</p>}
          <div className="flex gap-3">
            <Botao type="button" variante="secundario" onClick={() => setEtapa(3)}>Voltar</Botao>
            <Botao type="submit" className="flex-1" disabled={ocupado}>{ocupado ? "Fechando…" : "Confirmar fechamento"}</Botao>
          </div>
        </form>
      )}

      {/* 5 — Registro no Cartório */}
      {etapa === 5 && avaliacao && tx && (
        <div className="space-y-4">
          <Aviso tom="ok" titulo="Negócio fechado — compra registrada">
            {avaliacao.device} · {formatarCentavos(avaliacao.final_price_centavos ?? 0)} · {avaliacao.payment_method}. <Link className="underline font-semibold" to={`/compras/${avaliacao.id}/nota`} target="_blank">Imprimir nota de compra</Link>
          </Aviso>
          {avaliacao.imei_pendente ? (
            <CompletarImei avaliacao={avaliacao} onFeito={async (a) => { setAvaliacao(a); await recarregarTx(a.transaction_id!); }} />
          ) : (
            <>
              <EtapaConsulta tx={tx} ocupado={ocupado} onConsultar={async () => { await executar(async () => { await api.consulta.executar(tx.id); await recarregarTx(tx.id); }); }} onSeguir={() => {}} ocultarContinuar />
              {["awaiting_seller", "awaiting_buyer", "ready_to_complete"].includes(tx.state) && seller && (
                <EtapaAceite tx={tx} pessoa={{ party_id: seller.party_id, display_name: seller.display_name, kind: seller.kind, telefone_mascarado: seller.telefone_mascarado }} papelPessoa="seller" ocupado={ocupado}
                  onVoltar={() => setEtapa(4)} recarregar={() => recarregarTx(tx.id)} onConviteEnviado={() => crono.parar()} executar={executar} onConcluir={concluir} />
              )}
              {!REQUIRED_MEDIA_SLOTS.every((s) => tx.media.some((m) => m.slot === s)) && (
                <FotosFaltantes tx={tx} onEnviar={async (slot, f) => { await executar(async () => { await api.midia.enviar(tx.id, slot, f); await recarregarTx(tx.id); }); }} />
              )}
            </>
          )}
        </div>
      )}

      {/* 6 — Concluído */}
      {etapa === 6 && avaliacao && tx && (
        <div className="cartao text-center space-y-4">
          <p className="text-sm font-bold uppercase tracking-wide text-teal-800">Compra registrada no Cartório</p>
          <p className="font-mono text-5xl font-black tracking-[0.2em]">{tx.public_protocol}</p>
          <div className="flex justify-center"><Selo tipo={(conclusao?.grade ?? tx.aceite.grade) === "assistido" ? "assistido" : "forte"} /></div>
          {conclusao && <p className={`text-lg font-semibold ${conclusao.tempo <= META_MS ? "text-teal-800" : "text-red-700"}`}>Trabalho ativo do operador: {mmss(conclusao.tempo)} {conclusao.tempo <= META_MS ? "— dentro da meta de 1:30" : "— acima da meta de 1:30"}</p>}
          <div className="flex flex-wrap justify-center gap-3">
            <Link to={`/compras/${avaliacao.id}/nota`}><Botao variante="secundario">Nota de compra</Botao></Link>
            <Link to={`/certificado/${tx.public_protocol}`}><Botao variante="secundario">Certificado</Botao></Link>
            <EnviarErp transaction_id={tx.id} />
            <Botao onClick={novaAvaliacao}>Nova avaliação</Botao>
          </div>
        </div>
      )}
    </div>
  );
}

function SeletorFotos({ rotulo, multiplas, arquivos, onChange }: { rotulo: string; multiplas?: boolean; arquivos: File[]; onChange: (f: File[]) => void }) {
  return (
    <div>
      <p className="mb-1 text-xs font-bold uppercase text-slate-500">{rotulo}</p>
      <div className="flex flex-wrap gap-1">
        {arquivos.map((f, i) => (
          <span key={i} className="flex h-12 w-12 items-center justify-center rounded border border-teal-600 bg-teal-50 text-xs" title={f.name}>
            <button type="button" onClick={() => onChange(arquivos.filter((_, j) => j !== i))} aria-label="Remover">✕</button>
          </span>
        ))}
        <label className="flex h-12 w-12 cursor-pointer items-center justify-center rounded border-2 border-dashed border-slate-300 bg-slate-50 text-xl">
          +<input type="file" accept="image/*" capture="environment" multiple={multiplas} className="sr-only" onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) onChange([...arquivos, ...fs].slice(0, 8)); e.target.value = ""; }} />
        </label>
      </div>
    </div>
  );
}

export function CompletarImei({ avaliacao, onFeito }: { avaliacao: AvaliacaoView; onFeito: (a: AvaliacaoView) => Promise<void> | void }) {
  const [imei, setImei] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  async function enviar(e: FormEvent) {
    e.preventDefault(); setErro(null); setOcupado(true);
    try { const a = await api.avaliacao.completarImei(avaliacao.id, imei); await onFeito(a); } catch (err) { setErro(mensagemDeErro(err)); } finally { setOcupado(false); }
  }
  return (
    <form onSubmit={enviar} className="cartao space-y-3">
      <h2 className="text-lg font-bold">IMEI pendente</h2>
      <p className="text-sm text-slate-600">A compra está registrada, mas o elo do Cartório só nasce com o IMEI. Disque *#06# no aparelho ou leia na bandeja do chip.</p>
      <div className="flex gap-2">
        <Campo inputMode="numeric" className="font-mono" placeholder="15 dígitos" value={imei} onChange={(e) => setImei(e.target.value)} maxLength={17} />
        <Botao type="submit" disabled={ocupado || onlyDigits(imei).length !== 15}>Completar IMEI</Botao>
      </div>
      {MODO_DEMO && <button type="button" className="text-xs underline text-slate-600" onClick={() => setImei(demoAdmin.imeiExemplo("clear"))}>gerar IMEI de teste</button>}
      <Erro>{erro}</Erro>
    </form>
  );
}

function FotosFaltantes({ tx, onEnviar }: { tx: TransacaoView; onEnviar: (slot: MediaSlot, f: File) => Promise<void> }) {
  const faltam = REQUIRED_MEDIA_SLOTS.filter((s) => !tx.media.some((m: MediaView) => m.slot === s));
  return (
    <div className="cartao space-y-2">
      <p className="font-bold">Faltam fotos obrigatórias do aparelho</p>
      <div className="flex flex-wrap gap-2">
        {faltam.map((slot) => (
          <label key={slot} className="cursor-pointer rounded-lg border-2 border-dashed border-slate-400 px-3 py-2 text-sm font-semibold">
            📷 {{ frente_ligada: "Frente ligada", traseira: "Traseira", tela_imei: "Tela com IMEI" }[slot as "frente_ligada" | "traseira" | "tela_imei"]}
            <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) onEnviar(slot, f); e.target.value = ""; }} />
          </label>
        ))}
        {MODO_DEMO && <button type="button" className="text-xs underline text-slate-600" onClick={async () => { for (const s of faltam) await onEnviar(s, fotoSintetica(s)); }}>fotos sintéticas</button>}
      </div>
    </div>
  );
}
