// /aceite/:token — aberta pelo cliente NO CELULAR DELE. Sem login, sem sessão,
// de propósito: é isso que impede o operador de completar o aceite estando logado.

import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { api, type ResumoAceitePublico } from "@/api/index.ts";
import { Aviso, Botao, Campo, Carregando, Erro } from "@/components/ui.tsx";
import { mensagemDeErro } from "@/lib/session.tsx";

export function Aceite() {
  const { token = "" } = useParams();
  const [r, setR] = useState<ResumoAceitePublico | null>(null);
  const [codigo, setCodigo] = useState("");
  const [enviado, setEnviado] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [aceito, setAceito] = useState(false);

  useEffect(() => { api.aceitePublico.resumo(token).then(setR).catch((e) => setR({ valido: false, motivo: mensagemDeErro(e) })); }, [token]);

  async function pedir() {
    setErro(null); setOcupado(true);
    try { const x = await api.aceitePublico.pedirCodigo(token); setEnviado(x.destino_mascarado); } catch (e) { setErro(mensagemDeErro(e)); } finally { setOcupado(false); }
  }
  async function confirmar(e: FormEvent) {
    e.preventDefault(); setErro(null); setOcupado(true);
    try { const x = await api.aceitePublico.confirmar(token, codigo); if (x.aceito) setAceito(true); } catch (err) { setErro(mensagemDeErro(err)); } finally { setOcupado(false); }
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
            <p className="text-lg">Sua confirmação ficou registrada, presa a esta versão das condições. A loja conclui o registro na tela dela.</p>
            <p className="text-sm text-slate-600">Você não precisa fazer mais nada. Guarde esta tela se quiser.</p>
          </div>
        )}
        {r && r.valido && !aceito && !r.aceito && (
          <div className="mt-4 space-y-5">
            <h1 className="text-3xl font-black leading-tight">Olá, {r.primeiro_nome}. Confirme a {r.papel === "seller" ? "venda" : "compra"} do seu aparelho.</h1>
            <div className="rounded-xl border-2 border-slate-200 p-4 space-y-2 text-lg">
              <p><span className="text-slate-500 text-sm block">Loja</span>{r.loja}</p>
              <p><span className="text-slate-500 text-sm block">Aparelho</span>{r.aparelho} · IMEI {r.imei_mascarado}</p>
              <p><span className="text-slate-500 text-sm block">Valor</span><strong>{r.valor}</strong> · {r.forma_pagamento}</p>
              <ul className="text-sm text-slate-700 list-disc pl-5">{r.resumo_termos?.map((t, i) => <li key={i}>{t}</li>)}</ul>
            </div>
            <p className="text-sm text-slate-600">Ao confirmar, você declara que leu estas condições e que as informações sobre o aparelho são verdadeiras. Se algo estiver diferente do combinado, não confirme — fale com a loja.</p>
            {!enviado ? (
              <Botao grande onClick={pedir} disabled={ocupado}>{ocupado ? "Enviando…" : "Receber código no meu WhatsApp"}</Botao>
            ) : (
              <form onSubmit={confirmar} className="space-y-3">
                <p className="font-semibold">Código enviado para {enviado}. Vale por 10 minutos.</p>
                <Campo inputMode="numeric" autoFocus autoComplete="one-time-code" maxLength={6} className="text-center font-mono text-3xl tracking-[0.5em]" value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ""))} />
                <Erro>{erro}</Erro>
                <Botao type="submit" grande disabled={ocupado || codigo.length !== 6}>Confirmar</Botao>
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
