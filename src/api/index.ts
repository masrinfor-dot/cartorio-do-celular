import type { RegistryApi } from "./types.ts";
import { demoApi } from "./demo.ts";
import { demoAvaliacaoApi } from "./demoAvaliacao.ts";
import { supabaseApi } from "./supabase.ts";

const modo = (import.meta.env.VITE_BACKEND as string | undefined) === "supabase" ? "supabase" : "demo";

const demoCompleto: RegistryApi = { ...demoApi, ...demoAvaliacaoApi };

export const api: RegistryApi = modo === "supabase" ? supabaseApi : demoCompleto;
export const MODO_DEMO = modo === "demo";
export * from "./types.ts";
