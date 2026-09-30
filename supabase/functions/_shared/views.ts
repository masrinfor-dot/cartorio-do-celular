// Leituras compostas usadas por várias Edge Functions. Devolvem SÓ o que a
// interface precisa — nunca CPF, token ou código.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  DomainError,
  acceptanceStatus,
  mascararImei,
  mascararTelefone,
  type Acceptance,
  type CheckOutcome,
  type TermsPayload,
  type TransactionKind,
  type TransactionParty,
  type TransactionState,
} from "./core/index.ts";
import { lancarSeErro } from "./server.ts";

export interface TxRow {
  id: string; store_id: string; kind: TransactionKind; state: TransactionState; public_protocol: string;
  current_terms_version: number; created_at: string; updated_at: string; completed_at: string | null; created_by: string | null;
}

export async function partyView(admin: SupabaseClient, party_id: string) {
  const { data: p, error } = await admin.from("registry_parties").select("id, kind, display_name").eq("id", party_id).maybeSingle();
  lancarSeErro(error);
  if (!p) throw new DomainError("parte_inexistente", "Pessoa não encontrada.", 404);
  const { data: tel } = await admin.from("registry_party_contacts").select("value").eq("party_id", party_id).eq("kind", "phone").order("created_at", { ascending: false }).limit(1).maybeSingle();
  return { party_id: p.id as string, display_name: p.display_name as string, kind: p.kind as "pf" | "pj", telefone_mascarado: tel ? mascararTelefone(tel.value as string) : null };
}

export async function telefoneDaParte(admin: SupabaseClient, party_id: string): Promise<string | null> {
  const { data } = await admin.from("registry_party_contacts").select("value").eq("party_id", party_id).eq("kind", "phone").order("created_at", { ascending: false }).limit(1).maybeSingle();
  return (data?.value as string | undefined) ?? null;
}

export async function deviceView(admin: SupabaseClient, device_id: string) {
  const { data: d } = await admin.from("registry_devices").select("id, brand, model, storage, color").eq("id", device_id).maybeSingle();
  if (!d) return null;
  const { data: imei } = await admin.from("registry_device_identifiers").select("value").eq("device_id", device_id).eq("type", "imei").eq("is_active", true).limit(1).maybeSingle();
  return { device_id: d.id as string, imei_mascarado: imei ? mascararImei(imei.value as string) : "****", brand: d.brand as string | null, model: d.model as string | null, storage: d.storage as string | null, color: d.color as string | null };
}

export async function imeiDoDevice(admin: SupabaseClient, device_id: string): Promise<string> {
  const { data } = await admin.from("registry_device_identifiers").select("value").eq("device_id", device_id).eq("type", "imei").eq("is_active", true).limit(1).maybeSingle();
  return (data?.value as string | undefined) ?? "";
}

export async function obterTx(admin: SupabaseClient, tx_id: string, store_id?: string): Promise<TxRow> {
  let q = admin.from("registry_transactions").select("*").eq("id", tx_id);
  if (store_id) q = q.eq("store_id", store_id);
  const { data, error } = await q.maybeSingle();
  lancarSeErro(error);
  if (!data) throw new DomainError("tx_inexistente", "Transação não encontrada.", 404);
  return data as TxRow;
}

export async function termosVigentes(admin: SupabaseClient, t: TxRow) {
  if (t.current_terms_version === 0) return null;
  const { data } = await admin.from("registry_transaction_terms").select("version, payload, content_hash, frozen_at").eq("transaction_id", t.id).eq("version", t.current_terms_version).maybeSingle();
  return data ? { version: data.version as number, payload: data.payload as TermsPayload, content_hash: data.content_hash as string, frozen_at: data.frozen_at as string } : null;
}

export async function partesDaTx(admin: SupabaseClient, tx_id: string): Promise<TransactionParty[]> {
  const { data } = await admin.from("registry_transaction_parties").select("party_id, role, is_tenant_side").eq("transaction_id", tx_id);
  return (data ?? []) as TransactionParty[];
}

export async function deviceIdDaTx(admin: SupabaseClient, tx_id: string): Promise<string> {
  const { data } = await admin.from("registry_transaction_devices").select("device_id").eq("transaction_id", tx_id).limit(1).maybeSingle();
  if (!data) throw new DomainError("aparelho", "A transação não tem aparelho.", 409);
  return data.device_id as string;
}

