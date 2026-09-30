// Teste de ponta a ponta no modo demonstração. Roda: node tests/e2e.mjs
// Sobe o vite, percorre balcão → aceite no "celular do cliente" → conclusão →
// passaporte → revenda → passaporte com 2 elos. Tira screenshots em tests/shots/.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:5173";
mkdirSync("tests/shots", { recursive: true });
const vite = spawn("npx", ["vite", "--port", "5173", "--strictPort"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const ctx = await browser.newContext({ viewport: { width: 420, height: 860 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const erros = [];
page.on("pageerror", (e) => erros.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") erros.push(m.text()); });
const ok = (msg) => console.log("✔", msg);
const shot = (n) => page.screenshot({ path: `tests/shots/${n}.png`, fullPage: true });

try {
  // limpa demo
  await page.goto(BASE + "/entrar");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // conta + loja
  await page.getByText("Ainda não tenho conta").click();
  await page.fill("#email", "loja@teste.com");
  await page.fill("#senha", "123456");
  await page.click("button[type=submit]");
  await page.waitForURL("**/loja/nova");
  await page.fill("#nome", "Sheik Cell Praça");
  await page.fill("#cnpj", "11.222.333/0001-81");
  await page.fill("#cidade", "Teófilo Otoni");
  await page.fill("#uf", "MG");
  await page.click("button[type=submit]");
  await page.waitForURL("**/avaliacao");
  await page.goto(BASE + "/balcao");
  ok("loja criada");
  await shot("01-balcao");

  // etapa 1 — vendedor
  await page.fill("#cpf", "529.982.247-25");
  await page.waitForSelector("#nome:not([disabled])");
  await page.fill("#nome", "Maria da Silva");
  await page.fill("#tel", "31988881234");
  await page.click("button[type=submit]");
  // etapa 2 — aparelho
  await page.waitForSelector("#imei");
  await page.getByRole("button", { name: "sem restrição" }).click();
  const imei = (await page.inputValue("#imei")).replace(/\D/g, "");
  await page.waitForSelector("#marca");
  await page.fill("#marca", "Apple");
  await page.fill("#modelo", "iPhone 13");
  await page.fill("#arm", "128 GB");
  await page.fill("#cor", "Azul");
  await page.click("button[type=submit]");
  // etapa 3 — consulta
  await page.getByText("Sem restrição na consulta").waitFor();
  ok("consulta sem restrição");
  await shot("02-consulta");
  await page.getByRole("button", { name: "Continuar" }).click();
  // etapa 4 — fotos
  await page.getByText("preencher com fotos sintéticas").click();
  await page.waitForFunction(() => document.querySelectorAll("label img").length >= 3);
  await shot("03-fotos");
  await page.getByRole("button", { name: "Continuar" }).click();
  // etapa 5 — condições
  await page.fill("#valor", "1850,00");
  await page.selectOption("#estado", "Bom");
  await page.click("button[type=submit]");
  // etapa 6 — aceite
  await page.getByRole("button", { name: "Aceitar pela loja" }).click();
  await page.getByText("Ainda falta o vendedor aceitar").waitFor();
  const concluir = page.getByRole("button", { name: "Concluir registro" });
  if (!(await concluir.isDisabled())) throw new Error("Concluir deveria estar desabilitado antes do aceite do vendedor");
  ok("concluir desabilitado sem aceite do vendedor");
  await page.getByRole("button", { name: "Enviar código pelo WhatsApp" }).click();
  await page.getByText(/Link enviado para/).waitFor();
  const tempo = await page.locator(".font-mono.text-2xl").innerText();
  ok("convite enviado; cronômetro parou em " + tempo);
  await shot("04-aceite-aguardando");

  // celular do cliente: pega o link
  const cel = await ctx.newPage();
  await cel.goto(BASE + "/demo/celular");
  const link = await cel.locator("a[href*='/aceite/']").first().getAttribute("href");
  await cel.goto(link);
  await cel.getByRole("button", { name: /Receber código/ }).click();
  await cel.getByText(/Código enviado para/).waitFor();
  // lê o código na caixa de entrada
  const inbox = await ctx.newPage();
  await inbox.goto(BASE + "/demo/celular");
  const texto = await inbox.locator("text=/Seu código do Cartório/").first().innerText();
  const codigo = texto.match(/(\d{6})/)[1];
  // tenta código errado primeiro
  await cel.fill("input[inputmode=numeric]", "000000");
  await cel.getByRole("button", { name: "Confirmar" }).click();
  await cel.getByText(/Código não confere/).waitFor();
  ok("código errado recusado");
  await cel.fill("input[inputmode=numeric]", codigo);
  await cel.getByRole("button", { name: "Confirmar" }).click();
  await cel.getByText(/Confirmado, Maria/).waitFor();
  await cel.screenshot({ path: "tests/shots/05-aceite-celular.png", fullPage: true });
  ok("vendedor aceitou pelo celular");

  // operador: conclui
  await page.getByText("As duas partes aceitaram").waitFor({ timeout: 8000 });
  await concluir.click();
  await page.getByText("Registro concluído").waitFor();
  const protocolo = await page.locator(".font-mono.text-5xl").innerText();
  ok("concluído, protocolo " + protocolo);
  await shot("06-concluido");

  // passaporte
  await page.goto(BASE + "/passaporte/" + imei);
  await page.getByText("elo(s)").waitFor();
  if ((await page.locator(".text-3xl.font-black").innerText()).trim()[0] !== "1") throw new Error("esperava 1 elo");
  const html1 = await page.content();
  if (html1.includes("Maria da Silva") || html1.includes("52998224725") || html1.includes("31988881234")) throw new Error("PII vazou no passaporte");
  ok("passaporte com 1 elo e sem PII");
  await shot("07-passaporte-1-elo");

  // certificado
  await page.goto(BASE + "/certificado/" + protocolo);
  await page.getByText("O que foi verificado").waitFor();
  const html2 = await page.content();
  if (html2.includes("Maria da Silva")) throw new Error("nome completo no certificado");
  ok("certificado abre com nome curto");
  await shot("08-certificado");

  // revenda PJ→PF
  await page.goto(BASE + "/estoque");
  await page.getByRole("button", { name: "Vender" }).click();
  await page.waitForSelector("#cpf");
  await page.fill("#cpf", "111.444.777-35");
  await page.waitForSelector("#nome:not([disabled])");
  await page.fill("#nome", "João Pereira");
  await page.fill("#tel", "33999990000");
  await page.click("button[type=submit]");
  await page.getByText("Sem restrição na consulta").waitFor();
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByText("preencher com fotos sintéticas").click();
  await page.waitForFunction(() => document.querySelectorAll("label img").length >= 3);
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.fill("#valor", "2400");
  await page.selectOption("#estado", "Excelente");
  await page.click("button[type=submit]");
  await page.getByRole("button", { name: "Aceitar pela loja" }).click();
  await page.getByRole("button", { name: "Enviar código pelo WhatsApp" }).click();
  await page.getByText(/Link enviado para/).waitFor();
  // aceite presencial assistido — as travas
  await page.getByText("O código não chegou no celular do cliente?").click();
  const btnAssist = page.getByRole("button", { name: "Registrar aceite assistido" });
  await page.fill("#motivo", "caiu");
  if (!(await btnAssist.isDisabled())) throw new Error("motivo curto deveria desabilitar");
  await page.fill("#motivo", "WhatsApp da loja sem conexão desde as 14h");
  await btnAssist.click();
  await page.getByText("As duas partes aceitaram").waitFor();
  ok("aceite assistido registrado com motivo");
  await shot("09-revenda-assistido");
  await page.getByRole("button", { name: "Concluir registro" }).click();
  await page.getByText("Registro concluído").waitFor();
  await page.getByText("Aceite presencial assistido").first().waitFor();
  ok("revenda concluída com marca de aceite assistido");

  await page.goto(BASE + "/passaporte/" + imei);
  await page.getByText("elo(s)").waitFor();
  if ((await page.locator(".text-3xl.font-black").innerText()).trim()[0] !== "2") throw new Error("esperava 2 elos");
  await page.getByText("Há passagem com aceite presencial assistido").waitFor();
  ok("passaporte com 2 elos e aviso do aceite assistido");
  await shot("10-passaporte-2-elos");

  // IMEI indisponível não libera
  await page.goto(BASE + "/balcao");
  await page.fill("#cpf", "529.982.247-25");
  await page.getByText("Já cadastrado nesta loja").waitFor();
  await page.click("button[type=submit]");
  await page.waitForSelector("#imei");
  await page.getByRole("button", { name: "indisponível" }).click();
  await page.waitForSelector("#marca");
  await page.fill("#marca", "Samsung");
  await page.fill("#modelo", "S23");
  await page.click("button[type=submit]");
  await page.getByText("Consulta indisponível").waitFor();
  const cont = page.getByRole("button", { name: "Continuar" });
  if (!(await cont.isDisabled())) throw new Error("unavailable liberou o fluxo!");
  ok("consulta indisponível NÃO libera");
  await shot("11-indisponivel");

  // aparelho sem registro
  await page.goto(BASE + "/passaporte/356920080000009");
  await page.getByText("Sem registro").waitFor();
  ok("aparelho sem registro: texto neutro");

  if (erros.length) { console.log("Erros de console:", erros); process.exitCode = 1; }
  else console.log("\nTUDO PASSOU");
} catch (e) {
  console.error("FALHOU:", e);
  await shot("erro");
  process.exitCode = 1;
} finally {
  await browser.close();
  vite.kill();
}
