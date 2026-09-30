// loja — op "criar": cria a loja, o vínculo owner e a PARTE (pj) da loja.
//        op "party": devolve a parte da loja (para figurar como compradora/vendedora).
import { DomainError, cifrar, documentoValido, hashDocumento, onlyDigits } from "../_shared/core/index.ts";
import { auditar, env, lancarSeErro, servir } from "../_shared/server.ts";
import { partyView } from "../_shared/views.ts";

servir(async (_req, ctx, body) => {
  if (!ctx.user) throw new DomainError("sem_sessao", "Entre na sua conta.", 401);
  const op = String(body.op ?? "");

  if (op === "party") {
    if (!ctx.store?.party_id) throw new DomainError("sem_loja", "Cadastre a loja primeiro.", 403);
    return partyView(ctx.admin, ctx.store.party_id);
  }

  if (op !== "criar") throw new DomainError("op", "Operação desconhecida.");
  if (ctx.store) throw new DomainError("ja_tem_loja", "Este usuário já pertence a uma loja.");
  const nome = String(body.nome ?? "").trim();
  const cnpj = onlyDigits(String(body.cnpj ?? ""));
  if (!nome) throw new DomainError("nome", "Informe o nome da loja.");
  if (!documentoValido(cnpj, "pj")) throw new DomainError("cnpj", "Esse CNPJ não confere. Confira os dígitos.");

  const admin = ctx.admin;
  const { data: existente } = await admin.from("stores").select("id").eq("cnpj", cnpj).maybeSingle();
  if (existente) throw new DomainError("cnpj_existe", "Já existe loja com esse CNPJ.");

  // A loja é uma parte canônica: mesmo CNPJ → mesma parte.
  const hash = await hashDocumento(env("REGISTRY_PII_PEPPER"), cnpj);
  let party_id: string;
  const { data: ident } = await admin.from("registry_party_identifiers").select("party_id").eq("type", "cnpj").eq("value_hash", hash).maybeSingle();
  if (ident) {
    party_id = ident.party_id as string;
  } else {
    const { data: p, error: e1 } = await admin.from("registry_parties").insert({ kind: "pj", display_name: nome }).select("id").single();
    lancarSeErro(e1);
    party_id = p!.id as string;
    const { error: e2 } = await admin.from("registry_party_identifiers").insert({ party_id, type: "cnpj", value_hash: hash, value_encrypted: await cifrar(env("REGISTRY_PII_KEY"), cnpj) });
    lancarSeErro(e2);
  }

  const { data: store, error: e3 } = await admin.from("stores").insert({
    name: nome, cnpj, city: (body.cidade as string) || null, state: body.uf ? String(body.uf).toUpperCase().slice(0, 2) : null, party_id,
  }).select("id, name, cnpj, city, state, tier").single();
  lancarSeErro(e3);
  const { error: e4 } = await admin.from("store_members").insert({ store_id: store!.id, user_id: ctx.user.id, role: "owner" });
  lancarSeErro(e4);
  await admin.from("registry_tenant_party_links").insert({ store_id: store!.id, party_id });
  await auditar(admin, store!.id as string, ctx.user.id, "store.created", "store", store!.id as string, {}, ctx.ip);
  return store;
});
