import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, MODO_DEMO } from "@/api/index.ts";
import { Botao, Campo, Erro, Rotulo, Aviso } from "@/components/ui.tsx";
import { mensagemDeErro, useSession } from "@/lib/session.tsx";

export function Entrar() {
  const [modo, setModo] = useState<"entrar" | "criar">("entrar");
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const nav = useNavigate();
  const { recarregar } = useSession();

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setErro(null);
    setOcupado(true);
    try {
      const s = modo === "entrar" ? await api.auth.signIn(email, senha) : await api.auth.signUp(email, senha);
      await recarregar();
      nav(s.store ? "/balcao" : "/loja/nova");
    } catch (err) {
      setErro(mensagemDeErro(err));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-3xl font-black tracking-tight mb-1">{modo === "entrar" ? "Entrar" : "Criar conta"}</h1>
      <p className="text-slate-600 mb-6">Registro de procedência de celulares usados.</p>
      {MODO_DEMO && (
        <div className="mb-4">
          <Aviso tom="info" titulo="Demonstração">Crie qualquer e-mail e senha — a conta fica só neste navegador.</Aviso>
        </div>
      )}
      <form onSubmit={enviar} className="cartao space-y-4">
        <div>
          <Rotulo htmlFor="email" obrigatorio>E-mail</Rotulo>
          <Campo id="email" type="email" autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <Rotulo htmlFor="senha" obrigatorio>Senha</Rotulo>
          <Campo id="senha" type="password" autoComplete={modo === "entrar" ? "current-password" : "new-password"} value={senha} onChange={(e) => setSenha(e.target.value)} required minLength={6} />
        </div>
        <Erro>{erro}</Erro>
        <Botao type="submit" grande disabled={ocupado}>{ocupado ? "Aguarde…" : modo === "entrar" ? "Entrar" : "Criar conta"}</Botao>
        <button type="button" className="w-full text-sm text-teal-800 underline" onClick={() => setModo(modo === "entrar" ? "criar" : "entrar")}>
          {modo === "entrar" ? "Ainda não tenho conta" : "Já tenho conta"}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-600">
        Só quer consultar um aparelho? <a className="text-teal-800 underline" href="/passaporte">Consultar passaporte</a>
      </p>
    </div>
  );
}
