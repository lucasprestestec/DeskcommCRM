/**
 * crm_publish_whatsapp_status — trava de público (sem `contacts`, só com
 * `all_contacts: true`), sessão precisa estar WORKING e ser WAHA, e o envio vai
 * ao WahaClient com os contatos no formato `@c.us`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendStatusImage = vi.fn();
vi.mock("@/lib/waha/client", () => ({ getWahaClient: vi.fn(() => ({ sendStatusImage })) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/messaging/ritmo-do-envio-por-token", () => ({
  depsDoRitmo: vi.fn(async () => ({})),
  segurarEnvioPorToken: vi.fn(async () => null),
  registrarEnvioPorToken: vi.fn(async () => {}),
}));

import type { McpContext } from "@/lib/mcp/types";
import { crmPublishWhatsappStatus } from "./status";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const IMG = "A".repeat(200);

function makeCtx(sessao: Record<string, unknown> | null): McpContext {
  const chain = (data: unknown) => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.maybeSingle = () => Promise.resolve({ data });
    q.insert = () => Promise.resolve({ error: null });
    return q;
  };
  return {
    organizationId: ORG_ID,
    role: "manager",
    actor: { type: "api_token", id: "tok" },
    apiTokenId: "tok",
    requestId: "req-1",
    supabase: { from: (t: string) => chain(t === "channel_sessions" ? sessao : null) },
  } as unknown as McpContext;
}

const WORKING = { id: SESSION_ID, provider: "waha", status: "WORKING", waha_session_name: "loja", archived_at: null };
const base = { channel_session_id: SESSION_ID, image_base64: IMG, image_mime: "image/jpeg" as const };

describe("crm_publish_whatsapp_status", () => {
  beforeEach(() => sendStatusImage.mockReset().mockResolvedValue({ id: { id: "ST-1" } }));

  it("recusa sem contacts e sem all_contacts (nunca vai a todos por omissão)", async () => {
    await expect(crmPublishWhatsappStatus.handler(base as never, makeCtx(WORKING))).rejects.toThrow(/all_contacts/);
    expect(sendStatusImage).not.toHaveBeenCalled();
  });

  it("recusa contacts junto com all_contacts", async () => {
    await expect(
      crmPublishWhatsappStatus.handler({ ...base, contacts: ["5515999999999"], all_contacts: true } as never, makeCtx(WORKING)),
    ).rejects.toThrow(/OU/);
  });

  it("recusa sessão que não está WORKING e não posta", async () => {
    await expect(
      crmPublishWhatsappStatus.handler({ ...base, contacts: ["5515999999999"] } as never, makeCtx({ ...WORKING, status: "SCAN_QR_CODE" })),
    ).rejects.toThrow(/SCAN_QR_CODE/);
    expect(sendStatusImage).not.toHaveBeenCalled();
  });

  it("recusa sessão que não é WAHA", async () => {
    await expect(
      crmPublishWhatsappStatus.handler({ ...base, contacts: ["5515999999999"] } as never, makeCtx({ ...WORKING, provider: "meta_cloud", waha_session_name: null })),
    ).rejects.toThrow(/QR/);
  });

  it("posta para a lista, com @c.us, e devolve o id do Status", async () => {
    const r = await crmPublishWhatsappStatus.handler(
      { ...base, caption: "Promo", contacts: ["+55 (15) 99999-9999"] } as never,
      makeCtx(WORKING),
    );
    expect(sendStatusImage).toHaveBeenCalledWith("loja", { mimetype: "image/jpeg", data: IMG, caption: "Promo", contacts: ["5515999999999@c.us"] });
    expect(r).toEqual({ published: true, status_id: "ST-1", audience: "1 contato(s)" });
  });

  it("all_contacts: manda sem lista", async () => {
    await crmPublishWhatsappStatus.handler({ ...base, all_contacts: true } as never, makeCtx(WORKING));
    expect(sendStatusImage).toHaveBeenCalledWith("loja", expect.objectContaining({ contacts: [] }));
  });

  it("a imagem não vai para a auditoria", () => {
    expect(crmPublishWhatsappStatus.redigirParaAuditoria!({ image_base64: IMG, caption: "x" })).toEqual({ image_base64: "[imagem omitida]", caption: "x" });
  });
});
