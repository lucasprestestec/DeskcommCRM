/**
 * Conectar um canal oficial: validar a credencial, gravar a sessão e registrar o webhook.
 *
 * Saiu de `POST /api/v1/channels/official` para que dois caminhos de entrada
 * compartilhem o MESMO miolo — o formulário manual (operador cola `phone_number_id`,
 * `waba_id` e token) e o Cadastro Incorporado (a Meta devolve um código que a
 * instalação troca pelo token). Duas cópias deste bloco divergiriam no primeiro
 * conserto: a ordem VALIDA → GRAVA → REGISTRA WEBHOOK é o que impede "conectado" sem
 * o canal funcionar, e cada passo tem uma razão registrada abaixo.
 *
 * Mora em `lib/channels/` porque a catraca (`pnpm lint:channels`) só deixa a
 * fronteira do canal conhecer a Meta; a rota pede "conecte este número".
 */
import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { reactivateChannelSession } from "@/lib/channels/reactivate";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

import { validateMetaCredentials } from "./validate-credentials";
import { registrarWebhookDaSessao, type DesfechoDoWebhookDaSessao } from "./webhook-da-sessao";

export type ResultadoDaConexao =
  | {
      ok: true;
      channelSessionId: string | null;
      displayName: string;
      phoneNumber: string | null;
      webhook: DesfechoDoWebhookDaSessao | null;
    }
  | { ok: false; status: 422 | 500; code: "invalid_request" | "internal_error"; message: string };

export async function conectarCanalOficial(input: {
  organizationId: string;
  userId: string;
  requestId: string;
  phoneNumberId: string;
  wabaId: string;
  token: string;
  /** Base pública da instalação, para compor a URL de webhook desta sessão. */
  base: string;
  t: (texto: string) => string;
}): Promise<ResultadoDaConexao> {
  const { organizationId: orgId, userId, requestId, phoneNumberId, wabaId, token, t } = input;

  // VALIDA ANTES DE GRAVAR — o miolo não sabe com quem fala; pergunta se a
  // credencial presta e o canal responde.
  //
  // `wabaId` junto desde a fatia F1: a checagem do número sozinha aceita o par
  // trocado (número de uma conta, id de outra), e o registro do webhook logo abaixo
  // apontaria o override de um número que esta instalação não controla.
  const validacao = await validateMetaCredentials({ phoneNumberId, token, wabaId });
  if (!validacao.ok) {
    return { ok: false, status: 422, code: "invalid_request", message: validacao.motivo };
  }

  const admin = createAdminClient();
  const cifrado = await encryptWebhookSecret(admin, token);
  if (!cifrado) {
    // Sem a GUC de cifra configurada, gravar o token em claro seria pior que
    // recusar. O operador precisa saber que falta uma configuração de servidor.
    return {
      ok: false,
      status: 422,
      code: "invalid_request",
      message: t(
        "cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o token não foi gravado",
      ),
    };
  }

  // A busca NÃO filtra `archived_at`: um canal oficial excluído é exatamente o
  // que esta conexão precisa achar para trazer de volta. Ignorá-lo criaria uma
  // SEGUNDA linha oficial na org — e a linha velha continuaria segurando o par
  // (org, número) na trava da 0106.
  const buscarExistente = (colunas: string) =>
    admin
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", orgId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .maybeSingle();
  const { data: existenteRaw } = await queryTolerantToMissingArchived(
    () => buscarExistente(`id, ${ARCHIVED_AT}, webhook_path_token`),
    () => buscarExistente("id, webhook_path_token"),
  );
  const existente = existenteRaw as {
    id: string;
    archived_at?: string | null;
    webhook_path_token?: string | null;
  } | null;

  const linha = {
    organization_id: orgId,
    provider: CHANNEL_PROVIDER_META,
    meta_phone_number_id: phoneNumberId,
    meta_waba_id: wabaId,
    meta_token_encrypted: cifrado,
    phone_number: validacao.displayPhoneNumber
      ? `+${validacao.displayPhoneNumber.replace(/\D/g, "")}`
      : null,
    display_name: validacao.verifiedName ?? "Canal oficial",
    status: "WORKING",
  };

  // `update` quando já existe em vez de upsert: a trava única de (org,
  // phone_number) é um índice único PARCIAL (`where archived_at is null`, migration
  // 0107) que o cliente do PostgREST não consegue usar como árbitro de `ON CONFLICT`.
  //
  // O update passa por `reactivateChannelSession` porque reconectar é
  // ressuscitar: o mesmo patch que devolve status, credencial e número tem que
  // devolver a linha à vida, ou o canal fica "conectado" na tela e excluído para
  // todo o resto do sistema. Para o canal que já estava ativo é um no-op — e a
  // auditoria de volta sai de lá, junto da ressurreição, não daqui.
  let idDaSessao: string | null = existente?.id ?? null;
  let webhookPathToken: string | null = existente?.webhook_path_token ?? null;
  let error: { message?: string | null } | null = null;

  if (existente) {
    ({ error } = await reactivateChannelSession(
      admin,
      {
        organizationId: orgId,
        channelSessionId: existente.id,
        archivedAt: existente.archived_at ?? null,
      },
      linha,
      {
        userId,
        requestId,
        metadata: { provider: CHANNEL_PROVIDER_META, phone_number: linha.phone_number },
      },
    ));
  } else {
    // `select("id, webhook_path_token")` porque o registro do webhook logo abaixo
    // precisa dos DOIS: o id para gravar o desfecho na mesma linha, e o token porque
    // é ele que compõe a URL que a Meta vai chamar.
    const inserida = await admin
      .from("channel_sessions")
      .insert({
        ...linha,
        webhook_secret_encrypted: cifrado,
        metadata: metadataInicialDoCanal(),
      })
      .select("id, webhook_path_token")
      .maybeSingle();
    error = inserida.error;
    idDaSessao = inserida.data?.id ?? null;
    webhookPathToken = inserida.data?.webhook_path_token ?? null;
  }

  if (error) {
    return {
      ok: false,
      status: 500,
      code: "internal_error",
      message: error.message ?? "channel_session_write_failed",
    };
  }

  // ─── O webhook DESTE número, registrado pela própria instalação (fatia F1) ──
  // DEPOIS de gravar, nunca antes: o GET de verificação da Meta chega no instante
  // em que o override é registrado e procura a sessão pelo `webhook_path_token` —
  // registrar antes de a linha existir devolveria 404 e a Meta marcaria o webhook
  // como inválido, que é pior que não registrar.
  //
  // E o desfecho volta no RESULTADO, não só no log: quem conectou precisa saber que
  // o canal envia mas ainda não entrega, com o motivo em mãos.
  const webhook =
    idDaSessao && webhookPathToken
      ? await registrarWebhookDaSessao({
          admin,
          channelSessionId: idDaSessao,
          phoneNumberId,
          wabaId,
          tokenCifrado: cifrado,
          webhookPathToken,
          base: input.base,
          requestId,
        })
      : null;

  return {
    ok: true,
    channelSessionId: idDaSessao,
    displayName: linha.display_name,
    phoneNumber: linha.phone_number,
    webhook,
  };
}
