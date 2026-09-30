// Nota de compra (/compras/:id/nota) e nota de venda (/vendas/:txId/nota) —
// mesmo layout da nota do CRM, mais protocolo, QR e o que foi verificado.
// Páginas próprias (sem layout) para imprimir direto do navegador.

import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import QRCode from "qrcode";
import { api, type NotaCompra as NotaCompraT, type NotaVenda as NotaVendaT } from "@/api/index.ts";
import { Aviso, Carregando, formatarData } from "@/components/ui.tsx";
import { mensagemDeErro } from "@/lib/session.tsx";

const css = `
  @page { margin: 14mm; }
  .nota { font-family: Arial, Helvetica, sans-serif; color: #111; max-width: 760px; margin: 0 auto; padding: 24px; }
  .nota h1 { font-size: 20px; margin: 0 0 2px; }
  .nota .sub { font-size: 11px; color: #666; margin: 0 0 18px; }
  .nota table { width: 100%; border-collapse: collapse; }
  .nota td { padding: 7px 4px; border-bottom: 1px solid #ddd; font-size: 13px; vertical-align: top; }
  .nota td:first-child { font-weight: bold; width: 38%; color: #444; }
  .nota .sec { margin-top: 18px; page-break-inside: avoid; }
  .nota .sec h2 { font-size: 12px; font-weight: bold; color: #444; margin: 0 0 6px; text-transform: uppercase; letter-spacing: .04em; }
  .nota .pgrid { display: flex; flex-wrap: wrap; gap: 8px; }
  .nota .pgrid img { width: 130px; height: 130px; object-fit: cover; border: 1px solid #ccc; border-radius: 4px; }
  .nota .sign { margin-top: 60px; display: flex; justify-content: space-between; gap: 24px; }
  .nota .sign div { flex: 1; text-align: center; border-top: 1px solid #333; padding-top: 6px; font-size: 11px; }
  .nota .proto { display: flex; align-items: center; gap: 14px; border: 2px solid #0f766e; border-radius: 8px; padding: 10px 14px; margin: 14px 0; }
  .nota .proto b { font-family: monospace; font-size: 22px; letter-spacing: .12em; }
  .nota .aviso { font-size: 10px; color: #666; margin-top: 16px; }
  .nota .decl { font-size: 11px; margin-top: 14px; line-height: 1.4; }
  .barra { position: sticky; top: 0; background: #f1f5f9; padding: 8px; text-align: center; }
  @media print { .barra { display: none; } .nota { padding: 0; } }
`;

function Barra() {
  return <div className="barra print:hidden"><button className="btn btn-primario !py-2 !text-base" onClick={() => window.print()}>Imprimir / salvar em PDF</button></div>;
}

