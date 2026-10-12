/**
 * MCP — canais de WhatsApp da organização, SÓ LEITURA, para um sistema externo (o Piloto) mostrar ao cliente o
 * estado do número dele e o QR de pareamento dentro da própria tela, sem mandar o cliente para o CRM.
 *
 *  - crm_list_whatsapp_channels: lista os canais (id, nome, telefone, estado). Não cria nada.
 *  - crm_get_whatsapp_channel_qr: devolve o QR (imagem em base64) de UM canal que está esperando pareamento.
 *
 * O que NÃO está aqui, de propósito: criar canal. Isso exige uma pessoa logada, administradora e com a verificação
 * em duas etapas provada (a RPC `fn_reserve_channel_connection` confere `auth.uid()`); uma chave de API não passa e
 * esta tool não contorna. O canal nasce no CRM, na implantação do cliente; aqui o cliente só o PAREIA (escaneia o QR).
 * Pareamento religa o número, então a tool exige manager + escopo de escrita e recusa canal arquivado (como a rota da tela).
 */
import { z } from "zod";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { PROVIDERS_DE_MENSAGEM } from "@/lib/channels/capabilities";
import { getWahaClient } from "@/lib/waha/client";
import type { McpToolDefinition } from "../types";

const COLUNAS = "id, display_name, phone_number, status, status_reason, waha_session_name";

export const crmListWhatsappChannels: McpToolDefinition<Record<string, never>> = {
  name: "crm_list_whatsapp_channels",
  description:
    "Lista os números de WhatsApp (canais) da organização com o estado de cada um: WORKING (conectado), SCAN_QR_CODE (aguardando " +
    "pareamento pelo QR), STARTING, STOPPED ou FAILED. Só leitura; não cria nem altera canal.",
  inputSchema: {},
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (_input, ctx) => {
    const base = () =>
      ctx.supabase.from("channel_sessions").select(COLUNAS).eq("organization_id", ctx.organizationId).in("provider", [...PROVIDERS_DE_MENSAGEM]);
    const { data, error } = await queryTolerantToMissingArchived(
      () => base().is(ARCHIVED_AT, null).order("created_at", { ascending: true }),
      () => base().order("created_at", { ascending: true }),
    );
    if (error) throw new Error("Não foi possível listar os canais.");
    return {
      channels: (data ?? []).map((c) => {
        const r = c as unknown as Record<string, string | null>;
        return { channel_session_id: r.id, display_name: r.display_name, phone_number: r.phone_number, status: r.status, status_reason: r.status_reason, has_session: !!r.waha_session_name };
      }),
    };
  },
};

const qrShape = {
  channel_session_id: z.string().uuid().describe("Canal (número) que o cliente vai parear."),
};

export const crmGetWhatsappChannelQr: McpToolDefinition<typeof qrShape> = {
  name: "crm_get_whatsapp_channel_qr",
  description:
    "Devolve o QR code (PNG em base64) para parear o WhatsApp de UM canal que está em SCAN_QR_CODE. O QR vence em segundos: " +
    "chame de novo para renovar. Se a sessão caiu (FAILED/STOPPED) por QR vencido, reinicia só ela (sem logout) para gerar um novo. Se o canal já está conectado (WORKING), devolve só o estado, sem QR. Escanear o QR religa o número.",
  inputSchema: qrShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const buscar = (colunas: string) =>
      ctx.supabase.from("channel_sessions").select(colunas).eq("organization_id", ctx.organizationId).eq("id", input.channel_session_id).maybeSingle();
    const { data } = await queryTolerantToMissingArchived(
      () => buscar(`status, waha_session_name, ${ARCHIVED_AT}`),
      () => buscar("status, waha_session_name"),
    );
    const c = data as unknown as { status: string; waha_session_name: string | null; archived_at?: string | null } | null;
    if (!c) throw new Error("Canal não encontrado nesta organização.");
    if (c.archived_at) throw new Error("Canal excluído: não pode ser pareado de novo.");
    if (!c.waha_session_name) throw new Error("Este canal não pareia por QR.");
    if (c.status === "WORKING") return { status: c.status, qr_png_base64: null, message: "O WhatsApp já está conectado." };
    // O QR vence em ~2 minutos sem escaneamento e a sessão cai para FAILED/STOPPED. Reinício SUAVE (parar + subir, sem logout, como o
    // "Reconectar" da tela no modo padrão): só para canal que NÃO está conectado, nunca derruba um número em uso.
    if (c.status === "FAILED" || c.status === "STOPPED") {
      const waha = getWahaClient();
      if (!waha) throw new Error("O WhatsApp (WAHA) não está configurado neste ambiente.");
      try { await waha.stopSession(c.waha_session_name); } catch { /* sessão já parada */ }
      const remote = (await waha.startSession(c.waha_session_name)) as { status?: string };
      const next = remote.status ?? "STARTING";
      await ctx.supabase.from("channel_sessions").update({ status: next, status_reason: null, last_status_change_at: new Date().toISOString(), consecutive_health_fails: 0 })
        .eq("organization_id", ctx.organizationId).eq("id", input.channel_session_id);
      return { status: next, qr_png_base64: null, message: "O QR anterior venceu. Gerando um novo… aguarde alguns segundos." };
    }
    if (c.status !== "SCAN_QR_CODE") return { status: c.status, qr_png_base64: null, message: "O canal ainda não está pronto para o QR. Tente de novo em alguns segundos." };

    const baseUrl = process.env.WAHA_API_BASE_URL;
    const apiKey = process.env.WAHA_API_KEY;
    if (!baseUrl || !apiKey || apiKey === "dev_plaintext_change_me") throw new Error("O WhatsApp (WAHA) não está configurado neste ambiente.");
    const res = await fetch(`${baseUrl}/api/${encodeURIComponent(c.waha_session_name)}/auth/qr?format=image`, {
      headers: { "X-Api-Key": apiKey },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { status: c.status, qr_png_base64: null, message: `O QR ainda não ficou pronto (WAHA ${res.status}). Tente de novo.` };
    return { status: c.status, qr_png_base64: Buffer.from(await res.arrayBuffer()).toString("base64"), message: "Escaneie com o WhatsApp do celular: Aparelhos conectados → Conectar um aparelho." };
  },
};
