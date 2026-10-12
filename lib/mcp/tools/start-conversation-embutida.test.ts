/**
 * crm_start_conversation_and_send com `media_base64`: o arquivo vem DENTRO da chamada (quem chama não precisa de endereço público),
 * o CRM guarda no molde da tela ({org}/{conversa}/out-{uuid}.{ext}) e envia por `media_storage_path` — nunca por `media_url`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const upload = vi.fn(async () => ({ error: null }));
vi.mock("@/lib/messaging/open-shared-contact-conversation", () => ({ openSharedContactConversation: vi.fn() }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({ storage: { from: () => ({ upload }) } })) }));
vi.mock("@/lib/messaging/ritmo-do-envio-por-token", () => ({
  depsDoRitmo: vi.fn(async () => ({})),
  segurarEnvioPorToken: vi.fn(async () => null),
  registrarEnvioPorToken: vi.fn(async () => {}),
}));

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { openSharedContactConversation } from "@/lib/messaging/open-shared-contact-conversation";
import type { McpContext } from "@/lib/mcp/types";

import { crmStartConversationAndSend } from "./start-conversation";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";
const CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";
const ctx = { organizationId: ORG_ID, role: "manager", actor: { type: "user", id: "u1" }, apiTokenId: "t", requestId: "r", supabase: {} } as unknown as McpContext;
const IMG = Buffer.alloc(600, 7).toString("base64");

beforeEach(() => {
  upload.mockClear();
  vi.mocked(openSharedContactConversation).mockResolvedValue({ conversation_id: CONVERSATION_ID, contact_id: CONTACT_ID });
  vi.mocked(sendMessageHandler).mockReset();
  vi.mocked(sendMessageHandler).mockResolvedValue({ id: "m1", status: "sent", external_id: "x", sent_at: "2026-10-12T00:00:00Z" } as never);
});

describe("crm_start_conversation_and_send — arquivo embutido", () => {
  it("guarda o arquivo na pasta da conversa e envia por media_storage_path", async () => {
    await crmStartConversationAndSend.handler(
      { channel_session_id: SESSION_ID, contact_id: CONTACT_ID, body: "Veja", type: "image", media_base64: IMG, media_mime: "image/jpeg" } as never,
      ctx,
    );
    const path = (upload.mock.calls[0] as unknown as [string])[0];
    expect(path).toMatch(new RegExp(`^${ORG_ID}/${CONVERSATION_ID}/out-[0-9a-f-]{36}\\.jpe?g$`));
    const sent = vi.mocked(sendMessageHandler).mock.calls[0]![2] as Record<string, unknown>;
    expect(sent.media_storage_path).toBe(path);
    expect(sent.media_url).toBeUndefined();
  });

  it("recusa sem media_mime, com os dois tipos de mídia juntos e tipo não suportado — sem enviar nada", async () => {
    const base = { channel_session_id: SESSION_ID, contact_id: CONTACT_ID, type: "image", media_base64: IMG } as never;
    await expect(crmStartConversationAndSend.handler(base, ctx)).rejects.toThrow(/media_mime/);
    await expect(crmStartConversationAndSend.handler({ ...(base as object), media_mime: "image/jpeg", media_url: "https://x.example/a.jpg" } as never, ctx)).rejects.toThrow(/OU/);
    await expect(crmStartConversationAndSend.handler({ ...(base as object), media_mime: "application/x-msdownload" } as never, ctx)).rejects.toThrow(/não suportado/);
    expect(upload).not.toHaveBeenCalled();
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });
});
