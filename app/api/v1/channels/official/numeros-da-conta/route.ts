import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/channels/official/numeros-da-conta — os números da conta da Meta desta instalação.
 * POST /api/v1/channels/official/numeros-da-conta — liga um deles à organização de quem pede.
 *
 * Para quem opera a instalação e paga por UM portfólio na Meta, com os números dos
 * clientes dentro dele: em vez de copiar `phone_number_id` e token a cada cliente, o
 * CRM pergunta à Meta quais números existem e liga o escolhido (`lib/channels/meta/numeros-da-conta.ts`).
 *
 * ─── Só quem administra a INSTALAÇÃO ─────────────────────────────────────────
 * O token enxerga a conta inteira — os números de TODOS os clientes. Mostrar essa
 * lista a um administrador de organização vazaria a carteira de clientes de quem
 * opera a instalação. Por isso as duas rotas exigem administrador da plataforma
 * (fora do modo suporte), e a organização que recebe o número vem da sessão, nunca
 * do corpo.
 *
 * O `phone_number_id` do corpo só é aceito se a PRÓPRIA Meta o listar na conta: o
 * corpo escolhe entre os números que a conta tem, não inventa um endereço.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { pedirSincronizacaoDoApp } from "@/lib/channels/meta/cadastro-incorporado";
import { conectarCanalOficial } from "@/lib/channels/meta/conectar-canal";
import { contaDaMetaDoAmbiente, listarNumerosDaConta } from "@/lib/channels/meta/numeros-da-conta";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { basePublicaDoWebhookMeta } from "@/lib/webhooks/url-publica";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ligarSchema = z.object({ phone_number_id: z.string().regex(/^\d{5,32}$/) });

type EstadoDoNumero = "livre" | "nesta_organizacao" | "em_uso";

/** Quem já tem cada número ligado, SEM revelar qual organização — só se é esta ou outra. */
async function estadoDosNumeros(orgId: string, ids: string[]): Promise<Map<string, EstadoDoNumero>> {
  const mapa = new Map<string, EstadoDoNumero>();
  if (ids.length === 0) return mapa;
  const admin = createAdminClient();
  const base = (comFiltro: boolean) => {
    const q = admin
      .from("channel_sessions")
      .select("organization_id, meta_phone_number_id")
      .eq("provider", CHANNEL_PROVIDER_META)
      .in("meta_phone_number_id", ids);
    return comFiltro ? q.is(ARCHIVED_AT, null) : q;
  };
  const { data } = await queryTolerantToMissingArchived(
    () => base(true),
    () => base(false),
  );
  for (const l of (data ?? []) as { organization_id: string; meta_phone_number_id: string }[]) {
    mapa.set(l.meta_phone_number_id, l.organization_id === orgId ? "nesta_organizacao" : "em_uso");
  }
  return mapa;
}

export async function GET(): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;

  const conta = contaDaMetaDoAmbiente();
  // Para quem não administra a instalação, a funcionalidade simplesmente não existe:
  // `disponivel: false` sem dizer por quê — a lista de números é da carteira de quem opera.
  if (!conta || !authz.user.is_platform_admin || authz.user.support) {
    return ok({ disponivel: false, numeros: [], erro: null }, { requestId });
  }

  const lista = await listarNumerosDaConta(conta);
  if (!lista.ok) {
    return ok({ disponivel: true, numeros: [], erro: lista.motivo }, { requestId });
  }
  const estados = await estadoDosNumeros(
    authz.org.orgId,
    lista.numeros.map((n) => n.phoneNumberId),
  );
  return ok(
    {
      disponivel: true,
      erro: null,
      numeros: lista.numeros.map((n) => ({
        phone_number_id: n.phoneNumberId,
        numero: n.numero,
        nome: n.nome,
        no_app: n.noApp,
        estado: estados.get(n.phoneNumberId) ?? "livre",
      })),
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

  const conta = contaDaMetaDoAmbiente();
  if (!conta || !authz.user.is_platform_admin || authz.user.support) {
    return fail("forbidden", t("Só quem administra a instalação liga números da conta da Meta."), 403, {
      requestId,
    });
  }

  const parsed = ligarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", t("Escolha um número da lista."), 422, { requestId });
  }
  const { phone_number_id } = parsed.data;

  // O corpo escolhe entre os números que a Meta lista; não inventa um.
  const lista = await listarNumerosDaConta(conta);
  if (!lista.ok) {
    return fail("invalid_request", `${t("A Meta não respondeu à lista de números:")} ${lista.motivo}`, 422, {
      requestId,
    });
  }
  const numero = lista.numeros.find((n) => n.phoneNumberId === phone_number_id);
  if (!numero) {
    return fail("invalid_request", t("Esse número não está na conta da Meta desta instalação."), 422, {
      requestId,
    });
  }

  const estados = await estadoDosNumeros(authz.org.orgId, [phone_number_id]);
  if (estados.get(phone_number_id) === "em_uso") {
    return fail("conflict", t("Esse número já está ligado a outra organização."), 409, { requestId });
  }

  const conexao = await conectarCanalOficial({
    organizationId: authz.org.orgId,
    userId: authz.user.id,
    requestId,
    phoneNumberId: phone_number_id,
    wabaId: conta.wabaId,
    token: conta.token,
    base: basePublicaDoWebhookMeta(req),
    t,
  });
  if (!conexao.ok) return fail(conexao.code, conexao.message, conexao.status, { requestId });

  // Número que ainda vive no app WhatsApp Business (coexistência): a Meta aceita o
  // pedido de sincronização de contatos e histórico uma vez, e só logo depois do
  // cadastro. A recusa não desfaz a ligação — vai no resultado.
  const sincronizacao =
    numero.noApp === true
      ? await pedirSincronizacaoDoApp({ phoneNumberId: phone_number_id, token: conta.token })
      : [];

  void audit({
    action: "channel.connected",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "channel_session",
    resourceId: conexao.channelSessionId,
    requestId,
    metadata: {
      canal: "oficial",
      origem: "numeros_da_conta",
      coexistencia: numero.noApp === true,
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
