// A tela de balcão (PF→PJ) e a de revenda (PJ→PF) são a MESMA máquina: seis
// etapas, uma por vez, cronômetro no topo. O que muda é o kind e quem é o
// vendedor. Escrever duas telas seria começar a duplicar regra.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, MODO_DEMO, type BuscaAparelho, type PartyView, type TransacaoView } from "@/api/index.ts";
import {
  REQUIRED_MEDIA_SLOTS,
  cpfValido,
  descreverConsulta,
  descreverFaltantes,
  formatarCentavos,
  imeiValido,
  onlyDigits,
  rotuloEstado,
  uuid,
  type MediaSlot,
  type TransactionKind,
} from "@core/index.ts";
import { Aviso, Botao, Campo, Carregando, Erro, Rotulo, Selo, formatarData, mmss } from "@/components/ui.tsx";
import { META_MS, useCronometro } from "@/lib/cronometro.ts";
import { mensagemDeErro, useSession } from "@/lib/session.tsx";
import { demoAdmin } from "@/api/demo.ts";

type Etapa = 1 | 2 | 3 | 4 | 5 | 6 | 7;
const NOMES_ETAPA: Record<Etapa, string> = { 1: "Pessoa", 2: "Aparelho", 3: "Consulta", 4: "Fotos", 5: "Condições", 6: "Aceite", 7: "Concluído" };
const SLOTS: Array<{ slot: MediaSlot; rotulo: string; obrigatoria: boolean }> = [
  { slot: "frente_ligada", rotulo: "Frente, ligado", obrigatoria: true },
  { slot: "traseira", rotulo: "Traseira", obrigatoria: true },
  { slot: "tela_imei", rotulo: "Tela com o IMEI (*#06#)", obrigatoria: true },
  { slot: "avarias", rotulo: "Avarias (se houver)", obrigatoria: false },
];

