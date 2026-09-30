// aparelho — "buscar_por_imei" e "criar". O mesmo IMEI ativo em dois aparelhos
// é conflito, nunca um segundo aparelho.
import { DomainError, imeiValido, onlyDigits } from "../_shared/core/index.ts";
import { exigirLoja, servir } from "../_shared/server.ts";
import { buscaAparelho } from "../_shared/views.ts";
import { criarAparelho } from "../_shared/ops.ts";

servir(async (_req, ctx, body) => {
  const { user, store } = exigirLoja(ctx);
  const admin = ctx.admin;
  const op = String(body.op ?? "");
  const imei = onlyDigits(String(body.imei ?? ""));
  if (!imeiValido(imei)) throw new DomainError("imei", "Esse IMEI não confere. Confira os 15 dígitos — provavelmente há um número trocado.");

  if (op === "buscar_por_imei") {
    const { data: ativo } = await admin.from("registry_device_identifiers").select("device_id").eq("type", "imei").eq("value", imei).eq("is_active", true).maybeSingle();
    if (!ativo) return { encontrado: false, elos: 0, linha_do_tempo: [] };
    return buscaAparelho(admin, ativo.device_id as string, store);
  }
  if (op !== "criar") throw new DomainError("op", "Operação desconhecida.");
  return criarAparelho(admin, { store, user, ip: ctx.ip }, { imei, marca: body.marca as string, modelo: body.modelo as string, armazenamento: body.armazenamento as string, cor: body.cor as string });
});
