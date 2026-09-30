// /passaporte e /passaporte/:imei — a linha do tempo pública. Sem login, sem
// dado pessoal. Leve: precisa abrir em 3G, num celular de entrada.

import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type PassaporteResultado } from "@/api/index.ts";
import { imeiValido, onlyDigits } from "@core/index.ts";
import { Aviso, Botao, Campo, Carregando, Erro } from "@/components/ui.tsx";
import { LinhaDoTempo } from "./FluxoTransacao.tsx";

export function Passaporte() {
  const { imei = "" } = useParams();
  const nav = useNavigate();
  const [busca, setBusca] = useState(imei);
  const [erro, setErro] = useState<string | null>(null);
  const [r, setR] = useState<PassaporteResultado | null>(null);
  const [carregando, setCarregando] = useState(false);

  useEffect(() => {
    if (!imei) { setR(null); return; }
    setCarregando(true);
    api.publico.passaporte(imei).then(setR).finally(() => setCarregando(false));
  }, [imei]);

  function enviar(e: FormEvent) {
    e.preventDefault();
    const d = onlyDigits(busca);
    if (!imeiValido(d)) { setErro("Esse IMEI não confere. Confira os 15 dígitos — disque *#06# no aparelho."); return; }
    setErro(null);
    nav(`/passaporte/${d}`);
  }

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <div>
        <h1 className="text-2xl font-black tracking-tight">Passaporte do aparelho</h1>
        <p className="text-slate-600">Consulte o histórico de passagens de um celular pelo IMEI. Não precisa de conta.</p>
      </div>
      <form onSubmit={enviar} className="flex gap-2">
        <Campo inputMode="numeric" placeholder="IMEI — 15 dígitos" className="font-mono" value={busca} onChange={(e) => setBusca(e.target.value)} erro={erro} autoFocus={!imei} />
        <Botao type="submit">Consultar</Botao>
      </form>
      <Erro>{erro}</Erro>
      {carregando && <Carregando />}
      {r && !r.encontrado && <Aviso tom="neutro" titulo="Sem registro">{r.aviso}</Aviso>}
      {r && r.encontrado && r.ocorrencia_ativa && (
        <Aviso tom="bloqueio" titulo={`Consta declaração de ${r.ocorrencia_ativa.tipo} pelo titular registrado`}>
          Declarada em {new Date(r.ocorrencia_ativa.declarada_em).toLocaleDateString("pt-BR")}{r.ocorrencia_ativa.bo_numero ? `, boletim de ocorrência nº ${r.ocorrencia_ativa.bo_numero}` : ", sem número de boletim informado"}{r.ocorrencia_ativa.cidade ? ` (${r.ocorrencia_ativa.cidade}${r.ocorrencia_ativa.uf ? "/" + r.ocorrencia_ativa.uf : ""})` : ""}. É uma declaração do titular, não uma verificação do Cartório. Nenhuma transferência deste aparelho conclui enquanto a declaração estiver ativa. Canal oficial: Celular Seguro (gov.br).
        </Aviso>
      )}
      {r && r.encontrado && (
        <div className="cartao space-y-4">
          <div className="flex items-baseline gap-4">
            <p className="font-mono text-lg">IMEI {r.imei_mascarado}</p>
            <p className="ml-auto text-3xl font-black">{r.elos} <span className="text-sm font-semibold text-slate-600">elo(s)</span></p>
          </div>
          <LinhaDoTempo eventos={r.linha_do_tempo ?? []} />
          {r.linha_do_tempo?.some((e) => e.tipo === "transfer_completed" && e.dados.aceite === "assistido") && (
            <Aviso tom="alerta" titulo="Há passagem com aceite presencial assistido">Em ao menos uma passagem, a parte confirmou no aparelho do operador da loja, e não no próprio celular. É prova de grau menor — está dito aqui porque prova mais fraca escondida não é prova mais fraca, é fraude com passos a mais.</Aviso>
          )}
          <Aviso tom="neutro">{r.limites}</Aviso>
        </div>
      )}
      <p className="text-xs text-slate-500">Uma consulta é do instante em que foi feita e não diz nada sobre o instante seguinte. Furto sem boletim de ocorrência não aparece em base nenhuma.</p>
    </div>
  );
}