export function FluxoTransacao({ kind }: { kind: Extract<TransactionKind, "pf_pj" | "pj_pf"> }) {
  const { sessao } = useSession();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { deviceId } = useParams();
  const crono = useCronometro();

  const [etapa, setEtapa] = useState<Etapa>(1);
  const [pessoa, setPessoa] = useState<PartyView | null>(null);
  const [aparelho, setAparelho] = useState<{ device_id: string; resumo: BuscaAparelho } | null>(null);
  const [tx, setTx] = useState<TransacaoView | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [carregandoTx, setCarregandoTx] = useState(!!params.get("tx") || !!deviceId);
  const idemCriar = useRef(uuid());
  const idemConcluir = useRef(uuid());
  const [conclusao, setConclusao] = useState<{ protocolo: string; grade: "forte" | "assistido"; tempo: number } | null>(null);

  const papelPessoa = kind === "pf_pj" ? "seller" : "buyer";

  const recarregar = useCallback(async (id: string) => {
    const t = await api.transacao.obter(id);
    setTx(t);
    return t;
  }, []);

  // Retomar uma transação (?tx=) ou começar revenda a partir de um aparelho (/revenda/:deviceId)
  useEffect(() => {
    (async () => {
      try {
        const txId = params.get("tx");
        if (txId) {
          const t = await recarregar(txId);
          const p = t.parties.find((x) => x.role === papelPessoa);
          if (p) setPessoa({ party_id: p.party_id, display_name: p.display_name, kind: p.kind, telefone_mascarado: p.telefone_mascarado });
          if (t.device) setAparelho({ device_id: t.device.device_id, resumo: { encontrado: true, device: t.device, elos: 0, linha_do_tempo: [] } });
          setEtapa(etapaDoEstado(t));
        } else if (deviceId) {
          const dv = await api.estoque.listar();
          const item = dv.find((i) => i.device.device_id === deviceId);
          if (!item) throw new Error("A loja não é a titular deste aparelho. Não se vende o que não se tem.");
          setAparelho({ device_id: deviceId, resumo: { encontrado: true, device: item.device, elos: 0, linha_do_tempo: [], loja_e_titular: true } });
        }
      } catch (e) {
        setErro(mensagemDeErro(e));
      } finally {
        setCarregandoTx(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function etapaDoEstado(t: TransacaoView): Etapa {
    if (t.state === "completed") return 7;
    if (["awaiting_data", "awaiting_checks", "under_review", "blocked"].includes(t.state)) return 3;
    const fotosOk = REQUIRED_MEDIA_SLOTS.every((s) => t.media.some((m) => m.slot === s));
    if (!fotosOk) return 4;
    if (!t.terms) return 5;
    return 6;
  }

  async function executar<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setErro(null);
    setOcupado(true);
    try {
      return await fn();
    } catch (e) {
      setErro(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  // Cria a transação assim que pessoa e aparelho existem.
  async function garantirTransacao(p: PartyView, device_id: string): Promise<TransacaoView> {
    if (tx) return tx;
    const loja = await api.estoque.partyDaLoja();
    const t = await api.transacao.criar({
      kind,
      device_id,
      seller_party_id: kind === "pf_pj" ? p.party_id : loja.party_id,
      buyer_party_id: kind === "pf_pj" ? loja.party_id : p.party_id,
      idempotency_key: idemCriar.current,
    });
    setTx(t);
    return t;
  }

  if (!sessao?.store) return <Aviso tom="alerta">Cadastre a loja antes de usar o balcão.</Aviso>;
  if (carregandoTx) return <Carregando texto="Abrindo o registro…" />;

  const dentroDaMeta = crono.decorrido <= META_MS;

  return (
    <div className="mx-auto max-w-2xl" onKeyDownCapture={crono.iniciar} onPointerDownCapture={crono.iniciar}>
      {/* Cabeçalho com cronômetro */}
      <div className="mb-4 flex items-center gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight">{kind === "pf_pj" ? "Entrada no balcão" : "Revenda"}</h1>
          <p className="text-xs text-slate-500">{kind === "pf_pj" ? "Pessoa vende para a loja · primeiro elo" : "Loja vende para pessoa · segundo elo"}</p>
        </div>
        <div className={`ml-auto rounded-lg px-3 py-1.5 font-mono text-2xl font-bold tabular-nums ${crono.parado ? "bg-slate-200 text-slate-700" : dentroDaMeta ? "bg-slate-900 text-white" : "bg-red-700 text-white"}`} title="Trabalho ativo do operador. Para quando o convite é enviado.">
          {mmss(crono.decorrido)}
        </div>
      </div>

      {/* Trilha de etapas */}
      <ol className="mb-5 flex gap-1 text-[11px] font-bold uppercase tracking-wide">
        {([1, 2, 3, 4, 5, 6] as Etapa[]).map((n) => (
          <li key={n} className={`flex-1 rounded px-1 py-1 text-center ${n === etapa ? "bg-teal-700 text-white" : n < etapa ? "bg-teal-100 text-teal-900" : "bg-slate-200 text-slate-500"}`}>{NOMES_ETAPA[n]}</li>
        ))}
      </ol>

      {erro && <div className="mb-4"><Aviso tom="bloqueio">{erro}</Aviso></div>}

      {etapa === 1 && (
        <EtapaPessoa
          papel={papelPessoa}
          ocupado={ocupado}
          onPronto={async (p) => {
            setPessoa(p);
            if (kind === "pj_pf" && aparelho) {
              const ok = await executar(() => garantirTransacao(p, aparelho.device_id));
              if (ok) setEtapa(3);
            } else setEtapa(2);
          }}
          executar={executar}
        />
      )}

      {etapa === 2 && (
        <EtapaAparelho
          ocupado={ocupado}
          executar={executar}
          onVoltar={() => setEtapa(1)}
          onPronto={async (device_id, resumo) => {
            setAparelho({ device_id, resumo });
            const ok = await executar(() => garantirTransacao(pessoa!, device_id));
            if (ok) setEtapa(3);
          }}
        />
      )}

      {etapa === 3 && tx && (
        <EtapaConsulta tx={tx} ocupado={ocupado} onVoltar={kind === "pf_pj" ? () => setEtapa(2) : undefined}
          onConsultar={async () => { await executar(async () => { await api.consulta.executar(tx.id); await recarregar(tx.id); }); }}
          onSeguir={() => setEtapa(4)} />
      )}

      {etapa === 4 && tx && (
        <EtapaFotos tx={tx} ocupado={ocupado} onVoltar={() => setEtapa(3)}
          onEnviar={async (slot, arquivo) => { await executar(async () => { await api.midia.enviar(tx.id, slot, arquivo); await recarregar(tx.id); }); }}
          onSeguir={() => setEtapa(5)} />
      )}

      {etapa === 5 && tx && (
        <EtapaCondicoes tx={tx} kind={kind} ocupado={ocupado} onVoltar={() => setEtapa(4)}
          onConfirmar={async (termos) => {
            const r = await executar(async () => { const r = await api.transacao.congelarTermos(tx.id, termos); await recarregar(tx.id); return r; });
            if (r) setEtapa(6);
          }} />
      )}

      {etapa === 6 && tx && pessoa && (
        <EtapaAceite
          tx={tx} pessoa={pessoa} papelPessoa={papelPessoa} ocupado={ocupado}
          onVoltar={() => setEtapa(5)}
          recarregar={() => recarregar(tx.id)}
          onConviteEnviado={() => crono.parar()}
          executar={executar}
          onConcluir={async () => {
            const r = await executar(async () => api.concluir(tx.id, idemConcluir.current));
            if (r) {
              crono.parar();
              setConclusao({ protocolo: r.protocolo, grade: r.grade, tempo: crono.decorrido });
              await recarregar(tx.id);
              setEtapa(7);
            }
          }}
        />
      )}

      {etapa === 7 && tx && (
        <div className="cartao text-center space-y-4">
          <p className="text-sm font-bold uppercase tracking-wide text-teal-800">Registro concluído</p>
          <p className="font-mono text-5xl font-black tracking-[0.2em]">{tx.public_protocol}</p>
          <div className="flex justify-center"><Selo tipo={(conclusao?.grade ?? tx.aceite.grade) === "assistido" ? "assistido" : "forte"} /></div>
          {conclusao && (
            <p className={`text-lg font-semibold ${conclusao.tempo <= META_MS ? "text-teal-800" : "text-red-700"}`}>
              Trabalho ativo do operador: {mmss(conclusao.tempo)} {conclusao.tempo <= META_MS ? "— dentro da meta de 1:30" : "— acima da meta de 1:30"}
            </p>
          )}
          {tx.aceite.grade === "assistido" && (
            <Aviso tom="alerta" titulo="Aceite presencial assistido">Este registro carrega prova de grau menor: o cliente confirmou no aparelho do operador. Isso fica visível no passaporte público do aparelho.</Aviso>
          )}
          <div className="flex flex-wrap justify-center gap-3">
            <Link to={`/certificado/${tx.public_protocol}`}><Botao variante="secundario">Ver certificado</Botao></Link>
            {tx.device && <Link to={`/passaporte?imei=${tx.device.device_id}`} className="hidden" />}
            <Botao onClick={() => { crono.zerar(); nav(kind === "pf_pj" ? "/balcao" : "/estoque"); setEtapa(1); setPessoa(null); setAparelho(null); setTx(null); setConclusao(null); idemCriar.current = uuid(); idemConcluir.current = uuid(); }}>
              {kind === "pf_pj" ? "Registrar outra entrada" : "Voltar ao estoque"}
            </Botao>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Etapa 1 — Pessoa (vendedor no balcão; comprador na revenda)
// ---------------------------------------------------------------------------
function EtapaPessoa({ papel, ocupado, onPronto, executar }: { papel: "seller" | "buyer"; ocupado: boolean; onPronto: (p: PartyView) => void; executar: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const [cpf, setCpf] = useState("");
  const [nome, setNome] = useState("");
  const [tel, setTel] = useState("");
  const [busca, setBusca] = useState<{ encontrado: boolean; vinculo?: boolean; party_id?: string; display_name?: string; telefone_mascarado?: string | null } | null>(null);
  const [erroCpf, setErroCpf] = useState<string | null>(null);
  const nomeRef = useRef<HTMLInputElement>(null);
  const buscado = useRef("");

  useEffect(() => {
    const d = onlyDigits(cpf);
    if (d.length !== 11 || buscado.current === d) return;
    if (!cpfValido(d)) { setErroCpf("Esse CPF não confere. Confira os dígitos."); return; }
    setErroCpf(null);
    buscado.current = d;
    executar(() => api.identidade.buscar(d)).then((r) => {
      if (!r) return;
      setBusca(r);
      if (r.encontrado && r.vinculo) { setNome(r.display_name ?? ""); }
      else nomeRef.current?.focus();
    });
  }, [cpf, executar]);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    const d = onlyDigits(cpf);
    if (!cpfValido(d)) { setErroCpf("Esse CPF não confere. Confira os dígitos."); return; }
    if (busca?.encontrado && busca.vinculo && busca.party_id) {
      onPronto({ party_id: busca.party_id, display_name: busca.display_name ?? nome, kind: "pf", telefone_mascarado: busca.telefone_mascarado ?? null });
      return;
    }
    const p = await executar(() => api.identidade.criar({ documento: d, tipo: "pf", nome, telefone: tel }));
    if (p) onPronto(p);
  }

  const jaVinculada = !!(busca?.encontrado && busca.vinculo);
  return (
    <form onSubmit={enviar} className="cartao space-y-4">
      <h2 className="text-lg font-bold">{papel === "seller" ? "Quem está vendendo" : "Quem está comprando"}</h2>
      <div>
        <Rotulo htmlFor="cpf" obrigatorio>CPF</Rotulo>
        <Campo id="cpf" autoFocus inputMode="numeric" autoComplete="off" placeholder="000.000.000-00" value={cpf} erro={erroCpf} onChange={(e) => { setCpf(e.target.value); setBusca(null); }} />
        <Erro>{erroCpf}</Erro>
      </div>
      {busca?.encontrado && busca.vinculo && <Aviso tom="ok" titulo="Já cadastrado nesta loja">{busca.display_name} · {busca.telefone_mascarado ?? "sem telefone"}</Aviso>}
      {busca?.encontrado && busca.vinculo === false && <Aviso tom="info" titulo="Pessoa já existe na plataforma">Ainda não tem vínculo com esta loja. Confirme nome e telefone para vincular — o cadastro não é duplicado.</Aviso>}
      {!jaVinculada && (
        <>
          <div>
            <Rotulo htmlFor="nome" obrigatorio>Nome completo</Rotulo>
            <Campo id="nome" ref={nomeRef} autoComplete="off" value={nome} onChange={(e) => setNome(e.target.value)} required />
          </div>
          <div>
            <Rotulo htmlFor="tel" obrigatorio>WhatsApp com DDD</Rotulo>
            <Campo id="tel" inputMode="tel" autoComplete="off" placeholder="(31) 99999-9999" value={tel} onChange={(e) => setTel(e.target.value)} required />
            <p className="mt-1 text-xs text-slate-500">É por ele que o código de aceite chega. O código nunca aparece nesta tela.</p>
          </div>
        </>
      )}
      <Botao type="submit" grande disabled={ocupado}>Continuar</Botao>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Etapa 2 — Aparelho
// ---------------------------------------------------------------------------
function EtapaAparelho({ ocupado, executar, onVoltar, onPronto }: { ocupado: boolean; executar: <T>(fn: () => Promise<T>) => Promise<T | undefined>; onVoltar: () => void; onPronto: (device_id: string, resumo: BuscaAparelho) => void }) {
  const [imei, setImei] = useState("");
  const [f, setF] = useState({ marca: "", modelo: "", armazenamento: "", cor: "" });
  const [erroImei, setErroImei] = useState<string | null>(null);
  const [existente, setExistente] = useState<BuscaAparelho | null>(null);
  const marcaRef = useRef<HTMLInputElement>(null);
  const buscado = useRef("");

  useEffect(() => {
    const d = onlyDigits(imei);
    if (d.length !== 15 || buscado.current === d) return;
    if (!imeiValido(d)) { setErroImei("Esse IMEI não confere. Confira os 15 dígitos — provavelmente há um número trocado."); return; }
    setErroImei(null);
    buscado.current = d;
    executar(() => api.aparelho.buscarPorImei(d)).then((r) => {
      if (!r) return;
      if (r.encontrado) setExistente(r);
      else { setExistente(null); marcaRef.current?.focus(); }
    });
  }, [imei, executar]);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    const d = onlyDigits(imei);
    if (!imeiValido(d)) { setErroImei("Esse IMEI não confere. Confira os 15 dígitos — provavelmente há um número trocado."); return; }
    if (existente?.device) { onPronto(existente.device.device_id, existente); return; }
    const r = await executar(() => api.aparelho.criar({ imei: d, ...f }));
    if (!r) return;
    if (r.conflito) { setExistente(r.existente); return; }
    onPronto(r.device_id, { encontrado: true, elos: 0, linha_do_tempo: [] });
  }

  return (
    <form onSubmit={enviar} className="cartao space-y-4">
      <h2 className="text-lg font-bold">O aparelho</h2>
      <div>
        <Rotulo htmlFor="imei" obrigatorio>IMEI (15 dígitos — disque *#06#)</Rotulo>
        <Campo id="imei" autoFocus inputMode="numeric" autoComplete="off" className="font-mono tracking-widest" value={imei} erro={erroImei} onChange={(e) => { setImei(e.target.value); setExistente(null); }} maxLength={17} />
        <Erro>{erroImei}</Erro>
        {MODO_DEMO && (
          <p className="mt-1 text-xs text-slate-500">
            Demonstração — gerar IMEI de teste:{" "}
            {(["clear", "restricted", "inconclusive", "unavailable"] as const).map((k) => (
              <button key={k} type="button" className="mr-2 underline" onClick={() => { setImei(demoAdmin.imeiExemplo(k)); setExistente(null); }}>{{ clear: "sem restrição", restricted: "com restrição", inconclusive: "inconclusivo", unavailable: "indisponível" }[k]}</button>
            ))}
          </p>
        )}
      </div>
      {existente?.device && (
        <Aviso tom="info" titulo="Este aparelho já passou pelo Cartório">
          <p>{[existente.device.brand, existente.device.model, existente.device.storage, existente.device.color].filter(Boolean).join(" ")} · {existente.elos} elo(s) registrado(s)</p>
          <LinhaDoTempo eventos={existente.linha_do_tempo} compacta />
          <p className="mt-1">Isso muda a conversa no balcão. O aparelho não será cadastrado de novo — a passagem entra na corrente dele.</p>
        </Aviso>
      )}
      {!existente && (
        <div className="grid grid-cols-2 gap-3">
          <div><Rotulo htmlFor="marca" obrigatorio>Marca</Rotulo><Campo id="marca" ref={marcaRef} value={f.marca} onChange={(e) => setF({ ...f, marca: e.target.value })} required /></div>
          <div><Rotulo htmlFor="modelo" obrigatorio>Modelo</Rotulo><Campo id="modelo" value={f.modelo} onChange={(e) => setF({ ...f, modelo: e.target.value })} required /></div>
          <div><Rotulo htmlFor="arm">Armazenamento</Rotulo><Campo id="arm" placeholder="128 GB" value={f.armazenamento} onChange={(e) => setF({ ...f, armazenamento: e.target.value })} /></div>
          <div><Rotulo htmlFor="cor">Cor</Rotulo><Campo id="cor" value={f.cor} onChange={(e) => setF({ ...f, cor: e.target.value })} /></div>
        </div>
      )}
      <div className="flex gap-3">
        <Botao type="button" variante="secundario" onClick={onVoltar}>Voltar</Botao>
        <Botao type="submit" className="flex-1" disabled={ocupado}>Continuar</Botao>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Etapa 3 — Consulta de procedência
// ---------------------------------------------------------------------------
function EtapaConsulta({ tx, ocupado, onVoltar, onConsultar, onSeguir }: { tx: TransacaoView; ocupado: boolean; onVoltar?: () => void; onConsultar: () => Promise<void>; onSeguir: () => void }) {
  const rodou = useRef(false);
  useEffect(() => { if (!tx.check && !rodou.current) { rodou.current = true; onConsultar(); } }, [tx.check, onConsultar]);
  const d = descreverConsulta(tx.check);
  const liberado = tx.state === "awaiting_seller" || tx.state === "awaiting_buyer" || tx.state === "ready_to_complete";
  return (
    <div className="cartao space-y-4">
      <h2 className="text-lg font-bold">Consulta de procedência <Selo tipo="verificado" /></h2>
      {ocupado && !tx.check ? <Carregando texto="Consultando…" /> : (
        <Aviso tom={d.tom} titulo={d.titulo}>{d.detalhe}</Aviso>
      )}
      {tx.check?.raw && (tx.check.raw as { simulado?: boolean }).simulado && <p className="text-xs text-slate-500">Fonte simulada — nenhuma base oficial foi consultada. Uma consulta é do instante em que foi feita e não diz nada sobre o instante seguinte. Furto sem boletim de ocorrência não aparece em base nenhuma.</p>}
      {tx.state === "blocked" && <Aviso tom="bloqueio" titulo="Transação bloqueada">Consta restrição na consulta. Este registro não pode ser concluído. O sistema registra; não acusa — oriente o cliente a procurar a fonte da restrição.</Aviso>}
      <p className="text-xs text-slate-500">Situação: {rotuloEstado(tx.state)}</p>
      <div className="flex gap-3">
        {onVoltar && <Botao type="button" variante="secundario" onClick={onVoltar}>Voltar</Botao>}
        {!liberado && tx.state !== "blocked" && <Botao type="button" variante="secundario" onClick={onConsultar} disabled={ocupado}>Consultar de novo</Botao>}
        <Botao type="button" className="flex-1" onClick={onSeguir} disabled={!liberado || ocupado}>Continuar</Botao>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Etapa 4 — Fotos
// ---------------------------------------------------------------------------
function EtapaFotos({ tx, ocupado, onVoltar, onEnviar, onSeguir }: { tx: TransacaoView; ocupado: boolean; onVoltar: () => void; onEnviar: (slot: MediaSlot, arquivo: File) => Promise<void>; onSeguir: () => void }) {
  const completo = REQUIRED_MEDIA_SLOTS.every((s) => tx.media.some((m) => m.slot === s));
  return (
    <div className="cartao space-y-4">
      <h2 className="text-lg font-bold">Fotos do aparelho</h2>
      <p className="text-sm text-slate-600">Três obrigatórias. A foto é evidência: hash gravado, metadados de localização removidos.</p>
      <div className="grid grid-cols-2 gap-3">
        {SLOTS.map(({ slot, rotulo, obrigatoria }) => {
          const m = tx.media.find((x) => x.slot === slot);
          return (
            <label key={slot} className={`relative flex aspect-[4/3] cursor-pointer flex-col items-center justify-center overflow-hidden rounded-lg border-2 ${m ? "border-teal-600" : obrigatoria ? "border-dashed border-slate-400" : "border-dashed border-slate-300"} bg-slate-50 text-center`}>
              {m ? <img src={m.url} alt={rotulo} className="absolute inset-0 h-full w-full object-cover" /> : <span className="text-3xl" aria-hidden>📷</span>}
              <span className={`relative z-10 mt-1 rounded px-2 py-0.5 text-sm font-semibold ${m ? "bg-black/60 text-white" : "text-slate-700"}`}>{rotulo}{obrigatoria && !m && " *"}</span>
              <input type="file" accept="image/*" capture="environment" className="sr-only" disabled={ocupado} onChange={(e) => { const f = e.target.files?.[0]; if (f) onEnviar(slot, f); e.target.value = ""; }} />
            </label>
          );
        })}
      </div>
      {MODO_DEMO && (
        <button type="button" className="text-xs underline text-slate-600" disabled={ocupado} onClick={async () => { for (const s of REQUIRED_MEDIA_SLOTS) if (!tx.media.some((m) => m.slot === s)) await onEnviar(s, fotoSintetica(s)); }}>
          Demonstração: preencher com fotos sintéticas
        </button>
      )}
      <div className="flex gap-3">
        <Botao type="button" variante="secundario" onClick={onVoltar}>Voltar</Botao>
        <Botao type="button" className="flex-1" onClick={onSeguir} disabled={!completo || ocupado}>Continuar</Botao>
      </div>
    </div>
  );
}

function fotoSintetica(slot: MediaSlot): File {
  const c = document.createElement("canvas");
  c.width = 320; c.height = 240;
  const g = c.getContext("2d")!;
  g.fillStyle = "#334155"; g.fillRect(0, 0, 320, 240);
  g.fillStyle = "#94a3b8"; g.font = "bold 22px sans-serif"; g.textAlign = "center";
  g.fillText(`foto sintética · ${slot}`, 160, 125);
  const bin = atob(c.toDataURL("image/jpeg", 0.6).split(",")[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], `${slot}.jpg`, { type: "image/jpeg" });
}

// ---------------------------------------------------------------------------
// Etapa 5 — Condições (congela os termos)
// ---------------------------------------------------------------------------
function EtapaCondicoes({ tx, kind, ocupado, onVoltar, onConfirmar }: { tx: TransacaoView; kind: TransactionKind; ocupado: boolean; onVoltar: () => void; onConfirmar: (t: { valor_centavos: number; forma_pagamento: string; estado_aparelho: string; defeitos: string; garantia: string; declaracoes: Record<string, string> }) => Promise<void> }) {
  const p = tx.terms?.payload;
  const [valor, setValor] = useState(p ? String(p.valor_centavos / 100).replace(".", ",") : "");
  const [forma, setForma] = useState(p?.forma_pagamento ?? "pix");
  const [estado, setEstado] = useState(p?.estado_aparelho ?? "");
  const [defeitos, setDefeitos] = useState(p?.defeitos ?? "");
  const [garantia, setGarantia] = useState(p?.garantia ?? (kind === "pj_pf" ? "90 dias" : ""));
  const [contas, setContas] = useState((p?.declaracoes?.["conta_icloud_google"] as string) ?? "desvinculada");
  const [origem, setOrigem] = useState((p?.declaracoes?.["origem"] as string) ?? "compra_com_nota");

  function enviar(e: FormEvent) {
    e.preventDefault();
    const cent = Math.round(Number(valor.replace(/\./g, "").replace(",", ".")) * 100);
    onConfirmar({ valor_centavos: cent, forma_pagamento: forma, estado_aparelho: estado, defeitos, garantia, declaracoes: { conta_icloud_google: contas, origem } });
  }
  return (
    <form onSubmit={enviar} className="cartao space-y-4">
      <h2 className="text-lg font-bold">Condições</h2>
      {tx.terms && <Aviso tom="info">Termos vigentes: versão {tx.terms.version}. Se mudar algo aqui, nasce a versão {tx.terms.version + 1} e os aceites já dados deixam de contar — o cliente nunca assina algo diferente do que leu.</Aviso>}
      <div className="grid grid-cols-2 gap-3">
        <div><Rotulo htmlFor="valor" obrigatorio>Valor (R$)</Rotulo><Campo id="valor" autoFocus inputMode="decimal" placeholder="0,00" value={valor} onChange={(e) => setValor(e.target.value)} required /></div>
        <div>
          <Rotulo htmlFor="forma" obrigatorio>Forma de pagamento</Rotulo>
          <select id="forma" className="campo" value={forma} onChange={(e) => setForma(e.target.value)}>
            <option value="pix">Pix</option><option value="dinheiro">Dinheiro</option><option value="cartao">Cartão</option><option value="troca">Troca / abatimento</option><option value="transferencia">Transferência</option>
          </select>
        </div>
      </div>
      <fieldset className="rounded-lg border-2 border-amber-200 bg-amber-50/40 p-3 space-y-3">
        <legend className="px-1 text-sm font-bold text-amber-900">Declarado pelo {kind === "pf_pj" ? "vendedor" : "comprador e pela loja"} <Selo tipo="declarado" /></legend>
        <div><Rotulo htmlFor="estado" obrigatorio>Estado do aparelho</Rotulo>
          <select id="estado" className="campo" value={estado} onChange={(e) => setEstado(e.target.value)} required>
            <option value="">Selecione</option><option>Novo / lacrado</option><option>Excelente</option><option>Bom</option><option>Regular</option><option>Com defeito</option><option>Para peças</option>
          </select>
        </div>
        <div><Rotulo htmlFor="defeitos">Defeitos declarados</Rotulo><Campo id="defeitos" placeholder="Nenhum" value={defeitos} onChange={(e) => setDefeitos(e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><Rotulo htmlFor="contas">Conta iCloud / Google</Rotulo>
            <select id="contas" className="campo" value={contas} onChange={(e) => setContas(e.target.value)}><option value="desvinculada">Desvinculada</option><option value="vinculada">Ainda vinculada</option><option value="nao_verificado">Não verificado</option></select>
          </div>
          <div><Rotulo htmlFor="origem">Origem declarada</Rotulo>
            <select id="origem" className="campo" value={origem} onChange={(e) => setOrigem(e.target.value)}><option value="compra_com_nota">Compra com nota fiscal</option><option value="compra_sem_nota">Compra sem nota fiscal</option><option value="presente">Presente</option><option value="outra">Outra</option></select>
          </div>
        </div>
        <div><Rotulo htmlFor="garantia">Garantia</Rotulo><Campo id="garantia" placeholder={kind === "pj_pf" ? "90 dias" : "Sem garantia"} value={garantia} onChange={(e) => setGarantia(e.target.value)} /></div>
      </fieldset>
      <div className="flex gap-3">
        <Botao type="button" variante="secundario" onClick={onVoltar}>Voltar</Botao>
        <Botao type="submit" className="flex-1" disabled={ocupado}>{tx.terms ? "Confirmar condições" : "Confirmar e congelar os termos"}</Botao>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Etapa 6 — Aceite
// ---------------------------------------------------------------------------
function EtapaAceite({ tx, pessoa, papelPessoa, ocupado, onVoltar, recarregar, onConviteEnviado, executar, onConcluir }: {
  tx: TransacaoView; pessoa: PartyView; papelPessoa: "seller" | "buyer"; ocupado: boolean; onVoltar: () => void;
  recarregar: () => Promise<TransacaoView>; onConviteEnviado: () => void; executar: <T>(fn: () => Promise<T>) => Promise<T | undefined>; onConcluir: () => Promise<void>;
}) {
  const [convite, setConvite] = useState<{ link: string; destino: string; reaproveitado: boolean } | null>(null);
  const [mostrarAssistido, setMostrarAssistido] = useState(false);
  const [motivo, setMotivo] = useState("");
  const loja = tx.parties.find((p) => p.is_tenant_side)!;
  const cliente = tx.parties.find((p) => p.party_id === pessoa.party_id)!;
  const lojaAceitou = tx.aceite.accepted.some((p) => p.party_id === loja.party_id);
  const clienteAceitou = tx.aceite.accepted.some((p) => p.party_id === cliente.party_id);
  const conviteVivo = tx.convites.find((c) => c.party_id === cliente.party_id && c.terms_version === tx.current_terms_version && !c.consumed_at && !c.revoked_at);

  // Enquanto falta o cliente, a tela se atualiza sozinha — o aceite chega pelo celular dele.
  useEffect(() => {
    if (clienteAceitou) return;
    const id = setInterval(() => { recarregar().catch(() => {}); }, 2500);
    return () => clearInterval(id);
  }, [clienteAceitou, recarregar]);

  const resumo = useMemo(() => tx.terms ? `${formatarCentavos(tx.terms.payload.valor_centavos)} · ${tx.terms.payload.forma_pagamento} · ${tx.terms.payload.estado_aparelho}` : "", [tx.terms]);

  return (
    <div className="space-y-4">
      <div className="cartao space-y-3">
        <h2 className="text-lg font-bold">Aceite das partes</h2>
        <p className="text-sm text-slate-600">{resumo} · termos v{tx.current_terms_version}</p>

        {/* Loja */}
        <div className="flex items-center gap-3 rounded-lg border-2 border-slate-200 p-3">
          <span className={`h-3 w-3 rounded-full ${lojaAceitou ? "bg-teal-600" : "bg-slate-300"}`} />
          <div className="flex-1"><p className="font-semibold">{loja.display_name} <span className="text-xs text-slate-500">(a loja, {loja.role === "buyer" ? "compradora" : "vendedora"})</span></p></div>
          {!lojaAceitou && <Botao variante="secundario" disabled={ocupado} onClick={() => executar(async () => { await api.aceiteLoja.registrar(tx.id, loja.party_id); await recarregar(); })}>Aceitar pela loja</Botao>}
          {lojaAceitou && <span className="text-sm font-semibold text-teal-800">Aceito</span>}
        </div>

        {/* Cliente */}
        <div className="rounded-lg border-2 border-slate-200 p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className={`h-3 w-3 shrink-0 rounded-full ${clienteAceitou ? "bg-teal-600" : "bg-slate-300"}`} />
            <div className="min-w-0 flex-1 basis-40"><p className="font-semibold">{cliente.display_name} <span className="text-xs text-slate-500 whitespace-nowrap">({papelPessoa === "seller" ? "vendedor" : "comprador"}) · {cliente.telefone_mascarado}</span></p></div>
            {clienteAceitou ? <span className="text-sm font-semibold text-teal-800">Aceito</span> : (
              <Botao disabled={ocupado} onClick={() => executar(async () => { const c = await api.convite.criar(tx.id, cliente.party_id); setConvite({ link: c.link, destino: c.destino_mascarado, reaproveitado: c.reaproveitado }); onConviteEnviado(); await recarregar(); })}>
                {conviteVivo ? "Reenviar código" : "Enviar código pelo WhatsApp"}
              </Botao>
            )}
          </div>
          {!clienteAceitou && (convite || conviteVivo) && (
            <Aviso tom="info" titulo={`Link enviado para ${convite?.destino ?? conviteVivo?.destino_mascarado}`}>
              O cliente abre o link no celular dele, pede o código e confirma. O código chega no WhatsApp dele — nunca nesta tela. O cronômetro parou: daqui em diante o trabalho é do cliente.
              {MODO_DEMO && <p className="mt-1">Demonstração: veja o WhatsApp do cliente em <Link className="underline font-semibold" to="/demo/celular" target="_blank">📱 Celular do cliente</Link>.</p>}
            </Aviso>
          )}
          {!clienteAceitou && conviteVivo && !mostrarAssistido && (
            <button type="button" className="text-xs text-slate-500 underline" onClick={() => setMostrarAssistido(true)}>O código não chegou no celular do cliente?</button>
          )}
          {!clienteAceitou && mostrarAssistido && (
            <div className="rounded-lg border-2 border-orange-300 bg-orange-50 p-3 space-y-2">
              <p className="font-bold text-orange-900">Aceite presencial assistido — exceção, não atalho</p>
              <p className="text-sm text-orange-950">O cliente confirma neste aparelho, com você presente. Isso <strong>enfraquece a prova</strong> (operador e aceite no mesmo dispositivo) e fica marcado para sempre no passaporte público do aparelho. Use só se o WhatsApp da loja realmente não entregou o código.</p>
              <Rotulo htmlFor="motivo" obrigatorio>Motivo (mínimo 10 caracteres)</Rotulo>
              <Campo id="motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: WhatsApp da loja sem conexão desde as 14h" />
              <div className="flex gap-2">
                <Botao variante="secundario" type="button" onClick={() => setMostrarAssistido(false)}>Cancelar</Botao>
                <Botao variante="perigo" type="button" disabled={ocupado || motivo.trim().length < 10} onClick={() => executar(async () => { await api.aceiteAssistido.registrar(tx.id, cliente.party_id, motivo); setMostrarAssistido(false); await recarregar(); })}>
                  Registrar aceite assistido
                </Botao>
              </div>
            </div>
          )}
        </div>

        <p className={`text-sm font-semibold ${tx.aceite.complete ? "text-teal-800" : "text-slate-700"}`}>{descreverFaltantes(tx.aceite)}</p>
        {tx.aceite.grade === "assistido" && <Selo tipo="assistido" />}
      </div>

      <div className="flex gap-3">
        <Botao type="button" variante="secundario" onClick={onVoltar}>Voltar</Botao>
        <Botao type="button" grande className="flex-1" disabled={!tx.aceite.complete || ocupado} onClick={onConcluir}>Concluir registro</Botao>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
const ROTULO_MODALIDADE: Record<string, string> = { pf_pj: "pessoa → loja", pj_pf: "loja → pessoa", pf_pf: "pessoa → pessoa", pj_pj: "loja → loja" };

export function LinhaDoTempo({ eventos, compacta }: { eventos: Array<{ tipo: string; data: string; dados: Record<string, unknown> }>; compacta?: boolean }) {
  if (!eventos.length) return null;
  const rot: Record<string, string> = { device_created: "Aparelho cadastrado", transfer_completed: "Passagem de mão registrada", check_performed: "Consulta de procedência", chain_gap: "Passagem sem registro entre titulares" };
  return (
    <ol className={`${compacta ? "mt-2 text-xs" : "text-sm"} space-y-1`}>
      {eventos.map((e, i) => (
        <li key={i} className="flex gap-2">
          <span className="text-slate-500 whitespace-nowrap">{formatarData(e.data)}</span>
          <span className="font-semibold">{rot[e.tipo] ?? e.tipo}</span>
          {e.tipo === "transfer_completed" && <span className="text-slate-600">{ROTULO_MODALIDADE[String(e.dados.modalidade)] ?? String(e.dados.modalidade ?? "")} · protocolo {String(e.dados.protocolo ?? "")} {e.dados.aceite === "assistido" && <span className="selo selo-assistido ml-1">aceite assistido</span>}</span>}
          {e.tipo === "chain_gap" && <span className="text-slate-600">{String(e.dados.aviso ?? "")}</span>}
        </li>
      ))}
    </ol>
  );
}
