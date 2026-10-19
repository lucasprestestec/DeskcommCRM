/**
 * Canais de WhatsApp pelo MCP (leitura, pareamento e desconectar/trocar número): lista com estado, QR só quando o canal espera pareamento,
 * nunca de canal de outra organização nem arquivado, e nada de criar canal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { stopSession, logoutSession, startSession, definirRecebimentoDeGrupos, audit, assertWahaConnectionIdle, sincronizarRecebimentoDeGrupos } = vi.hoisted(() => ({
  stopSession: vi.fn(async () => {}),
  logoutSession: vi.fn(async () => {}),
  startSession: vi.fn(async () => ({ status: "STARTING" })),
  definirRecebimentoDeGrupos: vi.fn(async () => {}),
  audit: vi.fn(async () => {}),
  assertWahaConnectionIdle: vi.fn(async () => {}),
  sincronizarRecebimentoDeGrupos: vi.fn(async () => {}),
}));
vi.mock("@/lib/waha/client", () => ({ getWahaClient: () => ({ stopSession, logoutSession, startSession, definirRecebimentoDeGrupos }) }));
vi.mock("@/lib/audit", () => ({ audit }));
vi.mock("@/lib/channels/connect-waha", () => ({ assertWahaConnectionIdle }));
vi.mock("@/lib/grupos/sincronizar-filtro", () => ({ sincronizarRecebimentoDeGrupos }));

import type { McpContext } from "@/lib/mcp/types";

import { crmGetWhatsappChannelQr, crmListWhatsappChannels, crmResetWhatsappChannel } from "./canal-whatsapp";

const ORG = "11111111-1111-4111-8111-111111111111";
const CH = "22222222-2222-4222-8222-222222222222";

// Cliente falso do PostgREST: registra os filtros e devolve `rows`/`row`.
function ctxWith(opts: { rows?: unknown[]; row?: unknown }): { ctx: McpContext; filters: Array<[string, unknown]>; updates: unknown[] } {
  const updates: unknown[] = [];
  const filters: Array<[string, unknown]> = [];
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    select: self,
    eq: (k: string, v: unknown) => (filters.push([k, v]), chain),
    in: self,
    update: (v: unknown) => (updates.push(v), chain),
    is: self,
    order: () => Promise.resolve({ data: opts.rows ?? [], error: null }),
    maybeSingle: () => Promise.resolve({ data: opts.row ?? null, error: null }),
    then: (ok: (v: unknown) => void) => ok({ data: null, error: null }),
  });
  const ctx = { organizationId: ORG, role: "manager", actor: { type: "user", id: "u" }, apiTokenId: "t", requestId: "r", supabase: { from: () => chain } } as unknown as McpContext;
  return { ctx, filters, updates };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("crm_list_whatsapp_channels", () => {
  it("lista só os canais da organização do token, com o estado de cada um", async () => {
    const { ctx, filters } = ctxWith({ rows: [{ id: CH, display_name: "Loja", phone_number: "5515991462230", status: "SCAN_QR_CODE", status_reason: null, waha_session_name: "s1" }] });
    const r = (await crmListWhatsappChannels.handler({} as never, ctx)) as { channels: Array<Record<string, unknown>> };
    expect(filters).toContainEqual(["organization_id", ORG]);
    expect(r.channels[0]).toMatchObject({ channel_session_id: CH, status: "SCAN_QR_CODE", has_session: true });
  });
});

describe("crm_get_whatsapp_channel_qr", () => {
  it("devolve o QR em base64 quando o canal espera pareamento, e consulta o canal DENTRO da organização", async () => {
    vi.stubEnv("WAHA_API_BASE_URL", "http://waha:3000");
    vi.stubEnv("WAHA_API_KEY", "chave-de-teste");
    const fetchMock = vi.fn(async () => new Response(Buffer.from("PNGDATA"), { status: 200, headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, filters } = ctxWith({ row: { status: "SCAN_QR_CODE", waha_session_name: "sessao-1", archived_at: null } });
    const r = (await crmGetWhatsappChannelQr.handler({ channel_session_id: CH } as never, ctx)) as { qr_png_base64: string };
    expect(Buffer.from(r.qr_png_base64, "base64").toString()).toBe("PNGDATA");
    expect(filters).toEqual(expect.arrayContaining([["organization_id", ORG], ["id", CH]]));
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("http://waha:3000/api/sessao-1/auth/qr?format=image");
  });

  it("canal já conectado devolve só o estado; canal de outra org, arquivado ou sem sessão recusa; o WAHA nem é chamado", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const run = (row: unknown) => crmGetWhatsappChannelQr.handler({ channel_session_id: CH } as never, ctxWith({ row }).ctx);
    expect(await run({ status: "WORKING", waha_session_name: "s", archived_at: null })).toMatchObject({ status: "WORKING", qr_png_base64: null });
    expect(await run({ status: "STARTING", waha_session_name: "s", archived_at: null })).toMatchObject({ qr_png_base64: null });
    await expect(run(null)).rejects.toThrow(/não encontrado/);
    await expect(run({ status: "SCAN_QR_CODE", waha_session_name: "s", archived_at: "2026-01-01" })).rejects.toThrow(/excluído/);
    await expect(run({ status: "SCAN_QR_CODE", waha_session_name: null, archived_at: null })).rejects.toThrow(/não pareia por QR/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("crm_get_whatsapp_channel_qr — QR vencido", () => {
  it("canal caído (FAILED/STOPPED) é reiniciado de forma suave, sem logout, e o estado do banco vira STARTING", async () => {
    for (const status of ["FAILED", "STOPPED"]) {
      stopSession.mockClear();
      startSession.mockClear();
      const { ctx, updates } = ctxWith({ row: { status, waha_session_name: "sessao-1", archived_at: null } });
      const r = (await crmGetWhatsappChannelQr.handler({ channel_session_id: CH } as never, ctx)) as { status: string; qr_png_base64: null };
      expect([r.status, r.qr_png_base64]).toEqual(["STARTING", null]);
      expect(stopSession).toHaveBeenCalledWith("sessao-1");
      expect(startSession).toHaveBeenCalledWith("sessao-1");
      expect(updates[0]).toMatchObject({ status: "STARTING", status_reason: null });
    }
  });

  it("canal conectado (WORKING) ou esperando o QR NUNCA é reiniciado", async () => {
    vi.stubEnv("WAHA_API_BASE_URL", "http://waha:3000");
    vi.stubEnv("WAHA_API_KEY", "chave-de-teste");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.from("X"), { status: 200 })));
    stopSession.mockClear();
    for (const status of ["WORKING", "SCAN_QR_CODE", "STARTING"]) await crmGetWhatsappChannelQr.handler({ channel_session_id: CH } as never, ctxWith({ row: { status, waha_session_name: "s", archived_at: null } }).ctx);
    expect(stopSession).not.toHaveBeenCalled();
  });
});

describe("crm_reset_whatsapp_channel", () => {
  const run = (row: unknown, input: Record<string, unknown> = {}) =>
    crmResetWhatsappChannel.handler({ channel_session_id: CH, ...input } as never, ctxWith({ row }).ctx);
  const ok = { status: "WORKING", waha_session_name: "sessao-1", archived_at: null };

  it("trocar de número: para, desloga e sobe de novo, grava STARTING, ressincroniza grupos e audita", async () => {
    for (const m of [stopSession, logoutSession, startSession, audit, sincronizarRecebimentoDeGrupos]) m.mockClear();
    const { ctx, updates, filters } = ctxWith({ row: ok });
    const r = (await crmResetWhatsappChannel.handler({ channel_session_id: CH } as never, ctx)) as { status: string };
    expect(r.status).toBe("STARTING");
    expect(stopSession).toHaveBeenCalledWith("sessao-1");
    expect(logoutSession).toHaveBeenCalledWith("sessao-1");
    expect(startSession).toHaveBeenCalledWith("sessao-1");
    expect(updates[0]).toMatchObject({ status: "STARTING", status_reason: null });
    expect(filters).toEqual(expect.arrayContaining([["organization_id", ORG], ["id", CH]]));
    expect(sincronizarRecebimentoDeGrupos).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "channel.reconnected", organizationId: ORG, metadata: expect.objectContaining({ force: true, reconnect: true, via: "mcp" }) }));
  });

  it("desconectar (reconnect=false): desloga e deixa o canal STOPPED, sem subir a sessão", async () => {
    for (const m of [stopSession, logoutSession, startSession, sincronizarRecebimentoDeGrupos]) m.mockClear();
    const { ctx, updates } = ctxWith({ row: ok });
    const r = (await crmResetWhatsappChannel.handler({ channel_session_id: CH, reconnect: false } as never, ctx)) as { status: string };
    expect(r.status).toBe("STOPPED");
    expect(logoutSession).toHaveBeenCalledOnce();
    expect(startSession).not.toHaveBeenCalled();
    expect(sincronizarRecebimentoDeGrupos).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ status: "STOPPED" });
  });

  it("canal de outra org, arquivado ou sem sessão recusa, e o WAHA nem é chamado", async () => {
    for (const m of [stopSession, logoutSession, startSession]) m.mockClear();
    await expect(run(null)).rejects.toThrow(/não encontrado/);
    await expect(run({ ...ok, archived_at: "2026-01-01" })).rejects.toThrow(/excluído/);
    await expect(run({ ...ok, waha_session_name: null })).rejects.toThrow(/não conecta por QR/);
    expect(stopSession).not.toHaveBeenCalled();
    expect(logoutSession).not.toHaveBeenCalled();
  });

  it("falha do WAHA vira erro legível e o banco NÃO é atualizado", async () => {
    logoutSession.mockRejectedValueOnce(new Error("waha_delete_200"));
    const { ctx, updates } = ctxWith({ row: ok });
    await expect(crmResetWhatsappChannel.handler({ channel_session_id: CH } as never, ctx)).rejects.toThrow(/Não foi possível trocar o número agora \(waha_delete_200\)/);
    expect(updates).toHaveLength(0);
  });
});
