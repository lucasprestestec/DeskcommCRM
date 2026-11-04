# Roteiro de teste — API oficial (coexistência) + Status automático pelo WAHA

**Pergunta que o teste responde:** dá para ter, no MESMO número, a API oficial da Meta
atendendo e o WAHA publicando Status sozinho, sem o número ser restringido?

**Por que existe:** a Meta não oferece publicação de Status pela API oficial (tabela de
coexistência: "Business tools (catalog, orders, status) — Not supported"; changelog sem
nenhuma entrada de publicar Status). Só o WAHA (cliente não oficial) publica. Se o teste
passar, mantemos as duas coisas. Se reprovar, o Status automático fica só para quem usa WAHA.

**Quem executa:** Lucas, com o apoio do Claude para ler logs. **Duração:** 1 dia de montagem + 7 dias de observação.

---

## 0. Antes de começar (não pule)

Material:
- [ ] **Um chip descartável** com WhatsApp Business (app, versão **2.24.17 ou superior**). Pode ser restringido ou banido durante o teste: use um que você aceita perder.
- [ ] **Dois celulares/contas "espectadoras"** (números seus, com o chip descartável salvo nos contatos) para ver se o Status chegou.
- [ ] Conta Meta Business com um app que possa fazer a conexão por coexistência (Embedded Signup).
- [ ] WAHA local ou o da VPS de teste (nunca o de produção).
- [ ] Um canal oficial no CRM de teste (`/api/v1/channels/official`: precisa de `phone_number_id`, `waba_id` e `token`).

**A confirmar nos docs da Meta antes (não verificado):**
- [ ] Se um app **sem** ser Tech Provider consegue fazer o onboarding por coexistência.
- [ ] Se o número precisa de um tempo mínimo de uso no app antes da coexistência.

Se qualquer um dos dois bloquear, **pare aqui**: o teste fica inconclusivo, não reprovado.

Páginas: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/

**Regra de ordem (fato dos docs):** o onboarding na API **desvincula todos os aparelhos vinculados**. Por isso o WAHA entra DEPOIS da coexistência, nunca antes.

---

## 1. Controle: o número funciona só no app

1. Ative o chip no app WhatsApp Business. Troque mensagens com os dois espectadores.
2. Poste **um Status manualmente** no app e confirme nos dois espectadores que ele aparece.

Resultado esperado: Status visível nos dois. Anote data e hora. **Sem isso o resto não mede nada.**

## 2. Coexistência com a API oficial

1. Faça o onboarding do número pelo fluxo de coexistência (Embedded Signup).
2. Conecte o canal oficial no CRM de teste.
3. Mande uma mensagem de um espectador para o número. Confirme que:
   - [ ] chegou no CRM;
   - [ ] chegou também no app.
4. Responda pelo CRM (API) e depois pelo app. Confirme que os dois aparecem no CRM (eco `smb_message_echoes`) e chegam ao espectador.

**Passa se:** as 4 setas funcionam (cliente→CRM, cliente→app, CRM→cliente, app→CRM).
**Reprova (fim do teste):** qualquer uma falha por motivo da coexistência.

## 3. Vincular o WAHA como aparelho

1. No WAHA, crie uma sessão nova (engine NOWEB) **só para este número** e gere o QR.
2. No app WhatsApp Business: **Aparelhos conectados → Vincular um aparelho** e leia o QR.
3. Aguarde a sessão ir para `WORKING`.
4. **Não cadastre esta sessão WAHA como canal de mensagens no CRM.** Se cadastrar, o CRM passa a receber a mesma conversa pelos dois lados (API oficial e WAHA) e duplica. Neste teste o WAHA só publica Status.

Depois do vínculo, repita os passos 2.3 e 2.4 para ver se a vinculação **quebrou** a API ou o app.

**Passa se:** a sessão chega a `WORKING` e as 4 setas do passo 2 continuam funcionando.
**Reprova:** o vínculo é recusado, a sessão cai sozinha, ou a API/app param de funcionar.

## 4. Publicar Status pelo WAHA

Use o endpoint de Status do WAHA direto (confirme o caminho exato no Swagger da versão que você roda) e **não** a ferramenta do CRM, pois ela depende da sessão estar cadastrada no CRM.

1. Poste uma imagem de teste com a lista de contatos igual aos dois espectadores.
2. Confira nos dois espectadores: [ ] viu o Status? [ ] com a legenda?
3. Confira no app do número: o Status aparece na aba Status do próprio app?

**Passa se:** os dois espectadores veem o Status e o app mostra.
**Reprova:** o WAHA aceita o pedido mas ninguém vê (falha silenciosa). Registre a resposta HTTP do WAHA.

## 5. Estabilidade: 7 dias

Todo dia, no mesmo horário:
- 1 Status pelo WAHA;
- 2 mensagens de cada lado pelo CRM e pelo app.

Registre por dia, numa tabela (data, Status chegou, mensagens ok, aviso da Meta):
- avisos do WhatsApp no app (restrição, "atividade incomum");
- webhook `account_update` ou qualquer mudança de status do número no painel da Meta;
- queda da sessão WAHA (precisou reler QR?).

**Passa se:** 7 dias sem restrição, sem desvinculação, Status entregue todos os dias.
**Reprova:** restrição ou banimento do número, ou a Meta desvincular o WAHA.
**Inconclusivo:** 1 a 2 falhas pontuais sem aviso da Meta. Estenda por mais 7 dias.

---

## Resultado

| Resultado | O que decidimos |
|---|---|
| **Passa** | Status automático sobre API oficial é viável **com o risco medido** (7 dias não prova longo prazo). Passamos a integrar o WAHA como emissor de Status por canal, ligado só quando o cliente aceitar o risco. |
| **Reprova** | Cliente que quer Status automático fica no WAHA. API oficial para quem não precisa. Story do Instagram (Zernio, já automático) como alternativa. |
| **Inconclusivo** | Repetir com mais dias ou outro número antes de decidir. |

**Limite do teste, para não vender a mais:** um chip e 7 dias não provam que não haverá banimento
com cliente real em escala. Mostram só que o caminho não quebra de imediato.

## Desfazer

Desconecte o canal oficial no CRM, apague a sessão no WAHA, e em **Aparelhos conectados** do app remova o aparelho. O número volta a ser só do app. Se o chip for restringido, descarte.

## O que sai do teste

- Se passar, abrir issue "Status via WAHA em canal na API oficial" com o desenho: o WAHA só emite Status, sem receber mensagens, para não duplicar conversa.
- Registrar o resultado no Hindsight e fechar a memória "Decisão em aberto: API oficial x Status".