export async function checkDaTx(admin: SupabaseClient, tx_id: string): Promise<CheckOutcome | null> {
  const { data } = await admin.from("registry_device_checks").select("provider, result, checked_at, valid_until, raw").eq("transaction_id", tx_id).order("checked_at", { ascending: false }).limit(1).maybeSingle();
  return data ? (data as CheckOutcome) : null;
}

export async function statusAceite(admin: SupabaseClient, t: TxRow) {
  const parties = await partesDaTx(admin, t.id);
  const { data: accs } = await admin.from("registry_transaction_acceptances").select("party_id, terms_version, terms_hash, channel, accepted_at").eq("transaction_id", t.id);
  const terms = await termosVigentes(admin, t);
  return acceptanceStatus(t.kind, parties, (accs ?? []) as Acceptance[], t.current_terms_version, terms?.content_hash ?? "");
}

export async function linhaDoTempo(admin: SupabaseClient, device_id: string, store_id?: string) {
  let q = admin.from("registry_device_events").select("type, created_at, payload, visibility, store_id").eq("device_id", device_id).order("created_at");
  q = store_id ? q.or(`visibility.eq.public,store_id.eq.${store_id}`) : q.eq("visibility", "public");
  const { data } = await q;
  return (data ?? []).map((e) => ({ tipo: e.type as string, data: e.created_at as string, dados: e.payload as Record<string, unknown> }));
}

export async function buscaAparelho(admin: SupabaseClient, device_id: string, store: { id: string; party_id: string | null } | null) {
  const dv = await deviceView(admin, device_id);
  if (!dv) return { encontrado: false, elos: 0, linha_do_tempo: [] };
  const { count } = await admin.from("registry_ownership_periods").select("id", { count: "exact", head: true }).eq("device_id", device_id);
  const { data: titular } = await admin.from("registry_ownership_periods").select("party_id").eq("device_id", device_id).is("ended_at", null).maybeSingle();
  return {
    encontrado: true,
    device: dv,
    elos: count ?? 0,
    linha_do_tempo: await linhaDoTempo(admin, device_id, store?.id),
    loja_e_titular: !!titular && !!store?.party_id && titular.party_id === store.party_id,
  };
}

export async function txView(admin: SupabaseClient, t: TxRow) {
  const device_id = await deviceIdDaTx(admin, t.id).catch(() => null);
  const parties = await partesDaTx(admin, t.id);
  const partiesFull = await Promise.all(parties.map(async (p) => ({ ...p, ...(await partyView(admin, p.party_id)) })));
  const terms = await termosVigentes(admin, t);
  const { data: media } = await admin.from("registry_device_media").select("id, slot, sha256, storage_key").eq("transaction_id", t.id);
  const mediaViews = await Promise.all((media ?? []).map(async (m) => {
    const { data: signed } = await admin.storage.from("registry-media").createSignedUrl(m.storage_key as string, 60);
    return { media_id: m.id as string, slot: m.slot, sha256: m.sha256 as string, url: signed?.signedUrl ?? "" };
  }));
  const { data: convites } = await admin.from("registry_acceptance_invites").select("id, party_id, terms_version, destination_masked, consumed_at, revoked_at, expires_at").eq("transaction_id", t.id);
  return {
    id: t.id, kind: t.kind, state: t.state, public_protocol: t.public_protocol, current_terms_version: t.current_terms_version,
    created_at: t.created_at, completed_at: t.completed_at,
    parties: partiesFull,
    device: device_id ? await deviceView(admin, device_id) : null,
    terms,
    check: await checkDaTx(admin, t.id),
    media: mediaViews,
    aceite: await statusAceite(admin, t),
    convites: (convites ?? []).map((c) => ({ invite_id: c.id, party_id: c.party_id, terms_version: c.terms_version, destino_mascarado: c.destination_masked, consumed_at: c.consumed_at, revoked_at: c.revoked_at, expires_at: c.expires_at })),
  };
}

export async function mudarEstado(admin: SupabaseClient, t: TxRow, novo: TransactionState) {
  const { exigirTransicao } = await import("./core/stateMachine.ts");
  exigirTransicao(t.state, novo);
  const { error } = await admin.from("registry_transactions").update({ state: novo, updated_at: new Date().toISOString() }).eq("id", t.id);
  lancarSeErro(error);
  t.state = novo;
}
