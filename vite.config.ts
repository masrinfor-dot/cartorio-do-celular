import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const root = import.meta.dirname;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
      "@core": path.resolve(root, "supabase/functions/_shared/core"),
    },
  },
  server: {
    fs: { allow: [path.resolve(root)] },
    port: 5173,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
