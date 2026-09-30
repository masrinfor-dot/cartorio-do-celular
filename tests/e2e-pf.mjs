// Ponta a ponta do PORTAL PF: login por CPF + WhatsApp cadastrado, venda entre
// pessoas (comprador aceita primeiro, vendedor confirma por último), registro e
// retirada de ocorrência (com alerta no balcão da loja) e comunicação de venda
// que conclui sozinha quando o comprador aceita. Roda: node tests/e2e-pf.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:5175";
mkdirSync("tests/shots", { recursive: true });
const vite = spawn("npx", ["vite", "--port", "5175", "--strictPort"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await browser.newContext({ viewport: { width: 480, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const erros = [];
page.on("pageerror", (e) => erros.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) erros.push(m.text()); });
const ok = (m) => console.log("✔", m);
const shot = (n) => page.screenshot({ path: `tests/shots/${n}.png`, fullPage: true });

async function codigoRecente(texto) {
  const inbox = await ctx.newPage();
  await inbox.goto(BASE + "/demo/celular");
  const t = await inbox.locator(`text=/${texto}/`).first().innerText();
  await inbox.close();
  return t.match(/(\d{6})/)[1];
}
async function aceitarPeloCelular(nomeEsperado) {
  const cel = await ctx.newPage();
  await cel.goto(BASE + "/demo/celular");
  const link = await cel.locator("a[href*='/aceite/']").first().getAttribute("href");
  await cel.goto(link);
  await cel.getByRole("button", { name: /Receber código/ }).click();
  await cel.getByText(/Código enviado para/).waitFor();
  const codigo = await codigoRecente("Seu código do Cartório do Celular");
  await cel.fill("input[inputmode=numeric]", codigo);
  await cel.getByRole("button", { name: "Confirmar" }).click();
  await cel.getByText(new RegExp(`Confirmado, ${nomeEsperado}`)).waitFor();
  await cel.close();
}
async function loginPf(cpf, tel, nome) {
  await page.goto(BASE + "/pf/entrar");
  await page.fill("#pcpf", cpf); await page.fill("#ptel", tel);
  if (nome) { await page.click("button[type=submit]"); await page.getByText(/Primeiro acesso/).first().waitFor().catch(() => {}); if (await page.locator("#pnome").count()) await page.fill("#pnome", nome); }
  await page.click("button[type=submit]");
  await page.getByText(/Código enviado para/).waitFor();
  const codigo = await codigoRecente("Seu código de acesso ao Cartório");
  await page.fill("input[inputmode=numeric]", codigo);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL("**/pf");
}
async function entradaBalcao(cpf, nome, tel, terminacao = "sem restrição") {
  await page.goto(BASE + "/balcao");
  await page.fill("#cpf", cpf);
  const ja = await page.getByText("Já cadastrado nesta loja").waitFor({ timeout: 1500 }).then(() => true).catch(() => false);
  if (!ja) { await page.fill("#nome", nome); await page.fill("#tel", tel); }
  await page.click("button[type=submit]");
  await page.waitForSelector("#imei");
  await page.getByRole("button", { name: terminacao }).click();
  const imei = (await page.inputValue("#imei")).replace(/\D/g, "");
  await page.waitForSelector("#marca");
  await page.fill("#marca", "Apple"); await page.fill("#modelo", "iPhone 12");
  await page.click("button[type=submit]");
  await page.getByText("Sem restrição na consulta").waitFor();
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByText("preencher com fotos sintéticas").click();
  await page.waitForFunction(() => document.querySelectorAll("label img").length >= 3);
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.fill("#valor", "1000"); await page.selectOption("#estado", "Bom");
  await page.click("button[type=submit]");
  await page.getByRole("button", { name: "Aceitar pela loja" }).click();
  await page.getByRole("button", { name: "Enviar código pelo WhatsApp" }).click();
  await page.getByText(/Link enviado para/).waitFor();
  await aceitarPeloCelular(nome.split(" ")[0]);
  await page.getByText("As duas partes aceitaram").waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Concluir registro" }).click();
  await page.getByText("Registro concluído").waitFor();
  return imei;
}

try {
  // Loja
  await page.goto(BASE + "/entrar");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByText("Ainda não tenho conta").click();
  await page.fill("#email", "loja@teste.com"); await page.fill("#senha", "123456");
  await page.click("button[type=submit]");
  await page.waitForURL("**/loja/nova");
  await page.fill("#nome", "Sheik Cell Praça"); await page.fill("#cnpj", "11.222.333/0001-81");
  await page.click("button[type=submit]");
  await page.waitForURL("**/avaliacao");
  const imei = await entradaBalcao("529.982.247-25", "Maria da Silva", "31988881234");
  ok("loja comprou de Maria (1º elo) · IMEI " + imei);

  // PDV: loja vende para João
  await page.goto(BASE + "/estoque");
  await page.getByRole("button", { name: "Vender" }).first().click();
  await page.waitForSelector("#cpf");
  await page.fill("#cpf", "111.444.777-35"); await page.waitForSelector("#nome:not([disabled])");
  await page.fill("#nome", "João Pereira"); await page.fill("#tel", "33999990000");
  await page.click("button[type=submit]");
  await page.getByText("Sem restrição na consulta").waitFor();
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByText("preencher com fotos sintéticas").click();
  await page.waitForFunction(() => document.querySelectorAll("label img").length >= 3);
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.fill("#valor", "1500"); await page.selectOption("#estado", "Bom");
  await page.click("button[type=submit]");
  await page.getByRole("button", { name: "Aceitar pela loja" }).click();
  await page.getByRole("button", { name: "Enviar código pelo WhatsApp" }).click();
  await page.getByText(/Link enviado para/).waitFor();
  await aceitarPeloCelular("João");
  await page.getByText("As duas partes aceitaram").waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Concluir registro" }).click();
  await page.getByText("Registro concluído").waitFor();
  ok("loja vendeu para João (2º elo)");

  // Portal PF — segurança: CPF de Maria com telefone errado
  await page.goto(BASE + "/pf/entrar");
  await page.fill("#pcpf", "529.982.247-25"); await page.fill("#ptel", "31900000000");
  await page.click("button[type=submit]");
  await page.getByText(/não é o cadastrado para este CPF/).waitFor();
  ok("login PF recusa WhatsApp que não é o cadastrado");

  // João entra e vende para Maria
  await loginPf("111.444.777-35", "33999990000");
  await page.getByText("Olá, João").waitFor();
  await page.getByText("iPhone 12").waitFor();
  await shot("30-meus-aparelhos");
  await page.getByRole("button", { name: "Vender" }).click();
  await page.fill("#vcpf", "529.982.247-25"); await page.fill("#vnome", "Maria da Silva"); await page.fill("#vtel", "31988881234"); await page.fill("#vvalor", "1300");
  await page.getByText("fotos sintéticas").click();
  await page.getByRole("button", { name: "Enviar para o comprador aceitar" }).click();
  await page.waitForURL("**/pf/venda/**");
  await page.getByText("Venda em andamento").waitFor();
  const confirmar = page.getByRole("button", { name: "Confirmar venda e transferir" });
  if (!(await confirmar.isDisabled())) throw new Error("vendedor não pode confirmar antes do comprador");
  ok("venda PF→PF aberta; vendedor bloqueado até o comprador aceitar");
  await shot("31-venda-aguardando");
  await aceitarPeloCelular("Maria");
  await page.getByText(/aceitou pelo celular dele/).waitFor({ timeout: 10000 });
  await confirmar.click();
  await page.getByText("Transferência concluída").waitFor();
  ok("vendedor confirmou por último → transferência concluída (3º elo)");
  await shot("32-venda-concluida");
  await page.goto(BASE + "/passaporte/" + imei);
  await page.getByText("elo(s)").waitFor();
  if ((await page.locator(".text-3xl.font-black").innerText()).trim()[0] !== "3") throw new Error("esperava 3 elos");

  // Maria entra, registra roubo → passaporte e balcão alertam
  await page.goto(BASE + "/pf/entrar"); await page.evaluate(() => localStorage.removeItem("cdc-demo-pf-token"));
  await loginPf("529.982.247-25", "31988881234");
  await page.getByText("Olá, Maria").waitFor();
  await page.getByRole("button", { name: /Registrar furto/ }).click();
  await page.getByRole("button", { name: "roubo" }).click();
  await page.fill("#obo", "MG-2026-0001"); await page.fill("#ocid", "Teófilo Otoni"); await page.fill("#ouf", "MG");
  await page.getByRole("button", { name: "Registrar declaração" }).click();
  await page.waitForURL("**/pf");
  await page.getByText("Declaração de roubo ativa").waitFor();
  ok("ocorrência registrada pela titular");
  await shot("33-ocorrencia");
  await page.goto(BASE + "/passaporte/" + imei);
  await page.getByText(/Consta declaração de roubo pelo titular registrado/).waitFor();
  const html = await page.content();
  if (html.includes("Maria")) throw new Error("PII no passaporte");
  ok("passaporte mostra a declaração (sem PII)");
  await shot("34-passaporte-ocorrencia");
  // balcão da loja alerta ao digitar o IMEI
  await page.goto(BASE + "/balcao");
  await page.fill("#cpf", "111.444.777-35"); await page.getByText("Já cadastrado nesta loja").waitFor();
  await page.click("button[type=submit]");
  await page.fill("#imei", imei);
  await page.getByText(/Consta declaração de roubo pelo titular registrado/).waitFor();
  ok("balcão da loja alerta a ocorrência ao ler o IMEI");
  // retirar
  await page.goto(BASE + "/pf");
  await page.getByRole("button", { name: "Retirar declaração" }).click();
  await page.fill("#rm", "Aparelho recuperado");
  await page.getByRole("button", { name: "Retirar declaração" }).click();
  await page.waitForURL("**/pf");
  ok("declaração retirada");

  // Comunicar venda para Pedro (novo), que aceita → conclui sozinha
  await page.getByRole("button", { name: /comunicar venda/ }).click();
  await page.fill("#ccpf", "123.456.789-09"); await page.fill("#cnome", "Pedro Souza"); await page.fill("#ctel", "35988880000"); await page.fill("#cvalor", "900");
  await page.getByRole("button", { name: "Declarar venda" }).click();
  await page.waitForURL("**/pf/venda/**");
  await page.getByText("Venda comunicada").waitFor();
  await page.goto(BASE + "/passaporte/" + imei);
  await page.getByText("Venda declarada pelo titular").waitFor();
  ok("comunicação de venda aparece como declarada no passaporte");
  await aceitarPeloCelular("Pedro");
  await page.goto(BASE + "/passaporte/" + imei);
  await page.getByText("elo(s)").waitFor();
  if ((await page.locator(".text-3xl.font-black").innerText()).trim()[0] !== "4") throw new Error("esperava 4 elos após o comprador aceitar a venda comunicada");
  ok("comprador aceitou → transferência concluída sozinha (4º elo)");
  await shot("35-passaporte-4-elos");

  if (erros.length) { console.log("Erros de console:", erros); process.exitCode = 1; } else console.log("\nTUDO PASSOU");
} catch (e) {
  console.error("FALHOU:", e);
  await shot("erro-pf");
  process.exitCode = 1;
} finally {
  await browser.close();
  vite.kill();
}
