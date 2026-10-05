// Portal da pessoa física — "Meus aparelhos". Adaptado da Carteira Digital
// de Trânsito: o dono vê seus aparelhos, vende (o comprador aceita primeiro,
// o vendedor confirma por último), comunica uma venda já feita e registra
// ocorrência de furto/roubo/perda. Sessão própria: CPF + código no WhatsApp
// já cadastrado. Nada de loja aqui.

import { createContext, useCallback, useContext, useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, Outlet, useNavigate, useParams } from "react-router-dom";
import { api, MODO_DEMO, type MeuAparelho, type PfSession, type TransacaoView } from "@/api/index.ts";
import { REQUIRED_MEDIA_SLOTS, descreverConsulta, formatarCentavos, onlyDigits, parseReais, rotuloEstado, type MediaSlot } from "@core/index.ts";
import { Aviso, Botao, Campo, Carregando, Erro, Rotulo, Selo, formatarData } from "@/components/ui.tsx";
import { mensagemDeErro } from "@/lib/session.tsx";
import { fotoSintetica } from "./FluxoTransacao.tsx";

// ---------------------------------------------------------------------------
// Sessão PF
// ---------------------------------------------------------------------------
const PfCtx = createContext<{ pf: PfSession | null; carregando: boolean; recarregar: () => Promise<void> }>({ pf: null, carregando: true, recarregar: async () => {} });
const usePf = () => useContext(PfCtx);

export function PortalPf() {
  const [pf, setPf] = useState<PfSession | null>(null);
  const [carregando, setCarregando] = useState(true);
  const nav = useNavigate();
  const recarregar = useCallback(async () => { setPf(await api.pf.sessao()); }, []);
  useEffect(() => { recarregar().finally(() => setCarregando(false)); }, [recarregar]);
  return (
    <PfCtx.Provider value={{ pf, carregando, recarregar }}>
      <div className="min-h-screen flex flex-col bg-slate-100">
        <header className="bg-teal-900 text-white">
          <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
            <Link to="/pf" className="font-black tracking-tight">Cartório do Celular · <span className="font-semibold">Meus aparelhos</span></Link>
            <div className="ml-auto flex items-center gap-3 text-sm">
              {pf && <span className="hidden sm:inline">{pf.primeiro_nome}</span>}
              {pf && <button className="rounded-md border border-teal-600 px-2 py-1 text-xs hover:bg-white/10" onClick={() => api.pf.sair().then(() => { setPf(null); nav("/pf/entrar"); })}>Sair</button>}
              {MODO_DEMO && <Link to="/demo/celular" target="_blank" className="text-xs underline">📱 WhatsApp</Link>}
            </div>
          </div>
        </header>
        {MODO_DEMO && <div className="bg-amber-200 text-amber-950 text-center text-xs font-semibold py-1 px-3">MODO DEMONSTRAÇÃO — dados sintéticos. Nenhum CPF real deve entrar aqui.</div>}
        <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6"><Outlet /></main>
        <footer className="px-4 py-4 text-center text-xs text-slate-500">O Cartório registra passagens declaradas e verificadas na data indicada. Não é órgão público e não substitui boletim de ocorrência, nota fiscal ou vistoria técnica.</footer>
      </div>
    </PfCtx.Provider>
  );
}

export function PfProtegida() {
  const { pf, carregando } = usePf();
  if (carregando) return <Carregando />;
  if (!pf) return <Navigate to="/pf/entrar" replace />;
  return <Outlet />;
}

