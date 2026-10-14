// /aceite-lote/:token — aberta pelo responsável da loja compradora NO CELULAR DELE.
// Sem login, de propósito. Um código confirma o lote inteiro.

import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { api, type ResumoAceiteLote } from "@/api/index.ts";
import { Aviso, Botao, Campo, Carregando, Erro } from "@/components/ui.tsx";
import { mensagemDeErro } from "@/lib/session.tsx";

export function AceiteLote() {
  const { token = "" } = useParams();
  const [r, setR] = useState<ResumoAceiteLote | null>(null);
  const [codigo, setCodigo] = useState("");
  const [enviado, setEnviado] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [aceito, setAceito] = useState(false);

  useEffect(() => { api.aceiteLotePublico.resumo(token).then(setR).catch((e) => setR({ valido: false, motivo: mensagemDeErro(e) })); }, [token]);

  async function pedir() {
    setErro(null); setOcupado(true);
    try { const x = await api.aceiteLotePublico.pedirCodigo(token); setEnviado(x.destino_mascarado); } catch (e) { setErro(mensagemDeErro(e)); } finally { setOcupado(false); }
  }
  async function confirmar(e: FormEvent) {
    e.preventDefault(); setErro(null); setOcupado(true);
    try { const x = await api.aceiteLotePublico.confirmar(token, codigo); if (x.aceito) setAceito(true); } catch (err) { setErro(mensagemDeErro(err)); } finally { setOcupado(false); }
  }

  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto max-w-md px-5 py-8">
        <p className="text-sm font-bold uppercase tracking-wide text-teal-800">Cartório do Celular</p>
        {!r && <Carregando />}
        {r && !r.valido && <div className="mt-4"><Aviso tom="alerta" titulo="Link inválido">{r.motivo}</Aviso></div>}
        {r && r.valido && (aceito || r.aceito) && (
          <div className="mt-6 space-y-3">
            <h1 className="text-3xl font-black">Confirmado, {r.primeiro_nome}.</h1>
            <p className="text-lg">Sua confirmação do lote ficou registrada, presa a estas condições. A loja vendedora conclui o registro e cada aparelho passa para o nome da sua loja.</p>
            <p className="text-sm text-slate-600">Você não precisa fazer mais nada.</p>
          </div>
        )}
        {r && r.valido && !aceito && !r.aceito && (
          <div className="mt-4 space-y-5">
            <h1 className="text-3xl font-black leading-tight">Olá, {r.primeiro_nome}. Confirme a compra deste lote de {r.itens?.length} aparelho(s).</h1>
            <div className="rounded-xl border-2 border-slate-200 p-4 space-y-3">
              <p><span className="text-slate-500 text-sm block">Loja vendedora</span>{r.loja}</p>
              <ul className="divide-y text-sm" data-testid="itens-lote">
                {r.itens?.map((i, n) => (
                  <li key={n} className="flex flex-wrap gap-x-3 py-2"><span className="flex-1 font-semibold">{i.aparelho}</span><span className="font-mono text-xs text-slate-600">IMEI {i.imei_mascarado}</span><span>{i.valor}</span></li>
                ))}
              </ul>
              <p className="text-lg"><span className="text-slate-500 text-sm block">Total</span><strong>{r.total}</strong> · {r.forma_pagamento}</p>
              <ul className="text-sm text-slate-700 list-disc pl-5">
                <li>Estado declarado: {r.estado_aparelho}</li>
                <li>Garantia: {r.garantia}</li>
                <li>Conjunto {r.impressao}… — se qualquer item mudar, este link deixa de valer</li>
              </ul>
            </div>
            <p className="text-sm text-slate-600">Ao confirmar, você declara que leu estas condições. Se algo estiver diferente do combinado, não confirme — fale com a loja vendedora.</p>
            {!enviado ? (
              <Botao grande onClick={pedir} disabled={ocupado}>{ocupado ? "Enviando…" : "Receber código no meu WhatsApp"}</Botao>
            ) : (
              <form onSubmit={confirmar} className="space-y-3">
                <p className="font-semibold">Código enviado para {enviado}. Vale por 10 minutos.</p>
                <Campo inputMode="numeric" autoFocus autoComplete="one-time-code" maxLength={6} className="text-center font-mono text-3xl tracking-[0.5em]" value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ""))} />
                <Erro>{erro}</Erro>
                <Botao type="submit" grande disabled={ocupado || codigo.length !== 6}>Confirmar o lote</Botao>
                <button type="button" className="w-full text-sm underline text-slate-600" onClick={pedir} disabled={ocupado}>Não chegou? Enviar de novo</button>
              </form>
            )}
            {!enviado && <Erro>{erro}</Erro>}
          </div>
        )}
        <p className="mt-10 text-xs text-slate-500">O Cartório registra passagens declaradas e verificadas na data indicada. Não é órgão público e não substitui boletim de ocorrência, nota fiscal ou vistoria técnica.</p>
      </div>
    </div>
  );
}
