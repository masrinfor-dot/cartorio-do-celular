// Ponta a ponta do fluxo de COMPRA (Avaliação de Usados → Cartório), IMEI
// pendente, PDV/venda com nota e envio ao ERP. Roda: node tests/e2e-avaliacao.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:5174";
mkdirSync("tests/shots", { recursive: true });
const vite = spawn("npx", ["vite", "--port", "5174", "--strictPort"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await browser.newContext({ viewport: { width: 480, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const erros = [];
page.on("pageerror", (e) => erros.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) erros.push(m.text()); });
const ok = (m) => console.log("✔", m);
const shot = (n) => page.screenshot({ path: `tests/shots/${n}.png`, fullPage: true });

async function aceitarPeloCelular(nomeEsperado) {
  const cel = await ctx.newPage();
  await cel.goto(BASE + "/demo/celular");
  const link = await cel.locator("a[href*='/aceite/']").first().getAttribute("href");
  await cel.goto(link);
  await cel.getByRole("button", { name: /Receber código/ }).click();
  await cel.getByText(/Código enviado para/).waitFor();
  const inbox = await ctx.newPage();
  await inbox.goto(BASE + "/demo/celular");
  const texto = await inbox.locator("text=/Seu código do Cartório/").first().innerText();
  const codigo = texto.match(/(\d{6})/)[1];
  await cel.fill("input[inputmode=numeric]", codigo);
  await cel.getByRole("button", { name: "Confirmar" }).click();
  await cel.getByText(new RegExp(`Confirmado, ${nomeEsperado}`)).waitFor();
  await cel.close(); await inbox.close();
}

try {
  await page.goto(BASE + "/entrar");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByText("Ainda não tenho conta").click();
  await page.fill("#email", "loja@teste.com"); await page.fill("#senha", "123456");
  await page.click("button[type=submit]");
  await page.waitForURL("**/loja/nova");
  await page.fill("#nome", "Sheik Cell Praça"); await page.fill("#cnpj", "11.222.333/0001-81"); await page.fill("#cidade", "Teófilo Otoni"); await page.fill("#uf", "MG");
  await page.click("button[type=submit]");
  await page.waitForURL("**/avaliacao");
  ok("loja criada, abriu em Comprar");

  // Config: valores base + ERP ativo
  await page.goto(BASE + "/configuracoes");
  await page.getByRole("button", { name: "Valores base" }).click();
  await page.fill("textarea", "Apple;iPhone 13;128GB;2000\nSamsung;Galaxy S23;;1500");
  await page.getByRole("button", { name: "Importar linhas" }).click();
  await page.getByText("Tabela importada.").waitFor();
  await page.getByRole("button", { name: "Integração ERP" }).click();
  await page.getByLabel("Integração ativa").check();
  await page.getByRole("button", { name: "Salvar integração" }).click();
  await page.getByText("Salvo.").waitFor();
  ok("configurações salvas (valores base + ERP)");

  // Avaliação — etapa 1
  await page.goto(BASE + "/avaliacao");
  await page.fill("#modelo", "iPhone 13");
  await page.selectOption("#memoria", "128GB");
  await page.fill("#cor", "Azul");
  await page.getByRole("button", { name: "Continuar" }).click();
  // etapa 2 — checklist: primeira opção de cada pergunta
  await page.getByText("Condições — Apple iPhone 13 128GB Azul").waitFor();
  const grupos = page.locator("fieldset");
  const n = await grupos.count();
  for (let i = 0; i < n; i++) await grupos.nth(i).locator("button").first().click();
  await shot("20-checklist");
  await page.getByRole("button", { name: "Ver oferta" }).click();
  // etapa 3 — oferta
  await page.getByText("Sugestão de valor de compra").waitFor();
  const oferta = await page.locator(".text-3xl.font-black").innerText();
  if (!/1\.400,00/.test(oferta)) throw new Error("oferta esperada R$ 1.400,00, veio " + oferta);
  await page.getByRole("button", { name: /Tabela 3/ }).click();
  const oferta3 = await page.locator(".text-3xl.font-black").innerText();
  if (!/1\.600,00/.test(oferta3)) throw new Error("tabela 3 esperada R$ 1.600,00, veio " + oferta3);
  ok("oferta pela tabela de valores base: " + oferta + " → tabela 3 " + oferta3);
  await shot("21-oferta");
  await page.getByRole("button", { name: "Fechar negócio" }).click();
  // etapa 4
  await page.fill("#dnome", "Maria da Silva");
  await page.fill("#dcpf", "529.982.247-25");
  await page.fill("#dtel", "31988881234");
  await page.fill("#drg", "MG-12.345.678");
  await page.fill("#dend", "Rua A, 100");
  await page.fill("#dbai", "Centro");
  await page.getByText("gerar IMEI de teste").click();
  await page.selectOption("#dpag", "Pix");
  await page.fill("#dpix", "31988881234");
  await page.getByText("fotos sintéticas").click();
  const valor = await page.inputValue("#dvalor");
  if (!/1600/.test(valor.replace(/\D/g, ""))) throw new Error("valor final deveria vir da oferta: " + valor);
  await shot("22-fechar-negocio");
  await page.getByRole("button", { name: "Confirmar fechamento" }).click();
  // etapa 5
  await page.getByText("Negócio fechado — compra registrada").waitFor();
  await page.getByText("Sem restrição na consulta").waitFor();
  await page.getByRole("button", { name: "Aceitar pela loja" }).click();
  await page.getByRole("button", { name: "Enviar código pelo WhatsApp" }).click();
  await page.getByText(/Link enviado para/).waitFor();
  await shot("23-registro");
  await aceitarPeloCelular("Maria");
  await page.getByText("As duas partes aceitaram").waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Concluir registro" }).click();
  await page.getByText("Compra registrada no Cartório").waitFor();
  const protocolo = await page.locator(".font-mono.text-5xl").innerText();
  ok("compra concluída no Cartório: " + protocolo);
  await shot("24-compra-concluida");
  // ERP
  await page.getByRole("button", { name: /Enviar ao ERP/ }).click();
  await page.getByText(/ERP: DP-/).waitFor();
  ok("enviado ao ERP (simulado)");

  // Nota de compra
  const notaLink = await page.locator("a[href*='/nota']").first().getAttribute("href");
  await page.goto(BASE + notaLink);
  await page.getByText("Nota de Compra de Aparelho Usado").waitFor();
  const html = await page.content();
  for (const t of ["529.982.247-25", "MG-12.345.678", "Rua A, 100", protocolo, "Estado declarado pelo vendedor", "1.600,00"]) if (!html.includes(t)) throw new Error("nota de compra sem " + t);
  ok("nota de compra com dados do vendedor, checklist e protocolo");
  await shot("25-nota-compra");

  // Compras
  await page.goto(BASE + "/compras");
  await page.getByText("Total comprado").waitFor();
  const totalHtml = await page.content();
  if (!totalHtml.includes(protocolo) || !totalHtml.includes("Reimprimir nota")) throw new Error("lista de compras incompleta");
  ok("celulares comprados lista a compra");
  await shot("26-compras");

  // IMEI pendente
  await page.goto(BASE + "/avaliacao");
  await page.getByRole("button", { name: "Samsung" }).click();
  await page.fill("#modelo", "Galaxy S23");
  await page.getByRole("button", { name: "Continuar" }).click();
  const g2 = page.locator("fieldset"); const n2 = await g2.count();
  for (let i = 0; i < n2; i++) await g2.nth(i).locator("button").first().click();
  await page.getByRole("button", { name: "Ver oferta" }).click();
  await page.getByRole("button", { name: "Fechar negócio" }).click();
  await page.fill("#dnome", "João Pereira"); await page.fill("#dcpf", "111.444.777-35"); await page.fill("#dtel", "33999990000");
  await page.selectOption("#dpag", "Dinheiro");
  await page.getByRole("button", { name: "Confirmar fechamento" }).click();
  await page.getByText("IMEI pendente").first().waitFor();
  ok("compra sem IMEI fica pendente");
  await page.getByText("gerar IMEI de teste").click();
  await page.getByRole("button", { name: "Completar IMEI" }).click();
  await page.getByText("Sem restrição na consulta").waitFor();
  ok("IMEI completado → consulta feita");

  // PDV: vender o iPhone
  await page.goto(BASE + "/estoque");
  await page.getByRole("button", { name: "Vender" }).first().click();
  await page.waitForSelector("#cpf");
  await page.fill("#cpf", "111.444.777-35");
  await page.getByText("Já cadastrado nesta loja").waitFor();
  await page.click("button[type=submit]");
  await page.getByText("Sem restrição na consulta").waitFor();
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByText("preencher com fotos sintéticas").click();
  await page.waitForFunction(() => document.querySelectorAll("label img").length >= 3);
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.fill("#valor", "2400"); await page.selectOption("#estado", "Excelente");
  await page.click("button[type=submit]");
  await page.getByRole("button", { name: "Aceitar pela loja" }).click();
  await page.getByRole("button", { name: "Enviar código pelo WhatsApp" }).click();
  await page.getByText(/Link enviado para/).waitFor();
  await aceitarPeloCelular("João");
  await page.getByText("As duas partes aceitaram").waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Concluir registro" }).click();
  await page.getByText("Registro concluído").waitFor();
  await page.getByRole("button", { name: "Nota de venda" }).click();
  await page.getByText("Nota de Venda de Aparelho Usado").waitFor();
  const nv = await page.content();
  if (!nv.includes("João Pereira") || !nv.includes("2.400,00") || !nv.includes("TRANSFERÊNCIA DE TITULARIDADE")) throw new Error("nota de venda incompleta");
  ok("venda no PDV com nota de venda e transferência");
  await shot("27-nota-venda");

  if (erros.length) { console.log("Erros de console:", erros); process.exitCode = 1; } else console.log("\nTUDO PASSOU");
} catch (e) {
  console.error("FALHOU:", e);
  await shot("erro-avaliacao");
  process.exitCode = 1;
} finally {
  await browser.close();
  vite.kill();
}
