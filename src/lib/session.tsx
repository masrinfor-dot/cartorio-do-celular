import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type Session } from "@/api/index.ts";

interface Ctx { sessao: Session | null; carregando: boolean; recarregar: () => Promise<void> }
const SessionCtx = createContext<Ctx>({ sessao: null, carregando: true, recarregar: async () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [sessao, setSessao] = useState<Session | null>(null);
  const [carregando, setCarregando] = useState(true);
  const recarregar = async () => { setSessao(await api.auth.session()); };
  useEffect(() => {
    recarregar().finally(() => setCarregando(false));
    return api.auth.onChange((s) => setSessao(s));
  }, []);
  return <SessionCtx.Provider value={{ sessao, carregando, recarregar }}>{children}</SessionCtx.Provider>;
}

export const useSession = () => useContext(SessionCtx);

/** Mensagem de erro para o operador — nunca stack trace. */
export function mensagemDeErro(e: unknown): string {
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") return (e as { message: string }).message;
  return "Algo deu errado. Tente de novo.";
}
