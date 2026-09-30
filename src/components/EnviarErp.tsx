// Botão "Enviar ao ERP" — manda a compra/venda concluída para o Sheik Company
// ERP (que é quem emite a NF-e). Mostra o que já foi enviado.
import { useEffect, useState } from "react";
import { api, type ErpEnvio } from "@/api/index.ts";
import { Botao, formatarData } from "@/components/ui.tsx";
import { mensagemDeErro } from "@/lib/session.tsx";

export function EnviarErp({ transaction_id, compacto }: { transaction_id: string; compacto?: boolean }) {
  const [envios, setEnvios] = useState<ErpEnvio[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => { api.erp.envios(transaction_id).then(setEnvios).catch(() => {}); }, [transaction_id]);
  const ultimo = envios[0];
  async function enviar() {
    setErro(null); setOcupado(true);
    try { const e = await api.erp.enviar(transaction_id); setEnvios([e, ...envios]); } catch (e) { setErro(mensagemDeErro(e)); } finally { setOcupado(false); }
  }
  return (
    <div className={compacto ? "inline-flex flex-col items-start" : "flex flex-col items-center gap-1"}>
      {ultimo ? (
        <span className="text-xs text-slate-600">ERP: {ultimo.erp_ref ?? "—"} · NF-e: {ultimo.nfe_status ?? "—"} · {formatarData(ultimo.created_at)}</span>
      ) : (
        <Botao variante="secundario" className={compacto ? "!px-2 !py-1 !text-sm" : ""} disabled={ocupado} onClick={enviar}>{ocupado ? "Enviando…" : "Enviar ao ERP (NF-e)"}</Botao>
      )}
      {erro && <span className="text-xs text-red-700">{erro}</span>}
    </div>
  );
}
