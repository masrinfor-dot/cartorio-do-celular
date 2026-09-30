import type { RegistryApi } from "./types.ts";
import { demoApi } from "./demo.ts";
import { supabaseApi } from "./supabase.ts";

const modo = (import.meta.env.VITE_BACKEND as string | undefined) === "supabase" ? "supabase" : "demo";

export const api: RegistryApi = modo === "supabase" ? supabaseApi : demoApi;
export const MODO_DEMO = modo === "demo";
export * from "./types.ts";