// ---------------------------------------------------------------------------
// Entrar
// ---------------------------------------------------------------------------
export function PfEntrar() {
  const { pf, recarregar } = usePf();
  const nav = useNavigate();
  const [f, setF] = useState({ cpf: "", telefone: "", nome: "" });
  const [fase, setFase] = useState<"dados" | "codigo">("dados");
  const [destino, setDestino] = useState("");
  const [novo, setNovo] = useState(false);
  const [codigo, setCodigo] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  if (pf) return <Navigate to="/pf" replace />;

  async function pedir(e: FormEvent) {
    e.preventDefault(); setErro(null); setOcupado(true);
    try { const r = await api.pf.pedirCodigo({ cpf: f.cpf, telefone: f.telefone, nome: f.nome || undefined }); setDestino(r.destino_mascarado); setNovo(r.novo_cadastro); setFase("codigo"); }
    catch (err) { const m = mensagemDeErro(err); setErro(m); if (/nome/i.test(m)) setNovo(true); }
    finally { setOcupado(false); }
  }
  async function confirmar(e: FormEvent) {
    e.preventDefault(); setErro(null); setOcupado(true);
    try { await api.pf.confirmar(codigo); await recarregar(); nav("/pf"); } catch (err) { setErro(mensagemDeErro(err)); } finally { setOcupado(false); }
  }
  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-3xl font-black tracking-tight mb-1">Meus aparelhos</h1>
      <p className="text-slate-600 mb-5">Veja os aparelhos registrados no seu nome, venda com segurança, comunique uma venda ou registre uma ocorrência.</p>
      {fase === "dados" ? (
        <form onSubmit={pedir} className="cartao space-y-4">
          <div><Rotulo htmlFor="pcpf" obrigatorio>CPF</Rotulo><Campo id="pcpf" autoFocus inputMode="numeric" placeholder="000.000.000-00" value={f.cpf} onChange={(e) => setF({ ...f, cpf: e.target.value })} /></div>
          <div><Rotulo htmlFor="ptel" obrigatorio>WhatsApp com DDD</Rotulo><Campo id="ptel" inputMode="tel" placeholder="(33) 99999-9999" value={f.telefone} onChange={(e) => setF({ ...f, telefone: e.target.value })} /><p className="mt-1 text-xs text-slate-500">Precisa ser o número cadastrado para o seu CPF. O código chega nele.</p></div>
          {novo && <div><Rotulo htmlFor="pnome" obrigatorio>Nome completo (primeiro acesso)</Rotulo><Campo id="pnome" value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} /></div>}
          <Erro>{erro}</Erro>
          <Botao type="submit" grande disabled={ocupado}>{ocupado ? "Enviando…" : "Receber código no WhatsApp"}</Botao>
          <p className="text-center text-xs"><Link className="underline" to="/entrar">Sou loja</Link> · <Link className="underline" to="/passaporte">Consultar um IMEI</Link></p>
        </form>
      ) : (
        <form onSubmit={confirmar} className="cartao space-y-4">
          <p className="font-semibold">Código enviado para {destino}.{novo ? " Primeiro acesso: seu cadastro será criado ao confirmar." : ""}</p>
          <Campo inputMode="numeric" autoFocus autoComplete="one-time-code" maxLength={6} className="text-center font-mono text-3xl tracking-[0.5em]" value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ""))} />
          <Erro>{erro}</Erro>
          <Botao type="submit" grande disabled={ocupado || codigo.length !== 6}>Entrar</Botao>
          <button type="button" className="w-full text-sm underline text-slate-600" onClick={() => setFase("dados")}>Voltar</button>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Meus aparelhos
