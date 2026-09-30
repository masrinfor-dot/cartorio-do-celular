// identidade — "buscar" e "criar". O documento em texto claro só existe aqui
// dentro: não vai para log, não volta na resposta, não grava em coluna legível.
import { DomainError, cifrar, documentoValido, hashDocumento, onlyDigits } from "../_shared/core/index.ts";
import { auditar, env, exigirLoja, lancarSeErro, servir } from "../_shared/server.ts";
import { partyView } from "../_shared/views.ts";

servir(async (_req, ctx, body) => {
  const { user, store } = exigirLoja(ctx);
  const admin = ctx.admin;
  const op = String(body.op ?? "");
  const documento = onlyDigits(String(body.documento ?? ""));
  const pepper = env("REGISTRY_PII_PEPPER");

  if (op === "buscar") {
    if (documento.length !== 11 && documento.length !== 14) return { encontrado: false };
    const hash = await hashDocumento(pepper, documento);
    const { data: ident } = await admin.from("registry_party_identifiers").select("party_id").eq("value_hash", hash).maybeSingle();
    if (!ident) return { encontrado: false };
    const { data: link } = await admin.from("registry_tenant_party_links").select("id").eq("store_id", store.id).eq("party_id", ident.party_id).maybeSingle();
    if (!link) return { encontrado: true, vinculo: false, party_id: ident.party_id }; // sem o nome: a loja A não descobre o cliente da loja B
    const pv = await partyView(admin, ident.party_id as string);
    return { encontrado: true, vinculo: true, ...pv };
  }

  if (op !== "criar") throw new DomainError("op", "Operação desconhecida.");
  const tipo = body.tipo === "pj" ? "pj" : "pf";
  const nome = String(body.nome ?? "").trim();
  const telefone = onlyDigits(String(body.telefone ?? ""));
  if (!documentoValido(documento, tipo)) throw new DomainError("documento", tipo === "pf" ? "Esse CPF não confere. Confira os dígitos." : "Esse CNPJ não confere. Confira os dígitos.");
  if (!nome) throw new DomainError("nome", "Informe o nome.");
  if (telefone.length < 10) throw new DomainError("telefone", "Informe o telefone com DDD — é por ele que o código de aceite chega.");

  const hash = await hashDocumento(pepper, documento);
  let party_id: string;
  const { data: ident } = await admin.from("registry_party_identifiers").select("party_id").eq("value_hash", hash).maybeSingle();
  if (ident) {
    party_id = ident.party_id as string; // pessoa única na plataforma: só o vínculo é novo
  } else {
    const { data: p, error: e1 } = await admin.from("registry_parties").insert({ kind: tipo, display_name: nome }).select("id").single();
    lancarSeErro(e1);
    party_id = p!.id as string;
    const { error: e2 } = await admin.from("registry_party_identifiers").insert({
      party_id, type: tipo === "pf" ? "cpf" : "cnpj", value_hash: hash, value_encrypted: await cifrar(env("REGISTRY_PII_KEY"), documento), key_version: 1,
    });
    lancarSeErro(e2);
  }
  const { data: telExistente } = await admin.from("registry_party_contacts").select("id").eq("party_id", party_id).eq("kind", "phone").eq("value", telefone).maybeSingle();
  if (!telExistente) await admin.from("registry_party_contacts").insert({ party_id, kind: "phone", value: telefone });
  await admin.from("registry_tenant_party_links").upsert({ store_id: store.id, party_id }, { onConflict: "store_id,party_id", ignoreDuplicates: true });
  await admin.from("registry_consents").insert({ party_id, store_id: store.id, purpose: "registro_de_passagem", evidence: { operador: user.id } });
  await auditar(admin, store.id, user.id, "party.linked", "party", party_id, {}, ctx.ip);
  return partyView(admin, party_id);
});
