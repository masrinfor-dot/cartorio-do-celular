import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/api/index.ts";
import { Botao, Campo, Erro, Rotulo } from "@/components/ui.tsx";
import { mensagemDeErro, useSession } from "@/lib/session.tsx";

export function NovaLoja() {
  const [f, setF] = useState({ nome: "", cnpj: "", cidade: "", uf: "" });
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const nav = useNavigate();
  const { recarregar } = useSession();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setErro(null);
    setOcupado(true);
    try {
      await api.loja.criar(f);
      await recarregar();
      nav("/balcao");
    } catch (err) {
      setErro(mensagemDeErro(err));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-3xl font-black tracking-tight mb-1">Cadastrar a loja</h1>
      <p className="text-slate-600 mb-6">A loja é quem registra as entradas no balcão. Ela também figura como parte nas transações.</p>
      <form onSubmit={enviar} className="cartao space-y-4">
        <div>
          <Rotulo htmlFor="nome" obrigatorio>Nome da loja</Rotulo>
          <Campo id="nome" autoFocus value={f.nome} onChange={set("nome")} required />
        </div>
        <div>
          <Rotulo htmlFor="cnpj" obrigatorio>CNPJ</Rotulo>
          <Campo id="cnpj" inputMode="numeric" placeholder="00.000.000/0000-00" value={f.cnpj} onChange={set("cnpj")} required />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <Rotulo htmlFor="cidade">Cidade</Rotulo>
            <Campo id="cidade" value={f.cidade} onChange={set("cidade")} />
          </div>
          <div>
            <Rotulo htmlFor="uf">UF</Rotulo>
            <Campo id="uf" maxLength={2} value={f.uf} onChange={set("uf")} />
          </div>
        </div>
        <Erro>{erro}</Erro>
        <Botao type="submit" grande disabled={ocupado}>{ocupado ? "Aguarde…" : "Cadastrar loja"}</Botao>
      </form>
    </div>
  );
}
