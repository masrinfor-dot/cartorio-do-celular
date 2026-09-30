// aparelho — "buscar_por_imei" e "criar". O mesmo IMEI ativo em dois aparelhos
// é conflito, nunca um segundo aparelho.
import { DomainError, imeiValido, onlyDigits } from "../_shared/core/index.ts";
import { auditar, exigirLoja, lancarSeErro, servir } from "../_shared/server.ts";
import { buscaAparelho } from "../_shared/views.ts";

const MSG_IMEI = "Esse IMEI não confere. Confira os 15 dígitos — provavelmente há um número trocado.";

servir(async (_req, ctx, body) => {
  const { user, store } = exigirLoja(ctx);
  const admin = ctx.admin;
  const op = String(body.op ?? "");
  const imei = onlyDigits(String(body.imei ?? ""));
  if (!imeiValido(imei)) throw new DomainError("imei", MSG_IMEI);

  const { data: ativo } = await admin.from("registry_device_identifiers").select("device_id").eq("type", "imei").eq("value", imei).eq("is_active", true).maybeSingle();

  if (op === "buscar_por_imei") {
    if (!ativo) return { encontrado: false, elos: 0, linha_do_tempo: [] };
    return buscaAparelho(admin, ativo.device_id as string, store);
  }

  if (op !== "criar") throw new DomainError("op", "Operação desconhecida.");
  if (ativo) return { conflito: true, existente: await buscaAparelho(admin, ativo.device_id as string, store) };

  const { data: d, error: e1 } = await admin.from("registry_devices").insert({
    brand: (body.marca as string) || null, model: (body.modelo as string) || null, storage: (body.armazenamento as string) || null, color: (body.cor as string) || null,
  }).select("id").single();
  lancarSeErro(e1);
  const { error: e2 } = await admin.from("registry_device_identifiers").insert({ device_id: d!.id, type: "imei", value: imei, is_active: true });
  if (e2) {
    // corrida: alguém cadastrou o mesmo IMEI entre a busca e o insert — o índice único parcial segurou
    const { data: outro } = await admin.from("registry_device_identifiers").select("device_id").eq("type", "imei").eq("value", imei).eq("is_active", true).maybeSingle();
    if (outro) return { conflito: true, existente: await buscaAparelho(admin, outro.device_id as string, store) };
    lancarSeErro(e2);
  }
  await admin.from("registry_device_events").insert({ device_id: d!.id, store_id: store.id, type: "device_created", visibility: "public", payload: { marca: body.marca ?? null, modelo: body.modelo ?? null }, created_by: user.id });
  await auditar(admin, store.id, user.id, "device.created", "device", d!.id as string, {}, ctx.ip);
  return { conflito: false, device_id: d!.id };
});
