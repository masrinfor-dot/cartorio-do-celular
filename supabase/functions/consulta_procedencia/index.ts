// consulta_procedencia — SIMULADOR com contrato de provedor real. Só 'clear'
// libera; 'restricted' bloqueia; 'inconclusive' põe em revisão; 'unavailable'
// NÃO libera. Para trocar por um provedor real, substitua `simularConsulta`.
import { simularConsulta } from "../_shared/core/index.ts";
import { exigirLoja, lancarSeErro, servir } from "../_shared/server.ts";
import { deviceIdDaTx, imeiDoDevice, mudarEstado, obterTx } from "../_shared/views.ts";

servir(async (_req, ctx, body) => {
  const { user, store } = exigirLoja(ctx);
  const admin = ctx.admin;
  const t = await obterTx(admin, String(body.transaction_id ?? ""), store.id);
  const device_id = await deviceIdDaTx(admin, t.id);
  const out = simularConsulta(await imeiDoDevice(admin, device_id));
  const { error } = await admin.from("registry_device_checks").insert({ device_id, transaction_id: t.id, ...out, created_by: user.id });
  lancarSeErro(error);
  if (t.state === "awaiting_data") await mudarEstado(admin, t, "awaiting_checks");
  if (t.state === "awaiting_checks" || t.state === "under_review") {
    if (out.result === "clear") await mudarEstado(admin, t, "awaiting_seller");
    else if (out.result === "restricted") await mudarEstado(admin, t, "blocked");
    else if (out.result === "inconclusive" && t.state !== "under_review") await mudarEstado(admin, t, "under_review");
  }
  await admin.from("registry_device_events").insert({ device_id, store_id: store.id, type: "check_performed", visibility: "tenant", transaction_id: t.id, payload: { resultado: out.result, fonte: out.provider, data: out.checked_at }, created_by: user.id });
  return out;
});