export function NotaCompra() {
  const { id = "" } = useParams();
  const [n, setN] = useState<NotaCompraT | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [qr, setQr] = useState("");
  useEffect(() => { api.avaliacao.notaCompra(id).then(setN).catch((e) => setErro(mensagemDeErro(e))); }, [id]);
  useEffect(() => { if (n?.link_certificado) QRCode.toDataURL(n.link_certificado, { margin: 1, width: 110 }).then(setQr); }, [n]);
  if (erro) return <div className="p-6"><Aviso tom="bloqueio">{erro}</Aviso></div>;
  if (!n) return <div className="p-6"><Carregando /></div>;
  const pix = /pix/i.test(n.forma_pagamento);
  const linhas: Array<[string, string]> = [
    ["Aparelho", n.aparelho.descricao], ["Marca", n.aparelho.marca], ["Modelo", n.aparelho.modelo],
    ["Loja", n.loja.nome], ["Nome do vendedor", n.vendedor.nome], ["CPF", n.vendedor.cpf], ["RG", n.vendedor.rg ?? "—"],
    ["Endereço", n.vendedor.endereco ?? "—"], ["Bairro", n.vendedor.bairro ?? "—"], ["Telefone", n.vendedor.telefone ?? "—"],
    ["IMEI do aparelho", n.aparelho.imei ?? "— (pendente)"], ["Valor pago", n.valor], ["Forma de pagamento", n.forma_pagamento],
    ...(pix ? ([["Chave Pix", n.pix_key ?? "—"], ["Titular da chave Pix", n.pix_key_holder ?? "—"]] as Array<[string, string]>) : []),
    ["Data", formatarData(n.data)],
  ];
  return (
    <div className="min-h-screen bg-white">
      <style>{css}</style>
      <Barra />
      <div className="nota">
        <h1>Nota de Compra de Aparelho Usado</h1>
        <p className="sub">{n.loja.nome} · CNPJ {n.loja.cnpj}{n.loja.cidade ? ` · ${n.loja.cidade}` : ""}</p>
        {n.protocolo ? (
          <div className="proto">
            {qr && <img src={qr} alt="QR do certificado" width={70} height={70} />}
            <div><div style={{ fontSize: 11, color: "#0f766e", fontWeight: 700 }}>REGISTRO NO CARTÓRIO DO CELULAR · aceite {n.aceite_grade}</div><b>{n.protocolo}</b><div style={{ fontSize: 11 }}>concluído em {formatarData(n.concluido_em)} · {n.link_certificado}</div></div>
          </div>
        ) : (
          <div className="proto" style={{ borderColor: "#d97706" }}><div><div style={{ fontSize: 11, color: "#92400e", fontWeight: 700 }}>REGISTRO NO CARTÓRIO AINDA NÃO CONCLUÍDO</div><div style={{ fontSize: 12 }}>{n.registro_estado ? `Situação: ${n.registro_estado}` : "Sem transação"}{!n.aparelho.imei ? " · IMEI pendente" : ""}</div></div></div>
        )}
        <table><tbody>{linhas.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table>
        {n.checklist.length > 0 && (
          <div className="sec"><h2>Estado declarado pelo vendedor</h2>
            <table><tbody>{n.checklist.map((c) => <tr key={c.pergunta}><td>{c.pergunta}</td><td>{c.resposta}</td></tr>)}</tbody></table>
          </div>
        )}
        {(["documento", "aparelho", "comprovante"] as const).map((k) => n.fotos[k].length > 0 && (
          <div className="sec" key={k}><h2>{{ documento: "Fotos do documento", aparelho: "Fotos do aparelho", comprovante: "Comprovante de pagamento" }[k]}</h2><div className="pgrid">{n.fotos[k].map((u, i) => <img key={i} src={u} alt="" />)}</div></div>
        ))}
        <p className="decl">Declaro que sou o legítimo proprietário do aparelho acima descrito, que ele não é produto de furto, roubo ou qualquer ilícito, que as informações de estado prestadas são verdadeiras, e que transfiro sua propriedade à loja compradora pelo valor e forma de pagamento indicados.</p>
        <div className="sign"><div>Assinatura do vendedor</div><div>Assinatura da loja</div></div>
        <p className="aviso">O Cartório do Celular registra passagens declaradas e verificadas na data indicada. Não é órgão público e não substitui boletim de ocorrência, nota fiscal ou vistoria técnica.</p>
      </div>
    </div>
  );
}

export function NotaVenda() {
  const { txId = "" } = useParams();
  const [n, setN] = useState<NotaVendaT | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [qr, setQr] = useState("");
  useEffect(() => { api.notaVenda(txId).then(setN).catch((e) => setErro(mensagemDeErro(e))); }, [txId]);
  useEffect(() => { if (n?.link_certificado) QRCode.toDataURL(n.link_certificado, { margin: 1, width: 110 }).then(setQr); }, [n]);
  if (erro) return <div className="p-6"><Aviso tom="bloqueio">{erro}</Aviso></div>;
  if (!n) return <div className="p-6"><Carregando /></div>;
  const linhas: Array<[string, string]> = [
    ["Aparelho", n.aparelho.descricao], ["IMEI", n.aparelho.imei], ["Loja vendedora", `${n.loja.nome} · CNPJ ${n.loja.cnpj}`],
    ["Comprador", n.comprador.nome], ["CPF", n.comprador.cpf], ["Telefone", n.comprador.telefone ?? "—"],
    ["Valor", n.valor], ["Forma de pagamento", n.forma_pagamento], ["Garantia", n.garantia],
    ["Estado declarado", n.estado_declarado], ["Defeitos declarados", n.defeitos_declarados],
    ["Consulta de procedência", n.consulta ? `${n.consulta.resultado === "clear" ? "sem restrição" : n.consulta.resultado} · ${n.consulta.fonte} · ${formatarData(n.consulta.data)}` : "—"],
    ["Data", formatarData(n.concluido_em)],
  ];
  return (
    <div className="min-h-screen bg-white">
      <style>{css}</style>
      <Barra />
      <div className="nota">
        <h1>Nota de Venda de Aparelho Usado</h1>
        <p className="sub">{n.loja.nome}{n.loja.cidade ? ` · ${n.loja.cidade}` : ""}</p>
        <div className="proto">
          {qr && <img src={qr} alt="QR do certificado" width={70} height={70} />}
          <div><div style={{ fontSize: 11, color: "#0f766e", fontWeight: 700 }}>TRANSFERÊNCIA DE TITULARIDADE · CARTÓRIO DO CELULAR · aceite {n.aceite_grade}</div><b>{n.protocolo}</b><div style={{ fontSize: 11 }}>{n.link_certificado}</div></div>
        </div>
        <table><tbody>{linhas.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table>
        <p className="decl">A loja declara que era a titular registrada do aparelho e que a consulta de procedência indicada foi feita na data informada. O comprador declara ter recebido o aparelho no estado descrito e confirmou a transferência pelo próprio celular. A titularidade passa ao comprador a partir desta data, conforme o registro acima.</p>
        <div className="sign"><div>Assinatura do comprador</div><div>Assinatura da loja</div></div>
        <p className="aviso">O Cartório do Celular registra passagens declaradas e verificadas na data indicada. Não é órgão público e não substitui boletim de ocorrência, nota fiscal ou vistoria técnica.</p>
      </div>
    </div>
  );
}
