// Conteúdo do certificado — determinístico: sem data de geração dentro, para
// o mesmo certificado gerar sempre o mesmo hash.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { formatarCentavos, nomeCurto } from "./core/index.ts";
import { checkDaTx, deviceIdDaTx, deviceView, obterTx, partesDaTx, partyView, statusAceite, termosVigentes } from "./views.ts";

export async function montarCertificado(admin: SupabaseClient, tx_id: string) {
  const t = await obterTx(admin, tx_id);
  const device_id = await deviceIdDaTx(admin, t.id);
  const dv = (await deviceView(admin, device_id))!;
  const terms = (await termosVigentes(admin, t))!;
  const parties = await partesDaTx(admin, t.id);
  const seller = parties.find((p) => p.role === "seller")!;
  const buyer = parties.find((p) => p.role === "buyer")!;
  const st = await statusAceite(admin, t);
  const ck = await checkDaTx(admin, t.id);
  const { data: loja } = await admin.from("stores").select("name").eq("id", t.store_id).single();
  const { count } = await admin.from("registry_ownership_periods").select("id", { count: "exact", head: true }).eq("device_id", device_id).neq("transaction_id", t.id).lte("started_at", t.completed_at ?? new Date().toISOString());
  const p = terms.payload;
  return {
    protocolo: t.public_protocol,
    kind: t.kind,
    emitido_em: t.completed_at ?? "",
    imei_mascarado: dv.imei_mascarado,
    aparelho: [dv.brand, dv.model, dv.storage, dv.color].filter(Boolean).join(" "),
    loja: loja!.name as string,
    vendedor: nomeCurto((await partyView(admin, seller.party_id)).display_name),
    comprador: nomeCurto((await partyView(admin, buyer.party_id)).display_name),
    grade: st.grade,
    verificado: [
      ...(ck ? [{ item: `IMEI ${ck.result === "clear" ? "sem restrição" : ck.result} na consulta`, data: ck.checked_at, fonte: ck.provider }] : []),
      { item: "Documento do vendedor com dígitos verificadores válidos", data: t.created_at, fonte: "Cartório" },
      { item: `Registro anterior no Cartório: ${count ?? 0} elo(s)`, data: t.completed_at ?? "", fonte: "Cartório" },
      { item: `Termos aceitos pelas duas partes na versão ${terms.version}`, data: t.completed_at ?? "", fonte: st.grade === "assistido" ? "aceite presencial assistido — prova de grau menor" : "aceite por canal próprio" },
    ],
    declarado: [
      { item: "Estado do aparelho", valor: p.estado_aparelho || "não informado" },
      { item: "Defeitos", valor: p.defeitos || "nenhum declarado" },
      ...Object.entries(p.declaracoes ?? {}).map(([k, v]) => ({ item: k, valor: String(v) })),
    ],
    valor: formatarCentavos(p.valor_centavos),
    forma_pagamento: p.forma_pagamento,
    garantia: p.garantia || "não informada",
  };
}
