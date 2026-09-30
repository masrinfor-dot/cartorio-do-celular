// /certificado/:protocolo — validação pública. Mesma regra de PII da página pública.

import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import QRCode from "qrcode";
import { api, type CertificadoView } from "@/api/index.ts";
import { Aviso, Carregando, Selo, formatarData } from "@/components/ui.tsx";

const ROTULO_DECL: Record<string, string> = { conta_icloud_google: "Conta iCloud / Google", origem: "Origem declarada" };
const ROTULO_VALOR: Record<string, string> = { desvinculada: "desvinculada", vinculada: "ainda vinculada", nao_verificado: "não verificado", compra_com_nota: "compra com nota fiscal", compra_sem_nota: "compra sem nota fiscal", presente: "presente", outra: "outra" };
const ROTULO_KIND = { pf_pj: "Entrada: pessoa física → loja", pj_pf: "Revenda: loja → pessoa física", pf_pf: "Pessoa física → pessoa física", pj_pj: "Loja → loja" };

export function Certificado() {
  const { protocolo = "" } = useParams();
  const [c, setC] = useState<CertificadoView | null | undefined>(undefined);
  const [qr, setQr] = useState<string>("");

  useEffect(() => {
    api.publico.certificado(protocolo).then(setC);
  }, [protocolo]);
  useEffect(() => {
    if (!c) return;
    QRCode.toDataURL(`${location.origin}/certificado/${c.protocolo}`, { margin: 1, width: 160 }).then(setQr);
  }, [c]);

  if (c === undefined) return <Carregando />;
  if (c === null) return <div className="mx-auto max-w-xl"><Aviso tom="neutro" titulo="Não encontramos esse protocolo.">Confira os 10 caracteres. Protocolos não são sequenciais.</Aviso></div>;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="cartao print:shadow-none print:border-0 space-y-5">
        <div className="flex items-start gap-4">
          <div className="flex-1">
            <p className="text-xs font-bold uppercase tracking-wide text-teal-800">Cartório do Celular · Certificado de registro</p>
            <p className="font-mono text-4xl font-black tracking-[0.15em] mt-1">{c.protocolo}</p>
            <p className="text-sm text-slate-600 mt-1">{ROTULO_KIND[c.kind]} · emitido em {formatarData(c.emitido_em)}</p>
            <div className="mt-2"><Selo tipo={c.grade === "assistido" ? "assistido" : "forte"} /></div>
          </div>
          {qr && <img src={qr} alt="QR Code deste certificado" width={120} height={120} className="rounded" />}
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <dt className="text-slate-500">Aparelho</dt><dd className="font-semibold">{c.aparelho || "—"} · IMEI {c.imei_mascarado}</dd>
          <dt className="text-slate-500">Loja</dt><dd className="font-semibold">{c.loja}</dd>
          <dt className="text-slate-500">Vendedor</dt><dd className="font-semibold">{c.vendedor}</dd>
          <dt className="text-slate-500">Comprador</dt><dd className="font-semibold">{c.comprador}</dd>
          <dt className="text-slate-500">Valor</dt><dd className="font-semibold">{c.valor} · {c.forma_pagamento}</dd>
          <dt className="text-slate-500">Garantia</dt><dd className="font-semibold">{c.garantia}</dd>
        </dl>

        <section>
          <h2 className="mb-2 font-bold flex items-center gap-2">O que foi verificado <Selo tipo="verificado" /></h2>
          <ul className="space-y-1 text-sm">
            {c.verificado.map((v, i) => <li key={i} className="flex flex-col gap-0.5 rounded bg-teal-50 px-3 py-2 sm:flex-row sm:gap-2"><span className="flex-1">{v.item}</span><span className="text-xs text-slate-600 sm:text-sm sm:whitespace-nowrap">{formatarData(v.data)} · {v.fonte}</span></li>)}
          </ul>
        </section>
        <section>
          <h2 className="mb-2 font-bold flex items-center gap-2">O que foi declarado <Selo tipo="declarado" /></h2>
          <ul className="space-y-1 text-sm">
            {c.declarado.map((d, i) => <li key={i} className="flex gap-2 rounded bg-amber-50 px-3 py-2"><span className="flex-1">{ROTULO_DECL[d.item] ?? d.item}</span><span className="text-slate-700">{ROTULO_VALOR[d.valor] ?? d.valor}</span></li>)}
          </ul>
          <p className="mt-1 text-xs text-slate-500">Declarações são afirmações das partes registradas como tal. O Cartório não as verificou.</p>
        </section>

        {c.grade === "assistido" && <Aviso tom="alerta" titulo="Aceite presencial assistido">Ao menos uma parte confirmou no aparelho do operador da loja, não no próprio celular. Prova de grau menor.</Aviso>}

        <footer className="border-t pt-3 text-xs text-slate-500 space-y-1">
          <p className="font-mono break-all">hash {c.content_hash}</p>
          <p>O Cartório registra passagens declaradas e verificadas na data indicada. Não é órgão público e não substitui boletim de ocorrência, nota fiscal ou vistoria técnica.</p>
        </footer>
      </div>
      <div className="mt-3 text-center print:hidden"><button className="text-sm underline text-teal-800" onClick={() => window.print()}>Imprimir / salvar em PDF</button></div>
    </div>
  );
}
