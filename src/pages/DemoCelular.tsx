// Só na demonstração: representa o WhatsApp do CLIENTE. É aqui — e só aqui —
// que o código de 6 dígitos aparece, porque esta tela é o celular dele.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { demoWhatsapp, demoAdmin } from "@/api/demo.ts";
import { Aviso, Botao, formatarData } from "@/components/ui.tsx";

export function DemoCelular() {
  const [msgs, setMsgs] = useState(demoWhatsapp.mensagens());
  const [stats, setStats] = useState(demoAdmin.estatisticas());
  const nav = useNavigate();
  useEffect(() => {
    const id = setInterval(() => { setMsgs(demoWhatsapp.mensagens()); setStats(demoAdmin.estatisticas()); }, 1500);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-2xl font-black tracking-tight">📱 Celular do cliente (simulado)</h1>
      <Aviso tom="info">Esta tela faz as vezes do WhatsApp do vendedor/comprador. Em produção, a mensagem vai pelo bridge de WhatsApp da loja — e o operador nunca vê o código.</Aviso>
      <div className="rounded-2xl bg-[#e5ddd5] p-3 space-y-2 min-h-64">
        {msgs.length === 0 && <p className="text-center text-sm text-slate-600 py-10">Nenhuma mensagem ainda. Envie um convite no balcão.</p>}
        {msgs.map((m) => (
          <div key={m.id} className="rounded-lg bg-white px-3 py-2 shadow-sm text-sm">
            <p className="text-[11px] text-slate-500">para {m.to_masked} · {formatarData(m.at)}</p>
            <p className="whitespace-pre-wrap break-words">{linkar(m.text)}</p>
          </div>
        ))}
      </div>
      <div className="cartao text-sm grid grid-cols-2 gap-2">
        <p><span className="block text-xs text-slate-500">Aparelhos</span><strong>{stats.aparelhos}</strong></p>
        <p><span className="block text-xs text-slate-500">Densidade (IMEIs com &gt;1 elo)</span><strong>{stats.densidade}</strong></p>
        <p><span className="block text-xs text-slate-500">Transações</span><strong>{stats.transacoes}</strong></p>
        <p><span className="block text-xs text-slate-500">Aceites assistidos</span><strong>{stats.aceitesAssistidos}</strong></p>
      </div>
      <div className="flex gap-2">
        <Botao variante="secundario" onClick={() => { demoWhatsapp.limpar(); setMsgs([]); }}>Limpar mensagens</Botao>
        <Botao variante="perigo" onClick={() => { if (confirm("Apagar TODOS os dados da demonstração?")) { demoAdmin.zerar(); nav("/entrar"); } }}>Zerar demonstração</Botao>
      </div>
    </div>
  );
}

function linkar(texto: string) {
  const partes = texto.split(/(https?:\/\/\S+)/g);
  return partes.map((p, i) => (/^https?:\/\//.test(p) ? <a key={i} href={p} target="_blank" rel="noreferrer" className="text-sky-700 underline break-all">{p}</a> : p));
}
