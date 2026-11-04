import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/channels/official/cadastro-incorporado — o botão "Conectar WhatsApp" pode aparecer?
 * POST /api/v1/channels/official/cadastro-incorporado — termina o cadastro: troca o código da
 *                                                      Meta pelo token e conecta o número.
 *
 * É o caminho em que o cliente SÓ clica e confirma no celular, em vez de colar três
 * valores copiados do painel da Meta. O navegador abre o fluxo da Meta e devolve um
 * código de uso único (30 segundos) mais os ids da conta e do número; o App Secret que
 * troca o código por token nunca sai do servidor.
 *
 * ─── Só número que JÁ usa o app WhatsApp Business (coexistência) ─────────────
 * O fluxo de número novo exige registrar o número com um PIN de verificação em duas
 * etapas, que a instalação ainda não guarda. Aceitar esse evento conectaria um canal
 * que não envia — por isso a rota recusa, com a razão, em vez de gravar.
 *
 * O resto (validar a credencial, gravar a sessão, registrar o webhook do número) é o
 * MESMO miolo do formulário manual: `lib/channels/meta/conectar-canal.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { appDaMeta } from "@/lib/channels/meta/app";
import {
  configDoCadastroIncorporado,
  EVENTO_DE_NUMERO_DO_APP,
  pedirSincronizacaoDoApp,
  trocarCodigoPorToken,
} from "@/lib/channels/meta/cadastro-incorporado";
import { conectarCanalOficial } from "@/lib/channels/meta/conectar-canal";
import { traduzir } from "@/lib/i18n/dicionario";
import { basePublicaDoWebhookMeta } from "@/lib/webhooks/url-publica";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const terminarSchema = z.object({
  code: z.string().min(10).max(2048),
  waba_id: z.string().regex(/^\d{5,32}$/),
  phone_number_id: z.string().regex(/^\d{5,32}$/),
  evento: z.string().min(1).max(80),
});

/** O que falta para o botão funcionar — nomes de variável, nunca valores. */
async function oQueFalta(): Promise<{
  faltando: string[];
  config: ReturnType<typeof configDoCadastroIncorporado>;
  appSecret: string | null;
}> {
  const config = configDoCadastroIncorporado();
  const { appSecret } = await appDaMeta();
  const faltando: string[] = [];
  if (!process.env.META_APP_ID?.trim()) faltando.push("META_APP_ID");
  if (!process.env.META_EMBEDDED_SIGNUP_CONFIG_ID?.trim())
    faltando.push("META_EMBEDDED_SIGNUP_CONFIG_ID");
  if (!appSecret) faltando.push("META_APP_SECRET");
  return { faltando, config, appSecret };
}

export async function GET(): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;

  const { faltando, config } = await oQueFalta();
  return ok(
    {
      disponivel: faltando.length === 0,
      app_id: config?.appId ?? null,
      config_id: config?.configId ?? null,
      graph_version: config?.graphVersion ?? null,
      faltando,
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = terminarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(
      "invalid_request",
      t("O retorno da Meta veio incompleto. Tente conectar de novo."),
      422,
      {
        requestId,
      },
    );
  }
  const { code, waba_id, phone_number_id, evento } = parsed.data;

  if (evento !== EVENTO_DE_NUMERO_DO_APP) {
    return fail(
      "invalid_request",
      t(
        "Este botão conecta um número que já usa o app WhatsApp Business. Para um número novo, use o formulário manual abaixo.",
      ),
      422,
      { requestId },
    );
  }

  const { faltando, config, appSecret } = await oQueFalta();
  if (!config || !appSecret || faltando.length > 0) {
    return fail(
      "invalid_request",
      `${t("A instalação não está pronta para o cadastro pela Meta. Falta configurar:")} ${faltando.join(", ")}`,
      422,
      { requestId },
    );
  }

  const troca = await trocarCodigoPorToken({ code, appId: config.appId, appSecret });
  if (!troca.ok) {
    return fail(
      "invalid_request",
      `${t("A Meta recusou o código do cadastro (")}${troca.motivo}${t("). O código vale só 30 segundos: tente conectar de novo.")}`,
      422,
      { requestId },
    );
  }

  const conexao = await conectarCanalOficial({
    organizationId: authz.org.orgId,
    userId: authz.user.id,
    requestId,
    phoneNumberId: phone_number_id,
    wabaId: waba_id,
    token: troca.token,
    base: basePublicaDoWebhookMeta(req),
    t,
  });
  if (!conexao.ok) return fail(conexao.code, conexao.message, conexao.status, { requestId });

  // Os pedidos de sincronização vêm DEPOIS de gravar o canal: a falha deles não desfaz
  // a conexão, e o resultado volta para a tela (a Meta só aceita o histórico uma vez,
  // em até 24 horas).
  const sincronizacao = await pedirSincronizacaoDoApp({
    phoneNumberId: phone_number_id,
    token: troca.token,
  });

  void audit({
    action: "channel.connected",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "channel_session",
    resourceId: conexao.channelSessionId,
    requestId,
    metadata: {
      canal: "oficial",
      origem: "cadastro_incorporado",
      coexistencia: true,
      sincronizacao: sincronizacao.map((s) => ({ tipo: s.tipo, pedida: s.pedida })),
    },
  });

  return ok(
    {
      connected: true,
      displayName: conexao.displayName,
      phoneNumber: conexao.phoneNumber,
      webhookRegistro: conexao.webhook
        ? {
            registrado: conexao.webhook.registrado,
            url: conexao.webhook.url,
            erro: conexao.webhook.erro,
            em: conexao.webhook.em,
          }
        : null,
      sincronizacao,
    },
    { requestId },
  );
}
