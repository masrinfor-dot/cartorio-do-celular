import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import "./index.css";
import { MODO_DEMO } from "@/api/index.ts";
import { SessionProvider, useSession } from "@/lib/session.tsx";
import { Layout } from "@/components/Layout.tsx";
import { Carregando } from "@/components/ui.tsx";
import { Entrar } from "@/pages/Entrar.tsx";
import { NovaLoja } from "@/pages/NovaLoja.tsx";
import { Registros } from "@/pages/Registros.tsx";
import { Estoque } from "@/pages/Estoque.tsx";
import { FluxoTransacao } from "@/pages/FluxoTransacao.tsx";
import { Aceite } from "@/pages/Aceite.tsx";
import { Passaporte } from "@/pages/Passaporte.tsx";
import { Certificado } from "@/pages/Certificado.tsx";
import { DemoCelular } from "@/pages/DemoCelular.tsx";

function Protegida() {
  const { sessao, carregando } = useSession();
  if (carregando) return <Carregando />;
  if (!sessao) return <Navigate to="/entrar" replace />;
  if (!sessao.store) return <Navigate to="/loja/nova" replace />;
  return <Outlet />;
}

function Inicio() {
  const { sessao, carregando } = useSession();
  if (carregando) return <Carregando />;
  return <Navigate to={sessao?.store ? "/balcao" : sessao ? "/loja/nova" : "/entrar"} replace />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SessionProvider>
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <Routes>
          {/* Pública, sem layout e sem sessão: o cliente abre no celular dele */}
          <Route path="/aceite/:token" element={<Aceite />} />
          <Route element={<Layout />}>
            <Route index element={<Inicio />} />
            <Route path="/entrar" element={<Entrar />} />
            <Route path="/loja/nova" element={<NovaLoja />} />
            <Route path="/passaporte" element={<Passaporte />} />
            <Route path="/passaporte/:imei" element={<Passaporte />} />
            <Route path="/certificado/:protocolo" element={<Certificado />} />
            <Route element={<Protegida />}>
              <Route path="/balcao" element={<FluxoTransacao kind="pf_pj" />} />
              <Route path="/revenda" element={<FluxoTransacao kind="pj_pf" />} />
              <Route path="/revenda/:deviceId" element={<FluxoTransacao kind="pj_pf" />} />
              <Route path="/registros" element={<Registros />} />
              <Route path="/estoque" element={<Estoque />} />
              {MODO_DEMO && <Route path="/demo/celular" element={<DemoCelular />} />}
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  </StrictMode>,
);
