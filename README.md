# Cartório do Celular — protótipo v0.1

Registro de procedência (lastro) de celulares usados. Cada passagem de mão vira um **elo**; os elos encadeados formam o **passaporte** do aparelho.

Este repositório é a implementação do [Dossiê de execução](../claude/dossie-lovable-v1.md) — as nove regras invioláveis estão em código, não em disciplina.

---

## 1. Rodar hoje, sem nada configurado (modo demonstração)

```bash
npm install
npm run dev
```

Abra <http://localhost:5173>. Tudo roda no navegador, com dados sintéticos guardados no `localStorage`. **Nenhum CPF real deve entrar aqui.**

Roteiro de 3 minutos:

1. Crie uma conta (qualquer e-mail) e cadastre a loja (CNPJ de teste: `11.222.333/0001-81`).
2. **Balcão** → CPF de teste `529.982.247-25`, nome, WhatsApp → IMEI (use o botão *gerar IMEI de teste → sem restrição*) → consulta → *preencher com fotos sintéticas* → valor → **Aceitar pela loja** → **Enviar código pelo WhatsApp**.
3. Abra **📱 Celular do cliente** (menu) — é o WhatsApp do vendedor. Clique no link, peça o código, digite o código que chegou lá. **Só ali o código aparece; nunca na tela do operador.**
4. Volte ao balcão: *As duas partes aceitaram* → **Concluir registro** → protocolo + tempo do cronômetro.
5. **Consultar** → cole o IMEI → passaporte com 1 elo. **Estoque → Revender** → repita com outro CPF (`111.444.777-35`) → passaporte com **2 elos**. Esse segundo elo é o produto.

Para ver as travas: IMEI *com restrição* bloqueia; *indisponível* **não libera**; mude o valor depois do aceite e veja o aceite cair; tente o aceite assistido sem enviar o código antes.

Zerar tudo: **📱 Celular do cliente → Zerar demonstração**.

---

### Comprar, vender e as notas (v0.2)

- **Comprar** = Avaliação de Usados (portada do Sheik CRM): Aparelho → Condições (checklist Apple/Android, com opções que bloqueiam e descontos) → Oferta (tabela de valores base × margem 1/2/3) → Fechar negócio (vendedor, RG/endereço, IMEI opcional, pagamento, fotos) → **Registro no Cartório** (consulta, aceite pelo celular, protocolo). Nota de compra imprimível com checklist, fotos, protocolo e QR.
- **Compras**: celulares comprados (totais, busca, Completar IMEI, Reimprimir nota, Certificado, Enviar ao ERP) e últimas avaliações.
- **Vender (PDV)**: para quem usa só o Cartório — venda do estoque com comprador, valor, pagamento, garantia, aceite pelo celular do comprador, transferência de titularidade e **nota de venda**.
- **Config**: margens, questionário, formas de pagamento, valores base (importação `Marca;Modelo;Armazenamento;Valor`), integração ERP.
- **ERP**: compra/venda concluída pode ser enviada ao Sheik Company ERP (`POST /device-purchases` ou `/device-sales`), que é quem emite a NF-e. O banco do Cartório fica separado. Na demonstração o envio é simulado.

## 2. Estrutura

