// Copia dist/index.html para dist/404.html: hosts estáticos (GitHub Pages)
// servem o 404.html para rotas desconhecidas, e o app continua abrindo em
// /aceite/<token> no celular do cliente.
import { copyFileSync, existsSync } from "node:fs";
if (existsSync("dist/index.html")) copyFileSync("dist/index.html", "dist/404.html");
