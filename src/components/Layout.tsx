import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { api, MODO_DEMO } from "@/api/index.ts";
import { useSession } from "@/lib/session.tsx";
import { Logotipo } from "@/components/Logo.tsx";

export function Layout() {
  const { sessao } = useSession();
  const nav = useNavigate();
  const link = ({ isActive }: { isActive: boolean }) =>
    `rounded-md px-3 py-2 text-sm font-semibold ${isActive ? "bg-white/15 text-white" : "text-slate-200 hover:text-white"}`;
  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-teal-700 text-slate-100">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">
          <NavLink to="/" aria-label="Cartório do Celular — início"><Logotipo sobreEscuro /></NavLink>
          {sessao?.store && (
            <nav className="hidden sm:flex items-center gap-1 ml-2">
              <NavLink to="/avaliacao" className={link}>Comprar</NavLink>
              <NavLink to="/estoque" className={link}>Vender (PDV)</NavLink>
              <NavLink to="/compras" className={link}>Compras</NavLink>
              <NavLink to="/registros" className={link}>Registros</NavLink>
              <NavLink to="/passaporte" className={link}>Consultar</NavLink>
              <NavLink to="/configuracoes" className={link}>Config</NavLink>
              {MODO_DEMO && <NavLink to="/demo/celular" className={link}>📱 Celular do cliente</NavLink>}
            </nav>
          )}
          <div className="ml-auto flex items-center gap-3 text-sm">
            {sessao?.store && <span className="hidden md:inline font-semibold">{sessao.store.name}</span>}
            {sessao && <span className="text-slate-300 hidden md:inline">{sessao.email}</span>}
            {sessao && (
              <button className="rounded-md border border-slate-600 px-2 py-1 text-xs hover:bg-white/10" onClick={() => api.auth.signOut().then(() => nav("/entrar"))}>Sair</button>
            )}
          </div>
        </div>
        {sessao?.store && (
          <nav className="sm:hidden flex gap-1 overflow-x-auto px-3 pb-2">
            <NavLink to="/avaliacao" className={link}>Comprar</NavLink>
            <NavLink to="/estoque" className={link}>Vender</NavLink>
            <NavLink to="/compras" className={link}>Compras</NavLink>
            <NavLink to="/registros" className={link}>Registros</NavLink>
            <NavLink to="/passaporte" className={link}>Consultar</NavLink>
            <NavLink to="/configuracoes" className={link}>Config</NavLink>
            {MODO_DEMO && <NavLink to="/demo/celular" className={link}>📱 Celular</NavLink>}
          </nav>
        )}
      </header>
      {MODO_DEMO && (
        <div className="bg-amber-200 text-amber-950 text-center text-xs font-semibold py-1 px-3">
          MODO DEMONSTRAÇÃO — dados sintéticos, tudo roda neste navegador. Nenhum CPF real deve entrar aqui.
        </div>
      )}
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        <Outlet />
      </main>
      <footer className="px-4 py-4 text-center text-xs text-slate-500">
        O Cartório registra passagens declaradas e verificadas na data indicada. Não é órgão público e não substitui boletim de ocorrência, nota fiscal ou vistoria técnica.
      </footer>
    </div>
  );
}
