// E2E do lote PJ→PJ (modo demonstração). Roda: node tests/e2e-lote.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:5173";
mkdirSync("tests/shots", { recursive: true });
const vite = spawn("npx", ["vite", "--port", "5173", "--strictPort"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const ctx = await browser.newContext({ viewport: { width: 420, height: 860 } });
const page = await ctx.newPage();
const erros = [];
page.on("pageerror", (e) => erros.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") erros.push(m.text()); });
const ok = (m) => console.log("✔", m);

async function codigoMaisRecente() {
  const inbox = await ctx.newPage();
  await inbox.goto(BASE + "/demo/celular");
  const t = await inbox.locator("text=/Seu código do Cartório/").first().innerText();
  await inbox.close();
  return t.match(/(\d{6})/)[1];
}

async function comprar(modelo) {
  await page.goto(BASE + "/balcao");
  await page.fill("#cpf", "529.982.247-25");
  await page.waitForSelector("#nome:not([disabled])");
  if (!(await page.inputValue("#nome"))) await page.fill("#nome", "Maria da Silva");
  if (!(await page.inputValue("#tel"))) await page.fill("#tel", "31988881234");
  await page.click("button[type=submit]");
  await page.waitForSelector("#imei");
  await page.getByRole("button", { name: "sem restrição" }).click();
  await page.waitForSelector("#marca");
  await page.fill("#marca", "Apple"); await page.fill("#modelo", modelo); await page.fill("#arm", "128 GB"); await page.fill("#cor", "Azul");
  await page.click("button[type=submit]");
  await page.getByText("Sem restrição na consulta").waitFor();
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByText("preencher com fotos sintéticas").click();
  await page.waitForFunction(() => document.querySelectorAll("label img").length >= 3);
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.fill("#valor", "1000,00");
  await page.selectOption("#estado", "Bom");
  await page.click("button[type=submit]");
  await page.getByRole("button", { name: "Aceitar pela loja" }).click();
  await page.getByRole("button", { name: "Enviar código pelo WhatsApp" }).click();
  await page.getByText(/Link enviado para/).waitFor();
  const cel = await ctx.newPage();
  await cel.goto(BASE + "/demo/celular");
  const link = await cel.locator("a[href*='/aceite/']").first().getAttribute("href");
  await cel.goto(link);
  await cel.getByRole("button", { name: /Receber código/ }).click();
  await cel.getByText(/Código enviado para/).waitFor();
  await cel.fill("input[inputmode=numeric]", await codigoMaisRecente());
  await cel.getByRole("button", { name: "Confirmar" }).click();
  await cel.getByText(/Confirmado, /).waitFor();
  await cel.close();
  await page.getByText("As duas partes aceitaram").waitFor({ timeout: 8000 });
  await page.getByRole("button", { name: "Concluir registro" }).click();
  await page.getByText("Registro concluído").waitFor();
}

try {
  await page.goto(BASE + "/entrar");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByText("Ainda não tenho conta").click();
  await page.fill("#email", "loja@teste.com"); await page.fill("#senha", "123456");
  await page.click("button[type=submit]");
  await page.waitForURL("**/loja/nova");
  await page.fill("#nome", "Sheik Cell Praça"); await page.fill("#cnpj", "11.222.333/0001-81");
  await page.fill("#cidade", "Teófilo Otoni"); await page.fill("#uf", "MG");
  await page.click("button[type=submit]");
  await page.waitForURL("**/avaliacao");

  await comprar("iPhone 12"); ok("aparelho 1 em estoque");
  await comprar("iPhone 13"); ok("aparelho 2 em estoque");

  await page.goto(BASE + "/lote/novo");
  await page.getByText("Aparelhos (0 de 2)").waitFor();
  await page.fill("#lcnpj", "45.723.174/0001-10");
  await page.fill("#lnome", "Loja Parceira");
  await page.fill("#ltel", "33999990000");
  await page.getByRole("button", { name: "Marcar todos" }).click();
  await page.fill("#lpadrao", "1500,00");
  await page.getByRole("button", { name: "Aplicar" }).click();
  await page.fill("#lforma", "Pix"); await page.fill("#lgar", "90 dias");
  await page.getByText("Total do lote: R$ 3.000,00").waitFor();
  ok("seleção e total do lote");
  await page.getByRole("button", { name: /Criar lote com 2/ }).click();
  await page.waitForURL("**/lote/*");
  await page.getByText("Lote para Loja Parceira").waitFor();
  await page.getByRole("button", { name: /enviar ao comprador/ }).click();
  await page.getByText(/Link do convite/).waitFor();
  ok("lote criado e enviado");

  const cel = await ctx.newPage();
  await cel.goto(BASE + "/demo/celular");
  const link = await cel.locator("a[href*='/aceite-lote/']").first().getAttribute("href");
  await cel.goto(link);
  await cel.getByTestId("itens-lote").waitFor();
  if ((await cel.getByTestId("itens-lote").locator("li").count()) !== 2) throw new Error("esperava 2 itens no convite");
  await cel.getByRole("button", { name: /Receber código/ }).click();
  await cel.getByText(/Código enviado para/).waitFor();
  await cel.fill("input[inputmode=numeric]", "000000");
  await cel.getByRole("button", { name: "Confirmar o lote" }).click();
  await cel.getByText(/Código não confere/).waitFor();
  ok("código errado recusado");
  await cel.fill("input[inputmode=numeric]", await codigoMaisRecente());
  await cel.getByRole("button", { name: "Confirmar o lote" }).click();
  await cel.getByText(/Confirmado, /).waitFor();
  ok("loja compradora aceitou o lote com um código");

  await page.getByRole("button", { name: "Concluir lote" }).waitFor({ timeout: 8000 });
  await page.getByRole("button", { name: "Concluir lote" }).click();
  await page.getByText("Lote concluído").waitFor();
  if ((await page.getByRole("link", { name: "certificado" }).count()) !== 2) throw new Error("esperava 2 certificados");
  ok("lote concluído: 2 protocolos e certificados");

  await page.goto(BASE + "/estoque");
  await page.getByText("Nenhum aparelho").first().waitFor().catch(() => {});
  if (erros.length) { console.log("Erros de console:", erros); process.exitCode = 1; } else console.log("\nTUDO PASSOU");
} catch (e) {
  console.error("FALHOU:", e);
  await page.screenshot({ path: "tests/shots/erro-lote.png", fullPage: true });
  process.exitCode = 1;
} finally { await browser.close(); vite.kill(); }
