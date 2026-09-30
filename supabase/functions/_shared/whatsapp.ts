// Envio pelo bridge de WhatsApp da Sheikcell (ou provedor equivalente).
// Timeout curto de 12 s: se o WhatsApp não responde, o balcão precisa saber
// AGORA — e a mensagem é honesta: o link pede o código, não o mostra.
import { DomainError } from "./core/index.ts";
import { env } from "./server.ts";

export const MSG_WHATSAPP_FORA = "O WhatsApp da loja não respondeu, e o código só chega por ele. Confira a conexão do WhatsApp e tente de novo.";

export async function enviarWhatsapp(telefone: string, texto: string): Promise<void> {
  const url = env("WHATSAPP_BRIDGE_URL", false);
  const token = env("WHATSAPP_BRIDGE_TOKEN", false);
  if (!url) {
    // Sem bridge configurado: em ambiente de teste, registra no log do servidor
    // (que NÃO é visível ao operador) e segue. Em produção, configure o bridge.
    console.log(`[whatsapp simulado] para ${telefone.slice(0, 4)}****: ${texto.length} caracteres`);
    return;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ to: telefone, text: texto }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new DomainError("whatsapp", MSG_WHATSAPP_FORA, 503);
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError("whatsapp_timeout", MSG_WHATSAPP_FORA, 503);
  } finally {
    clearTimeout(timer);
  }
}