```
supabase/
  migrations/0001_schema.sql            banco completo: travas, append-only, RLS, passaporte público
  migrations/0002_store_party_and_complete.sql  loja como parte + conclusão atômica (registry_complete_transaction)
  functions/_shared/core/               NÚCLEO DE DOMÍNIO — puro, sem I/O, compartilhado por tudo
    validation.ts   IMEI (Luhn), CPF, CNPJ, máscaras
    hash.ts         JSON canônico, SHA-256, HMAC, AES-256-GCM, protocolo, token, OTP
    stateMachine.ts as transições permitidas e as recusas em português
    verification.ts simulador de consulta + gate (só `clear` libera)
    acceptance.ts   status do aceite preso à versão + as cinco travas do aceite assistido
    imagem.ts       tipo real pelos bytes + remoção de EXIF (JPEG/PNG)
  functions/_shared/server.ts, views.ts, whatsapp.ts, certificado.ts
  functions/_shared/ops.ts               operações de escrita compartilhadas (pessoa, aparelho, transação, termos, consulta)
  functions/{loja,identidade,aparelho,transacao,consulta_procedencia,midia,convite,aceite,aceite_loja,concluir,certificado,avaliacao,erp}/
  migrations/0003_avaliacao_compra_erp.sql       avaliações, configurações por loja, dados extras cifrados, envios ao ERP
  config.toml                            aceite e certificado são públicos (verify_jwt = false)
src/
  api/types.ts     o contrato — a interface só conhece isto
  api/demo.ts      backend de demonstração (navegador) com as mesmas regras
  api/supabase.ts  cliente das Edge Functions
  pages/FluxoTransacao.tsx  balcão (PF→PJ) e revenda (PJ→PF): a MESMA máquina, seis etapas, cronômetro
  pages/Aceite.tsx          /aceite/:token — pública, sem sessão, de propósito
  pages/Passaporte.tsx      /passaporte/:imei — pública, sem PII
  pages/Certificado.tsx     /certificado/:protocolo — pública, com QR e hash
tests/
  core.test.ts     27 testes das regras (máquina de estados, gate, aceite, travas, EXIF)
  e2e.mjs          fluxo completo no Chromium (node tests/e2e.mjs) — tira screenshots em tests/shots/
```

Comandos: `npm run dev` · `npm run build` · `npm test` · `npm run typecheck` · `node tests/e2e.mjs`.

---

## 3. Subir no Supabase (produção)

**Antes de qualquer coisa: ligue o repositório no GitHub.** A versão anterior deste projeto foi perdida por não estar versionada.

1. Crie o projeto em <https://supabase.com>. Anote **Project URL**, **anon key** e **service_role key**.
2. **SQL Editor** → cole e rode `supabase/migrations/0001_schema.sql` inteiro. Depois `0002_store_party_and_complete.sql` e `0003_avaliacao_compra_erp.sql`. (Ou `supabase db push` com o CLI.)
3. **Settings → Edge Functions → Secrets**:
   ```
   REGISTRY_PII_KEY      = <32 bytes em base64>   # cifra CPF/CNPJ
   REGISTRY_PII_PEPPER   = <32 bytes em base64>   # hash de busca e códigos
   PUBLIC_APP_URL        = https://seu-dominio      # forma o link /aceite/<token>
   WHATSAPP_BRIDGE_URL   = https://.../send        # bridge da Sheikcell (POST {to, text})
   WHATSAPP_BRIDGE_TOKEN = ...
   OPENAI_API_KEY        = opcional — pesquisa de preço por IA quando o modelo não está na tabela de valores base
   OPENAI_MODEL          = opcional (padrão gpt-4o)
   ```
   Gerar as chaves: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
   **Trocar o PEPPER invalida todos os hashes já gravados; trocar a KEY torna ilegível todo documento cifrado. Guarde-os fora do Supabase também.**
   Sem `WHATSAPP_BRIDGE_URL`, a função registra a mensagem no log do servidor (só para teste) — o operador continua sem ver o código.
4. Publique as funções:
   ```bash
   npm i -g supabase
   supabase login
   supabase link --project-ref <ref>
   supabase functions deploy
   ```
   Confira que `aceite` e `certificado` ficaram com **verify_jwt = false** (está no `config.toml`).
5. Front:
   ```bash
   cp .env.example .env    # VITE_BACKEND=supabase + URL + anon key
   npm run build           # gera dist/
   ```
   Hospede `dist/` em qualquer host estático (Vercel, Netlify, Hostinger) **com fallback de SPA** (toda rota → `index.html`), senão `/aceite/<token>` dá 404 no celular do cliente.

### Confira antes de seguir (do dossiê)

