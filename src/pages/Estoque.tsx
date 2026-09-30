import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type EstoqueItem } from "@/api/index.ts";
import { Carregando, formatarData, Botao } from "@/components/ui.tsx";

export function Estoque() {
  const [lista, setLista] = useState<EstoqueItem[] | null>(null);
  useEffect(() => { api.estoque.listar().then(setLista); }, []);
  if (!lista) return <Carregando />;
  return (
    <div>
      <h1 className="text-2xl font-black tracking-tight mb-1">Aparelhos de que a loja é titular</h1>
      <p className="text-slate-600 mb-4">A revenda parte daqui. É o segundo elo que transforma uma lista de compras em uma corrente.</p>
      {lista.length === 0 && <p className="text-slate-600">Nenhum aparelho ainda. Conclua uma entrada no balcão.</p>}
      <ul className="space-y-2">
        {lista.map((i) => (
          <li key={i.device.device_id} className="cartao flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-semibold">{[i.device.brand, i.device.model, i.device.storage, i.device.color].filter(Boolean).join(" ") || "Aparelho"}</span>
            <span className="font-mono text-sm">IMEI {i.device.imei_mascarado}</span>
            <span className="text-xs text-slate-500">titular desde {formatarData(i.desde)}</span>
            {i.protocolo_entrada && <span className="text-xs text-slate-500">entrada {i.protocolo_entrada}</span>}
            <Link className="ml-auto" to={`/revenda/${i.device.device_id}`}><Botao variante="secundario">Revender</Botao></Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
