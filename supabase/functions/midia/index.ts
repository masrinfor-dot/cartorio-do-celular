// midia — recebe a foto (multipart), confere o tipo pelos BYTES, remove EXIF,
// calcula SHA-256, grava no bucket PRIVADO registry-media e devolve URL assinada
// de 60 segundos.
import { DomainError, detectarTipo, removerMetadados, sha256Hex, type MediaSlot } from "../_shared/core/index.ts";
import { CORS, contexto, exigirLoja, json, lancarSeErro } from "../_shared/server.ts";
import { deviceIdDaTx, obterTx } from "../_shared/views.ts";

const SLOTS: MediaSlot[] = ["frente_ligada", "traseira", "tela_imei", "laterais", "avarias", "documento", "selfie"];
const MAX_BYTES = 12 * 1024 * 1024;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const ctx = await contexto(req);
    const { user, store } = exigirLoja(ctx);
    const admin = ctx.admin;
    const form = await req.formData();
    const transaction_id = String(form.get("transaction_id") ?? "");
    const slot = String(form.get("slot") ?? "") as MediaSlot;
    const arquivo = form.get("arquivo");
    if (!SLOTS.includes(slot)) throw new DomainError("slot", "Tipo de foto inválido.");
    if (!(arquivo instanceof File)) throw new DomainError("foto", "Envie a foto.");
    if (arquivo.size === 0) throw new DomainError("foto_vazia", "A foto veio vazia. Tente de novo.");
    if (arquivo.size > MAX_BYTES) throw new DomainError("foto_grande", "A foto passou de 12 MB. Tire de novo em resolução menor.");

    const t = await obterTx(admin, transaction_id, store.id);
    if (["completed", "cancelled", "expired", "disputed"].includes(t.state)) throw new DomainError("tx_encerrada", "Esta transação não aceita mais fotos.", 409);
    const device_id = await deviceIdDaTx(admin, t.id);

    const original = new Uint8Array(await arquivo.arrayBuffer());
    const tipo = detectarTipo(original);
    if (!tipo) throw new DomainError("tipo", "O arquivo não é uma foto (JPEG, PNG, WebP ou HEIC).");
    const limpo = removerMetadados(original, tipo);
    if (!limpo.suportado && (slot === "documento" || slot === "selfie")) {
      throw new DomainError("formato_documento", "Para documento e selfie, envie em JPEG ou PNG — é o formato em que conseguimos remover a localização.");
    }
    const bytes = limpo.bytes;
    const sha256 = await sha256Hex(bytes);
    const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic" }[tipo];
    const storage_key = `${store.id}/${t.id}/${slot}-${sha256.slice(0, 16)}.${ext}`;

    const { error: eUp } = await admin.storage.from("registry-media").upload(storage_key, bytes, { contentType: tipo, upsert: true });
    if (eUp) throw new DomainError("storage", "Não foi possível guardar a foto. Tente de novo.", 500);

    // Troca da foto do MESMO slot na mesma transação em andamento: a anterior sai da tabela
    // (a tabela de mídia não é append-only; o que é imutável é o elo, e ele ainda não existe).
    await admin.from("registry_device_media").delete().eq("transaction_id", t.id).eq("slot", slot);
    const { data: m, error } = await admin.from("registry_device_media").insert({
      device_id, store_id: store.id, transaction_id: t.id, slot, storage_key, sha256, mime: tipo, bytes: bytes.length,
    }).select("id").single();
    lancarSeErro(error);
    await admin.from("registry_audit_events").insert({ store_id: store.id, actor_user_id: user.id, action: "media.uploaded", subject_type: "media", subject_id: m!.id, metadata: { slot, exif_removido: limpo.removeu, formato: tipo } });

    const { data: signed } = await admin.storage.from("registry-media").createSignedUrl(storage_key, 60);
    return json({ media_id: m!.id, slot, sha256, url: signed?.signedUrl ?? "" });
  } catch (e) {
    if (e instanceof DomainError) return json({ error: { code: e.code, message: e.message } }, e.status);
    console.error("midia: erro inesperado", e instanceof Error ? e.message : e);
    return json({ error: { code: "erro", message: "Falha ao enviar a foto. Tente de novo." } }, 500);
  }
});
