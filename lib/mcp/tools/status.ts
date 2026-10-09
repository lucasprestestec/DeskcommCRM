/**
 * MCP write tool — crm_publish_whatsapp_status.
 *
 * Posta uma imagem no Status do WhatsApp de UM número do CRM (sessão WAHA), a
 * pedido de um sistema externo — hoje o Piloto/Marketing, depois da aprovação
 * do dono. Nada de envio novo: usa o `WahaClient` do CRM e a sessão que o CRM já
 * gerencia (QR, saúde, reconexão), então nenhuma porta do WAHA precisa sair da VPS.
 *
 * Duas travas deste arquivo, de propósito:
 *  - Sem `contacts` o Status iria para TODOS os contatos do número. Para isso
 *    acontecer o chamador tem de dizer `all_contacts: true` — nunca por omissão.
 *  - Passa pelo freio anti-ban do número (`ritmo-do-envio-por-token`), como o envio de mensagem.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

import { getWahaClient } from "@/lib/waha/client";
import { depsDoRitmo, registrarEnvioPorToken, segurarEnvioPorToken } from "@/lib/messaging/ritmo-do-envio-por-token";
import { createAdminClient } from "@/lib/supabase/admin";
import type { McpToolDefinition } from "../types";

const ENDPOINT_TAG = "mcp:crm_publish_whatsapp_status";
// ~6 MB de base64 ≈ 4,5 MB de imagem: sobra para um JPEG 9:16 e barra upload absurdo.
const MAX_BASE64 = 6_000_000;

const inputShape = {
  channel_session_id: z.string().uuid().describe("Sessão de canal (número) cujo Status será publicado."),
  image_base64: z.string().min(100).max(MAX_BASE64).describe("Imagem em base64, sem o prefixo data:."),
  image_mime: z.enum(["image/jpeg", "image/png"]).optional().default("image/jpeg"),
  caption: z.string().max(1000).optional(),
  contacts: z
    .array(z.string().min(8).max(20))
    .max(500)
    .optional()
    .describe("Telefones (só dígitos, com DDI) que verão o Status. Exige o Store do NOWEB ativo no WAHA."),
  all_contacts: z
    .boolean()
    .optional()
    .describe("true = todos os contatos do número. Só use com autorização explícita do dono."),
  idempotency_key: z.string().min(1).max(200).optional().describe("Deduplicação (24h)."),
};

const digits = (s: string) => s.replace(/\D/g, "");

export const crmPublishWhatsappStatus: McpToolDefinition<typeof inputShape> = {
  name: "crm_publish_whatsapp_status",
  description:
    "Publica uma IMAGEM no Status do WhatsApp do número `channel_session_id` (sessão WAHA conectada). " +
    "Informe `contacts` (telefones que verão) ou `all_contacts: true` (todos os contatos) — um dos dois é obrigatório. " +
    "Use só depois de o dono aprovar a peça. Forneça `idempotency_key` para não postar em dobro num retry (TTL 24h).",
  inputSchema: inputShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  // A imagem em base64 não pode ir para o log de auditoria.
  redigirParaAuditoria: (args) => ({ ...args, image_base64: "[imagem omitida]" }),
  handler: async (input, ctx) => {
    const lista = (input.contacts ?? []).map(digits).filter(Boolean);
    if (!lista.length && !input.all_contacts) {
      throw new Error("Informe `contacts` ou `all_contacts: true`: o Status não sai para todos por omissão.");
    }
    if (lista.length && input.all_contacts) {
      throw new Error("Use `contacts` OU `all_contacts`, não os dois.");
    }

    const requestHash = createHash("sha256")
      .update(JSON.stringify({ s: input.channel_session_id, c: lista, all: !!input.all_contacts, cap: input.caption, img: createHash("sha256").update(input.image_base64).digest("hex") }))
      .digest("hex");

    if (input.idempotency_key) {
      const { data: cached } = await ctx.supabase
        .from("idempotency_keys")
        .select("response_body")
        .eq("organization_id", ctx.organizationId)
        .eq("endpoint", ENDPOINT_TAG)
        .eq("key", input.idempotency_key)
        .maybeSingle();
      if (cached) return { ...(cached.response_body as Record<string, unknown>), deduplicated: true };
    }

    const { data: sessao } = await ctx.supabase
      .from("channel_sessions")
      .select("id, provider, status, waha_session_name, archived_at")
      .eq("organization_id", ctx.organizationId)
      .eq("id", input.channel_session_id)
      .maybeSingle();
    if (!sessao || sessao.archived_at) throw new Error("Sessão de canal não encontrada.");
    if (sessao.provider !== "waha" || !sessao.waha_session_name) {
      throw new Error("Status só é suportado em número conectado por QR (WAHA).");
    }
    if (sessao.status !== "WORKING") {
      throw new Error(`O WhatsApp deste número não está conectado (estado: ${sessao.status}). Reconecte pelo QR Code.`);
    }
    const client = getWahaClient();
    if (!client) throw new Error("waha_not_configured");

    const ritmo = await depsDoRitmo(createAdminClient());
    const segurado = await segurarEnvioPorToken(ritmo, {
      organizationId: ctx.organizationId,
      channelSessionId: input.channel_session_id,
      requestId: ctx.requestId,
    });

    const resposta = (await client.sendStatusImage(sessao.waha_session_name, {
      mimetype: input.image_mime,
      data: input.image_base64,
      caption: input.caption,
      contacts: lista.map((c) => `${c}@c.us`),
    })) as { id?: { id?: string } | string } | null;
    await registrarEnvioPorToken(ritmo, ctx.organizationId, segurado, "sent");

    const status_id = typeof resposta?.id === "string" ? resposta.id : (resposta?.id?.id ?? null);
    const response = {
      published: true,
      status_id,
      audience: input.all_contacts ? "all_contacts" : `${lista.length} contato(s)`,
    };

    if (input.idempotency_key) {
      await ctx.supabase
        .from("idempotency_keys")
        .insert({
          organization_id: ctx.organizationId,
          endpoint: ENDPOINT_TAG,
          key: input.idempotency_key,
          request_hash: requestHash,
          response_body: response,
          status_code: 200,
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        })
        .then(({ error }) => {
          if (error && error.code !== "23505") console.error("[mcp.publish_whatsapp_status] idempotency cache failed", error.message);
        });
    }
    return response;
  },
};