// ---------------------------------------------------------------------------
export function PfMeusAparelhos() {
  const { pf } = usePf();
  const [lista, setLista] = useState<MeuAparelho[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  useEffect(() => { api.pf.meusAparelhos().then(setLista).catch((e) => setErro(mensagemDeErro(e))); }, []);
  if (!lista) return <Carregando />;
  return (
    <div className="space-y-4">
      <div><h1 className="text-2xl font-black tracking-tight">Olá, {pf?.primeiro_nome}.</h1><p className="text-slate-600">Aparelhos registrados no seu nome no Cartório.</p></div>
      {erro && <Aviso tom="bloqueio">{erro}</Aviso>}
      {lista.length === 0 && <Aviso tom="neutro" titulo="Nenhum aparelho no seu nome">Quando uma loja registrar uma compra ou venda com você, ou alguém transferir um aparelho para você, ele aparece aqui.</Aviso>}
      {lista.map((a) => (
        <div key={a.device.device_id} className="cartao space-y-3">
          <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
            <div className="min-w-0 flex-1">
              <p className="text-lg font-bold">{[a.device.brand, a.device.model, a.device.storage, a.device.color].filter(Boolean).join(" ") || "Aparelho"}</p>
              <p className="font-mono text-sm">IMEI {a.device.imei_mascarado}</p>
              <p className="text-xs text-slate-500">Titular desde {formatarData(a.desde)}{a.protocolo_entrada ? ` · protocolo ${a.protocolo_entrada}` : ""}</p>
            </div>
            {a.link_certificado && <a className="text-sm text-teal-800 underline" href={a.link_certificado} target="_blank" rel="noreferrer">Certificado</a>}
          </div>
          {a.garantia && (
            <p data-testid="garantia" className={`text-sm ${a.garantia.situacao === "vence_em_breve" ? "font-semibold text-amber-900" : "text-slate-600"}`}>
              {a.garantia.situacao === "vencida" ? `Garantia (${a.garantia.texto}) terminou em ${formatarData(a.garantia.ate)}.`
                : a.garantia.situacao === "vence_em_breve" ? `Garantia termina em ${a.garantia.dias_restantes} dia(s), em ${formatarData(a.garantia.ate)}. Se algo não está bem, procure a loja antes.`
                : `Garantia (${a.garantia.texto}) até ${formatarData(a.garantia.ate)}.`}
            </p>
          )}
          {a.ocorrencia_ativa && <Aviso tom="alerta" titulo={`Declaração de ${a.ocorrencia_ativa.tipo} ativa`}>Registrada em {formatarData(a.ocorrencia_ativa.declarada_em)}{a.ocorrencia_ativa.bo_numero ? ` · B.O. ${a.ocorrencia_ativa.bo_numero}` : ""}. Aparece no passaporte público e impede qualquer transferência até você retirá-la.</Aviso>}
          {a.intencao && (
            <Aviso tom="info" titulo={a.intencao.declarada ? "Venda comunicada — aguardando o comprador confirmar" : `Venda em andamento para ${a.intencao.comprador}`}>
              {a.intencao.comprador_aceitou ? "O comprador já aceitou." : "O comprador ainda não aceitou no celular dele."} Se ninguém mexer, esta venda expira em {formatarData(a.intencao.expira_em)}. <Link className="underline font-semibold" to={`/pf/venda/${a.intencao.transaction_id}`}>Ver venda</Link>
            </Aviso>
          )}
          <div className="flex flex-wrap gap-2">
            {!a.intencao && !a.ocorrencia_ativa && <Link to={`/pf/vender/${a.device.device_id}`}><Botao>Vender</Botao></Link>}
            {!a.intencao && !a.ocorrencia_ativa && <Link to={`/pf/comunicar/${a.device.device_id}`}><Botao variante="secundario">Já vendi — comunicar venda</Botao></Link>}
            <Link to={`/pf/ocorrencia/${a.device.device_id}`}><Botao variante={a.ocorrencia_ativa ? "secundario" : "perigo"}>{a.ocorrencia_ativa ? "Retirar declaração" : "Registrar furto / roubo / perda"}</Botao></Link>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vender (PF→PF)
// ---------------------------------------------------------------------------
export function PfVender() {
  const { deviceId = "" } = useParams();
  const nav = useNavigate();
  const [f, setF] = useState({ cpf: "", nome: "", telefone: "", valor: "", forma: "Pix", estado: "Bom", defeitos: "" });
  const [fotos, setFotos] = useState<Record<"frente_ligada" | "traseira" | "tela_imei", File | null>>({ frente_ligada: null, traseira: null, tela_imei: null });
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  async function enviar(e: FormEvent) {
    e.preventDefault(); setErro(null); setOcupado(true);
    try {
      const t = await api.pf.iniciarVenda({ device_id: deviceId, comprador: { cpf: f.cpf, nome: f.nome, telefone: f.telefone }, valor_centavos: parseReais(f.valor), forma_pagamento: f.forma, estado_aparelho: f.estado, defeitos: f.defeitos });
      for (const slot of ["frente_ligada", "traseira", "tela_imei"] as const) if (fotos[slot]) await api.pf.enviarFoto(t.id, slot, fotos[slot]!);
      nav(`/pf/venda/${t.id}`);
    } catch (err) { setErro(mensagemDeErro(err)); } finally { setOcupado(false); }
  }
  return (
    <form onSubmit={enviar} className="cartao space-y-4">
      <div><h1 className="text-2xl font-black tracking-tight">Vender este aparelho</h1><p className="text-sm text-slate-600">Como na venda digital de veículo: você informa o comprador, ele aceita no celular dele, e você confirma por último. Sem loja no meio — é a prova mais forte do Cartório.</p></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><Rotulo htmlFor="vcpf" obrigatorio>CPF do comprador</Rotulo><Campo id="vcpf" autoFocus inputMode="numeric" placeholder="000.000.000-00" value={f.cpf} onChange={(e) => setF({ ...f, cpf: e.target.value })} /></div>
        <div><Rotulo htmlFor="vnome" obrigatorio>Nome do comprador</Rotulo><Campo id="vnome" value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} /></div>
        <div><Rotulo htmlFor="vtel" obrigatorio>WhatsApp do comprador</Rotulo><Campo id="vtel" inputMode="tel" value={f.telefone} onChange={(e) => setF({ ...f, telefone: e.target.value })} /></div>
        <div><Rotulo htmlFor="vvalor" obrigatorio>Valor (R$)</Rotulo><Campo id="vvalor" inputMode="decimal" value={f.valor} onChange={(e) => setF({ ...f, valor: e.target.value })} /></div>
        <div><Rotulo htmlFor="vforma">Forma de pagamento</Rotulo><select id="vforma" className="campo" value={f.forma} onChange={(e) => setF({ ...f, forma: e.target.value })}><option>Pix</option><option>Dinheiro</option><option>Transferência</option><option>Troca</option><option>Outro</option></select></div>
        <div><Rotulo htmlFor="vestado">Estado do aparelho (declarado)</Rotulo><select id="vestado" className="campo" value={f.estado} onChange={(e) => setF({ ...f, estado: e.target.value })}><option>Excelente</option><option>Bom</option><option>Regular</option><option>Com defeito</option></select></div>
        <div className="sm:col-span-2"><Rotulo htmlFor="vdef">Defeitos declarados</Rotulo><Campo id="vdef" placeholder="Nenhum" value={f.defeitos} onChange={(e) => setF({ ...f, defeitos: e.target.value })} /></div>
      </div>
      <div>
        <p className="mb-1 text-xs font-bold uppercase text-slate-500">Fotos do aparelho (3 obrigatórias)</p>
        <div className="grid grid-cols-3 gap-2">
          {(["frente_ligada", "traseira", "tela_imei"] as const).map((slot) => (
            <label key={slot} className={`flex aspect-square cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed text-center text-xs font-semibold ${fotos[slot] ? "border-teal-600 bg-teal-50" : "border-slate-300 bg-slate-50"}`}>
              {fotos[slot] ? "✔" : "📷"}<span>{{ frente_ligada: "Frente ligada", traseira: "Traseira", tela_imei: "Tela com IMEI" }[slot]}</span>
              <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => { const x = e.target.files?.[0]; if (x) setFotos({ ...fotos, [slot]: x }); e.target.value = ""; }} />
            </label>
          ))}
        </div>
        {MODO_DEMO && <button type="button" className="mt-1 text-xs underline text-slate-600" onClick={() => setFotos({ frente_ligada: fotoSintetica("frente_ligada"), traseira: fotoSintetica("traseira"), tela_imei: fotoSintetica("tela_imei") })}>fotos sintéticas</button>}
      </div>
      <Erro>{erro}</Erro>
      <div className="flex gap-3"><Link to="/pf"><Botao type="button" variante="secundario">Voltar</Botao></Link><Botao type="submit" className="flex-1" disabled={ocupado}>{ocupado ? "Enviando…" : "Enviar para o comprador aceitar"}</Botao></div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Acompanhar a venda / confirmar
// ---------------------------------------------------------------------------
export function PfVenda() {
  const { txId = "" } = useParams();
  const nav = useNavigate();
  const [tx, setTx] = useState<TransacaoView | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const recarregar = useCallback(() => api.pf.transacao(txId).then(setTx).catch((e) => setErro(mensagemDeErro(e))), [txId]);
  useEffect(() => { recarregar(); }, [recarregar]);
  useEffect(() => { if (!tx || tx.state === "completed") return; const id = setInterval(recarregar, 3000); return () => clearInterval(id); }, [tx, recarregar]);
  if (!tx) return erro ? <Aviso tom="bloqueio">{erro}</Aviso> : <Carregando />;
  const buyer = tx.parties.find((p) => p.role === "buyer")!;
  const compradorOk = tx.aceite.accepted.some((p) => p.role === "buyer");
  const vendedorOk = tx.aceite.accepted.some((p) => p.role === "seller");
  const declarada = tx.terms?.payload.declaracoes?.origem === "comunicacao_de_venda";
  const fotosOk = declarada || REQUIRED_MEDIA_SLOTS.every((s) => tx.media.some((m) => m.slot === s));
  const consulta = descreverConsulta(tx.check);
  const podeConfirmar = compradorOk && !vendedorOk && fotosOk && consulta.tom === "ok" && !tx.ocorrencia_ativa;
  async function acao(fn: () => Promise<unknown>, ok?: string) {
    setErro(null); setMsg(null); setOcupado(true);
    try { await fn(); if (ok) setMsg(ok); await recarregar(); } catch (e) { setErro(mensagemDeErro(e)); } finally { setOcupado(false); }
  }
  return (
    <div className="space-y-4">
      <div><h1 className="text-2xl font-black tracking-tight">{declarada ? "Venda comunicada" : "Venda em andamento"}</h1><p className="text-sm text-slate-600">{tx.device ? [tx.device.brand, tx.device.model, tx.device.storage].filter(Boolean).join(" ") : ""} · IMEI {tx.device?.imei_mascarado} · para {buyer.display_name}</p></div>
      {erro && <Aviso tom="bloqueio">{erro}</Aviso>}
      {msg && <Aviso tom="ok">{msg}</Aviso>}
      {tx.state === "completed" ? (
        <div className="cartao text-center space-y-3">
          <p className="text-sm font-bold uppercase tracking-wide text-teal-800">Transferência concluída</p>
          <p className="font-mono text-4xl font-black tracking-[0.2em]">{tx.public_protocol}</p>
          <Selo tipo={tx.aceite.grade === "assistido" ? "assistido" : "forte"} />
          <p className="text-sm text-slate-600">O aparelho passou para o nome de {buyer.display_name}. Você deixa de ser o titular registrado a partir de {formatarData(tx.completed_at)}.</p>
          <div className="flex justify-center gap-3"><Link to={`/certificado/${tx.public_protocol}`}><Botao variante="secundario">Certificado</Botao></Link><Link to="/pf"><Botao>Meus aparelhos</Botao></Link></div>
        </div>
      ) : (
        <div className="cartao space-y-4">
          {tx.ocorrencia_ativa && <Aviso tom="bloqueio" titulo="Declaração de ocorrência ativa">Retire a declaração antes de concluir.</Aviso>}
          <ol className="space-y-2 text-sm">
            <li className="flex items-center gap-2"><span className={`h-3 w-3 rounded-full ${consulta.tom === "ok" ? "bg-teal-600" : consulta.tom === "bloqueio" ? "bg-red-600" : "bg-amber-500"}`} /><span><strong>Consulta de procedência:</strong> {consulta.titulo}. <span className="text-slate-500">{consulta.detalhe}</span></span></li>
            {!declarada && <li className="flex items-center gap-2"><span className={`h-3 w-3 rounded-full ${fotosOk ? "bg-teal-600" : "bg-slate-300"}`} /><span><strong>Fotos:</strong> {fotosOk ? "as três obrigatórias enviadas" : "faltam fotos"}</span></li>}
            <li className="flex items-center gap-2"><span className={`h-3 w-3 rounded-full ${compradorOk ? "bg-teal-600" : "bg-slate-300"}`} /><span><strong>Aceite do comprador</strong> ({buyer.telefone_mascarado}): {compradorOk ? "aceitou pelo celular dele" : "aguardando"}</span></li>
            <li className="flex items-center gap-2"><span className={`h-3 w-3 rounded-full ${vendedorOk ? "bg-teal-600" : "bg-slate-300"}`} /><span><strong>Sua confirmação:</strong> {vendedorOk ? "confirmada" : declarada ? "você já declarou a venda — conclui sozinha quando o comprador aceitar" : "você confirma por último, depois do aceite do comprador"}</span></li>
          </ol>
          {!fotosOk && !declarada && (
            <div className="flex flex-wrap gap-2">
              {REQUIRED_MEDIA_SLOTS.filter((s) => !tx.media.some((m) => m.slot === s)).map((slot) => (
                <label key={slot} className="cursor-pointer rounded-lg border-2 border-dashed border-slate-400 px-3 py-2 text-sm font-semibold">📷 {slot.replace("_", " ")}<input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => { const x = e.target.files?.[0]; if (x) acao(() => api.pf.enviarFoto(tx.id, slot as MediaSlot, x)); e.target.value = ""; }} /></label>
              ))}
            </div>
          )}
          <p className="text-xs text-slate-500">Situação: {rotuloEstado(tx.state)} · valor {tx.terms ? formatarCentavos(tx.terms.payload.valor_centavos) : "—"}{MODO_DEMO && <> · <Link className="underline" to="/demo/celular" target="_blank">ver WhatsApp do comprador</Link></>}</p>
          <div className="flex flex-wrap gap-2">
            {!compradorOk && <Botao variante="secundario" disabled={ocupado} onClick={() => acao(() => api.pf.reenviarConvite(tx.id), "Convite reenviado para o comprador.")}>Reenviar convite</Botao>}
            {!declarada && <Botao grande className="flex-1" disabled={!podeConfirmar || ocupado} onClick={() => acao(() => api.pf.confirmarVenda(tx.id))}>Confirmar venda e transferir</Botao>}
            <Botao variante="perigo" disabled={ocupado} onClick={() => { if (confirm("Cancelar esta venda?")) acao(() => api.pf.cancelarVenda(tx.id)).then(() => nav("/pf")); }}>Cancelar</Botao>
          </div>
        </div>
      )}
      {tx.device && <div className="cartao"><p className="mb-2 text-xs font-bold uppercase text-slate-500">Linha do tempo pública deste aparelho</p><PassaporteResumo device_id={tx.device.device_id} imei_mascarado={tx.device.imei_mascarado} /></div>}
    </div>
  );
}

function PassaporteResumo({ imei_mascarado }: { device_id: string; imei_mascarado: string }) {
  return <p className="text-sm text-slate-600">Consulte pelo IMEI completo em <Link className="underline" to="/passaporte">Passaporte do aparelho</Link> ({imei_mascarado}).</p>;
}

// ---------------------------------------------------------------------------
// Comunicar venda (declaração unilateral)
// ---------------------------------------------------------------------------
export function PfComunicar() {
  const { deviceId = "" } = useParams();
  const nav = useNavigate();
  const [f, setF] = useState({ cpf: "", nome: "", telefone: "", data: new Date().toISOString().slice(0, 10), valor: "" });
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  async function enviar(e: FormEvent) {
    e.preventDefault(); setErro(null); setOcupado(true);
    try { const t = await api.pf.comunicarVenda({ device_id: deviceId, comprador: { cpf: f.cpf, nome: f.nome || undefined, telefone: f.telefone || undefined }, data_venda: f.data, valor_centavos: parseReais(f.valor) || undefined }); nav(`/pf/venda/${t.id}`); }
    catch (err) { setErro(mensagemDeErro(err)); } finally { setOcupado(false); }
  }
  return (
    <form onSubmit={enviar} className="cartao space-y-4">
      <div><h1 className="text-2xl font-black tracking-tight">Comunicar venda</h1><p className="text-sm text-slate-600">Já vendeu e o comprador não fez o registro? Declare a venda. Ela entra no passaporte do aparelho como <Selo tipo="declarado" /> a partir da data informada — e vira transferência completa se o comprador confirmar pelo celular dele.</p></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><Rotulo htmlFor="ccpf" obrigatorio>CPF do comprador</Rotulo><Campo id="ccpf" autoFocus inputMode="numeric" value={f.cpf} onChange={(e) => setF({ ...f, cpf: e.target.value })} /></div>
        <div><Rotulo htmlFor="cnome">Nome do comprador</Rotulo><Campo id="cnome" placeholder="Se souber" value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} /></div>
        <div><Rotulo htmlFor="ctel">WhatsApp do comprador</Rotulo><Campo id="ctel" inputMode="tel" placeholder="Se tiver — ele recebe o convite para confirmar" value={f.telefone} onChange={(e) => setF({ ...f, telefone: e.target.value })} /></div>
        <div><Rotulo htmlFor="cdata" obrigatorio>Data da venda</Rotulo><Campo id="cdata" type="date" value={f.data} onChange={(e) => setF({ ...f, data: e.target.value })} /></div>
        <div><Rotulo htmlFor="cvalor">Valor (R$)</Rotulo><Campo id="cvalor" inputMode="decimal" placeholder="Opcional" value={f.valor} onChange={(e) => setF({ ...f, valor: e.target.value })} /></div>
      </div>
      <Aviso tom="info">Declaração unilateral: o Cartório registra que <strong>você declarou</strong> a venda, com a data. Não confirma que o comprador concorda. Se o aparelho for usado indevidamente depois dessa data, o registro mostra que você já tinha declarado a venda.</Aviso>
      <Erro>{erro}</Erro>
      <div className="flex gap-3"><Link to="/pf"><Botao type="button" variante="secundario">Voltar</Botao></Link><Botao type="submit" className="flex-1" disabled={ocupado || onlyDigits(f.cpf).length !== 11}>Declarar venda</Botao></div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Registrar / retirar ocorrência
// ---------------------------------------------------------------------------
export function PfOcorrencia() {
  const { deviceId = "" } = useParams();
  const nav = useNavigate();
  const [ap, setAp] = useState<MeuAparelho | null | undefined>(undefined);
  const [f, setF] = useState({ tipo: "furto" as "furto" | "roubo" | "perda", bo: "", data: new Date().toISOString().slice(0, 10), cidade: "", uf: "" });
  const [motivo, setMotivo] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => { api.pf.meusAparelhos().then((l) => setAp(l.find((a) => a.device.device_id === deviceId) ?? null)); }, [deviceId]);
  if (ap === undefined) return <Carregando />;
  if (ap === null) return <Aviso tom="bloqueio">Você não é o titular registrado deste aparelho.</Aviso>;
  async function registrar(e: FormEvent) {
    e.preventDefault(); setErro(null); setOcupado(true);
    try { await api.pf.registrarOcorrencia({ device_id: deviceId, tipo: f.tipo, bo_numero: f.bo, bo_data: f.data, cidade: f.cidade, uf: f.uf }); nav("/pf"); } catch (err) { setErro(mensagemDeErro(err)); } finally { setOcupado(false); }
  }
  async function retirar(e: FormEvent) {
    e.preventDefault(); setErro(null); setOcupado(true);
    try { await api.pf.retirarOcorrencia(deviceId, motivo); nav("/pf"); } catch (err) { setErro(mensagemDeErro(err)); } finally { setOcupado(false); }
  }
  if (ap.ocorrencia_ativa) {
    return (
      <form onSubmit={retirar} className="cartao space-y-4">
        <h1 className="text-2xl font-black tracking-tight">Retirar declaração</h1>
        <Aviso tom="alerta">Declaração de {ap.ocorrencia_ativa.tipo} registrada em {formatarData(ap.ocorrencia_ativa.declarada_em)}{ap.ocorrencia_ativa.bo_numero ? ` · B.O. ${ap.ocorrencia_ativa.bo_numero}` : ""}. A retirada também fica no passaporte, com o motivo.</Aviso>
        <div><Rotulo htmlFor="rm" obrigatorio>Motivo</Rotulo><Campo id="rm" placeholder="Ex.: aparelho recuperado" value={motivo} onChange={(e) => setMotivo(e.target.value)} /></div>
        <Erro>{erro}</Erro>
        <div className="flex gap-3"><Link to="/pf"><Botao type="button" variante="secundario">Voltar</Botao></Link><Botao type="submit" className="flex-1" disabled={ocupado}>Retirar declaração</Botao></div>
      </form>
    );
  }
  return (
    <form onSubmit={registrar} className="cartao space-y-4">
      <div><h1 className="text-2xl font-black tracking-tight">Registrar furto, roubo ou perda</h1><p className="text-sm text-slate-600">{[ap.device.brand, ap.device.model].filter(Boolean).join(" ")} · IMEI {ap.device.imei_mascarado}</p></div>
      <Aviso tom="info" titulo="O que isto faz — e o que não faz">Grava no passaporte público que <strong>você, titular registrado, declarou</strong> a ocorrência, com o número do B.O. se tiver. Qualquer loja que consultar o IMEI vê isso antes de comprar, e nenhuma transferência conclui enquanto a declaração estiver ativa. <strong>Não substitui</strong> o boletim de ocorrência nem o bloqueio oficial: registre também no <a className="underline" href="https://www.gov.br/celularseguro" target="_blank" rel="noreferrer">Celular Seguro (gov.br)</a>.</Aviso>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><Rotulo obrigatorio>O que aconteceu</Rotulo><div className="flex gap-2">{(["furto", "roubo", "perda"] as const).map((t) => <button key={t} type="button" onClick={() => setF({ ...f, tipo: t })} className={`rounded-full border-2 px-4 py-1.5 font-semibold capitalize ${f.tipo === t ? "border-red-700 bg-red-700 text-white" : "border-slate-300"}`}>{t}</button>)}</div></div>
        <div><Rotulo htmlFor="obo">Número do B.O.</Rotulo><Campo id="obo" placeholder="Se já registrou" value={f.bo} onChange={(e) => setF({ ...f, bo: e.target.value })} /></div>
        <div><Rotulo htmlFor="odata" obrigatorio>Data</Rotulo><Campo id="odata" type="date" value={f.data} onChange={(e) => setF({ ...f, data: e.target.value })} /></div>
        <div className="grid grid-cols-3 gap-2"><div className="col-span-2"><Rotulo htmlFor="ocid">Cidade</Rotulo><Campo id="ocid" value={f.cidade} onChange={(e) => setF({ ...f, cidade: e.target.value })} /></div><div><Rotulo htmlFor="ouf">UF</Rotulo><Campo id="ouf" maxLength={2} value={f.uf} onChange={(e) => setF({ ...f, uf: e.target.value })} /></div></div>
      </div>
      <Erro>{erro}</Erro>
      <div className="flex gap-3"><Link to="/pf"><Botao type="button" variante="secundario">Voltar</Botao></Link><Botao type="submit" variante="perigo" className="flex-1" disabled={ocupado}>Registrar declaração</Botao></div>
    </form>
  );
}