| Etapa | Teste |
|---|---|
| 0 | Duas lojas; logado na A, `supabase.from('registry_transactions').select()` no console volta vazio para a B |
| 1 | Mesmo CPF nas duas lojas → `select count(*) from registry_parties` = **1**; `…tenant_party_links` = **2** |
| 2 | Mesmo IMEI duas vezes → conflito; `registry_devices` continua em 1 |
| 3 | Congelar termos, aceitar, congelar com outro valor → status volta a incompleto; mesmo valor → `unchanged: true` |
| 4 | IMEI terminado em 2 (`unavailable`) não conclui; foto com GPS gravada sem EXIF |
| 5 | Logado como operador, nenhuma chamada registra o aceite do vendedor; código não aparece em resposta nem log |
| 7 | `select * from registry_ownership_periods where device_id = …` → um fechado, um aberto; concluir 2× → uma transferência |
| 8 | Aba anônima, aba Network: nenhum nome, telefone, CPF ou IMEI inteiro |
| 9 | Mesmo IMEI mostrando entrada **e** revenda |
| 11 | As cinco recusas do aceite assistido; a marca aparece no passaporte |

---

## 4. Onde cada regra inviolável mora

| # | Regra | Onde |
|---|---|---|
| 1 | Operador nunca aceita pelo cliente | `functions/aceite` não lê sessão; `aceite_loja` dá 403 se a parte não é a loja; o código só sai pelo WhatsApp da parte |
| 2 | Chave é UUID, não IMEI | `registry_device_identifiers` + índice único parcial `…_active_unique` |
| 3 | Lastro append-only | gatilho `registry_block_mutation` em eventos, termos, aceites, auditoria |
| 4 | Dois donos é impossível | constraint `registry_ownership_no_overlap` (exclusão GiST) |
| 5 | CPF/CNPJ cifrado + hash | `hash.ts` (AES-GCM + HMAC); `registry_party_identifiers` sem política de RLS |
| 6 | `unavailable` não libera | `verification.ts::exigirProcedenciaLiberada` + `registry_complete_transaction` |
| 7 | Página pública sem PII | `public_device_passport()` e `certificado` devolvem só mascarado/nome curto |
| 8 | Mudar termos derruba aceites | `acceptance.ts::acceptanceStatus` só conta a versão vigente; nenhuma rotina de limpeza |
| 9 | Aceite assistido é exceção marcada | `acceptance.ts::exigirAceiteAssistidoPermitido` (5 travas) + `CHECK registry_acceptances_assisted_chk` + marca no evento público |

---

## 5. O que está pronto e o que falta

**Pronto (etapas 0–11 da ordem de construção):** auth e loja · identidade cifrada · aparelho e conflito de IMEI · transação, estados e termos versionados · fotos com hash e EXIF removido · consulta simulada com gate · convite + OTP + aceite público · balcão com cronômetro · conclusão atômica com titularidade e evento público · passaporte público · revenda PJ→PF (segundo elo) · certificado com QR e hash · aceite presencial assistido.

**Falta:**
- Etapa 12 — telas de **PF→PF** (aceite duplo) e **PJ→PJ** (lote). O banco e a máquina de estados já suportam.
- **PDF** do certificado (hoje é HTML imprimível; o hash já é determinístico).
- Remoção de EXIF em **WebP/HEIC** (hoje: recusa para documento/selfie; aceita para fotos do aparelho).
- Provedor **real** de consulta de IMEI (o contrato já é o de provedor real — trocar `simularConsulta`).
- Retenção/expurgo de evidência pessoal (LGPD) e log de acesso a documento/selfie.
- Integração com o ERP Sheik CRM 360 (entrada de estoque e rascunho a partir da avaliação de usados).
- **Gate jurídico** (seção 10 do dossiê). Enquanto não fechar, **nenhum CPF real entra** — nem no Supabase.

---

## 6. Linguagem

Nunca "produto de roubo", "aparelho limpo", "aprovado", "suspeito". Sempre "consta restrição na base X em DD/MM", "sem restrição na consulta de DD/MM às HH:MM". Toda afirmação carrega fonte e data. Aparelho sem registro **não** é aparelho suspeito.
