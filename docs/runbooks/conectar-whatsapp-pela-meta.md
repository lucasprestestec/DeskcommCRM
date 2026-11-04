# Botão "Conectar WhatsApp" (Cadastro Incorporado da Meta)

O cliente que já usa o app WhatsApp Business no celular conecta o número ao CRM sem
copiar `phone_number_id`, `waba_id` e token. A tela é **Conexões › Canal oficial**; o
formulário manual continua logo abaixo.

## Pré-requisitos na Meta (feitos uma vez, por quem opera a instalação)

1. **App publicado**, empresa verificada e acesso avançado a `whatsapp_business_management`
   e `whatsapp_business_messaging` (a instalação atua como Provedor de Tecnologia).
2. **Configuração do Login do Facebook para Empresas** com a variação **"Cadastro
   incorporado do WhatsApp"**, produto *WhatsApp Cloud API*. Anote o **ID da configuração**.
   Crie uma configuração própria da instalação; não reaproveite a de outro site que use o
   mesmo app.
3. Em **Login do Facebook para Empresas › Configurações**, libere o domínio público do CRM
   em *Domínios permitidos para o SDK do JavaScript* e em *URIs de redirecionamento do
   OAuth válidos*. O fluxo não funciona em `localhost`.
4. **App Secret** e **verify token** cadastrados em Admin › API Oficial (Meta) — ou
   `META_APP_SECRET`/`META_WEBHOOK_VERIFY_TOKEN` no `.env`.

## No `.env` da instalação

```
META_APP_ID=<id do app>
META_EMBEDDED_SIGNUP_CONFIG_ID=<id da configuração do passo 2>
```

Sem os dois (e sem o App Secret) o botão não aparece. Nenhum dos dois é segredo.

## O que o servidor faz ao terminar o cadastro

`POST /api/v1/channels/official/cadastro-incorporado` (admin):

1. Troca o código (vale 30 s) pelo token do cliente, com o App Secret no corpo da chamada.
2. Valida a credencial, grava o canal (token cifrado) e registra o webhook do número —
   o mesmo miolo do formulário manual (`lib/channels/meta/conectar-canal.ts`).
3. Pede à Meta a sincronização de contatos e histórico (`smb_app_data`). A Meta exige isso
   em até 24 horas e aceita o histórico **uma vez**; a recusa não desfaz a conexão e volta
   na resposta.

## Limites desta versão (declarados)

- Só **número que já usa o app WhatsApp Business** (evento
  `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`). Número novo exige registrar o número com um
  PIN de verificação em duas etapas, que a instalação ainda não guarda: a rota recusa e
  manda para o formulário manual.
- Os dados de contatos e histórico que a Meta devolve por webhook (`smb_app_state_sync`,
  `history`) **ainda não são importados** para o CRM. As mensagens novas enviadas pelo app
  (`smb_message_echoes`) já eram espelhadas.
- Status do WhatsApp **não** é publicado pela API oficial (a Meta não oferece); ver o
  roteiro de teste em `docs/testing/roteiro-coexistencia-status.md`.
