// identidade — "buscar" e "criar". O documento em texto claro só existe aqui
// dentro: não vai para log, não volta na resposta, não grava em coluna legível.
import { DomainError, hashDocumento, onlyDigits } from "../_shared/core/index.ts";
import { env, exigirLoja, servir } from "../_shared/server.ts";
import { partyView } from "../_shared/views.ts";
import { criarOuVincularPessoa } from "../_shared/ops.ts";

servir(async (_req, ctx, body) => {
  const { user, store } = exigirLoja(ctx);
  const admin = ctx.admin;
  const op = String(body.op ?? "");
  const documento = onlyDigits(String(body.documento ?? ""));

  if (op === "buscar") {
    if (documento.length !== 11 && documento.length !== 14) return { encontrado: false };
    const hash = await hashDocumento(env("REGISTRY_PII_PEPPER"), documento);
    const { data: ident } = await admin.from("registry_party_identifiers").select("party_id").eq("value_hash", hash).maybeSingle();
    if (!ident) return { encontrado: false };
    const { data: link } = await admin.from("registry_tenant_party_links").select("id").eq("store_id", store.id).eq("party_id", ident.party_id).maybeSingle();
    if (!link) return { encontrado: true, vinculo: false, party_id: ident.party_id }; // sem o nome: a loja A não descobre o cliente da loja B
    const pv = await partyView(admin, ident.party_id as string);
    return { encontrado: true, vinculo: true, ...pv };
  }

  if (op !== "criar") throw new DomainError("op", "Operação desconhecida.");
  return criarOuVincularPessoa(admin, { store, user, ip: ctx.ip }, {
    documento, tipo: body.tipo === "pj" ? "pj" : "pf", nome: String(body.nome ?? ""), telefone: String(body.telefone ?? ""),
  });
});
