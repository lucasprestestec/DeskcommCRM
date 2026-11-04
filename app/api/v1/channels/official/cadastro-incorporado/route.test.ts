import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Cadastro from "@/lib/channels/meta/cadastro-incorporado";

const h = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  appDaMeta: vi.fn(),
  conectar: vi.fn(),
  trocar: vi.fn(),
  sync: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.support }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/channels/meta/app", () => ({ appDaMeta: h.appDaMeta }));
vi.mock("@/lib/channels/meta/conectar-canal", () => ({ conectarCanalOficial: h.conectar }));
vi.mock("@/lib/channels/meta/cadastro-incorporado", async (orig) => ({
  ...(await orig<typeof Cadastro>()),
  trocarCodigoPorToken: h.trocar,
  pedirSincronizacaoDoApp: h.sync,
}));

import { GET, POST } from "./route";

const URL_ = "https://crm.test/api/v1/channels/official/cadastro-incorporado";
const req = (method: string, body?: unknown) =>
  new NextRequest(URL_, { method, body: body === undefined ? undefined : JSON.stringify(body) });

// Valores de teste montados em tempo de execução: não são credenciais, e não devem parecer uma.
const VALOR_DO_APP = ["falso", "do", "app"].join("-");
const VALOR_DO_CLIENTE = ["falso", "do", "cliente"].join("-");

const CORPO = {
  code: "codigo-de-uso-unico",
  waba_id: "1234567890",
  phone_number_id: "9876543210",
  evento: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("META_APP_ID", "APP1");
  vi.stubEnv("META_EMBEDDED_SIGNUP_CONFIG_ID", "CFG1");
  h.role.mockResolvedValue({
    ok: true,
    org: { orgId: "org-confiavel" },
    user: { id: "admin", idioma: "pt-BR" },
  });
  h.support.mockResolvedValue(null);
  h.appDaMeta.mockResolvedValue({ appSecret: VALOR_DO_APP, verifyToken: "v" });
  h.trocar.mockResolvedValue({ ok: true, token: VALOR_DO_CLIENTE });
  h.conectar.mockResolvedValue({
    ok: true,
    channelSessionId: "sess-1",
    displayName: "Loja",
    phoneNumber: "+5515",
    webhook: { registrado: true, url: "https://x", erro: null, em: "2026-11-04T00:00:00Z" },
  });
  h.sync.mockResolvedValue([
    { tipo: "smb_app_state_sync", pedida: true, erro: null },
    { tipo: "history", pedida: true, erro: null },
  ]);
});

describe("GET", () => {
  it("exige admin e diz o que falta, sem nunca devolver o valor do segredo", async () => {
    h.appDaMeta.mockResolvedValue({ appSecret: null, verifyToken: null });
    const r = await GET();
    expect(h.role).toHaveBeenCalledWith("admin", expect.anything());
    const { data } = await r.json();
    expect(data.disponivel).toBe(false);
    expect(data.faltando).toEqual(["META_APP_SECRET"]);
  });

  it("disponível quando app id, configuração e segredo existem — e o segredo não vai na resposta", async () => {
    const { data } = await (await GET()).json();
    expect(data).toMatchObject({
      disponivel: true,
      app_id: "APP1",
      config_id: "CFG1",
      faltando: [],
    });
    expect(JSON.stringify(data)).not.toContain(VALOR_DO_APP);
  });
});

describe("POST", () => {
  it("troca o código, conecta com a ORGANIZAÇÃO da sessão (nunca do corpo) e pede a sincronização", async () => {
    const r = await POST(req("POST", { ...CORPO, organization_id: "org-do-atacante" }));
    expect(r.status).toBe(200);
    expect(h.trocar).toHaveBeenCalledWith(
      expect.objectContaining({ code: CORPO.code, appId: "APP1" }),
    );
    expect(h.conectar).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-confiavel",
        token: VALOR_DO_CLIENTE,
        wabaId: "1234567890",
      }),
    );
    expect(h.sync).toHaveBeenCalledWith({ phoneNumberId: "9876543210", token: VALOR_DO_CLIENTE });
    const { data } = await r.json();
    expect(data).toMatchObject({ connected: true, displayName: "Loja" });
    expect(JSON.stringify(data)).not.toContain(VALOR_DO_CLIENTE);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "channel.connected", organizationId: "org-confiavel" }),
    );
  });

  it("número NOVO (FINISH) é recusado antes de gastar o código", async () => {
    const r = await POST(req("POST", { ...CORPO, evento: "FINISH" }));
    expect(r.status).toBe(422);
    expect(h.trocar).not.toHaveBeenCalled();
    expect(h.conectar).not.toHaveBeenCalled();
  });

  it("corpo incompleto é 422 e não toca na Meta", async () => {
    const r = await POST(req("POST", { code: "curto" }));
    expect(r.status).toBe(422);
    expect(h.trocar).not.toHaveBeenCalled();
  });

  it("instalação sem App Secret diz o que falta e não gasta o código", async () => {
    h.appDaMeta.mockResolvedValue({ appSecret: null, verifyToken: null });
    const r = await POST(req("POST", CORPO));
    expect(r.status).toBe(422);
    expect((await r.json()).error.message).toContain("META_APP_SECRET");
    expect(h.trocar).not.toHaveBeenCalled();
  });

  it("código recusado pela Meta não grava canal nenhum", async () => {
    h.trocar.mockResolvedValue({ ok: false, motivo: "code expired" });
    const r = await POST(req("POST", CORPO));
    expect(r.status).toBe(422);
    expect((await r.json()).error.message).toContain("code expired");
    expect(h.conectar).not.toHaveBeenCalled();
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("falha ao conectar não pede sincronização nem audita", async () => {
    h.conectar.mockResolvedValue({
      ok: false,
      status: 422,
      code: "invalid_request",
      message: "número fora da WABA",
    });
    const r = await POST(req("POST", CORPO));
    expect(r.status).toBe(422);
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("sincronização recusada NÃO desfaz a conexão: volta no resultado", async () => {
    h.sync.mockResolvedValue([
      { tipo: "smb_app_state_sync", pedida: false, erro: "nope" },
      { tipo: "history", pedida: true, erro: null },
    ]);
    const r = await POST(req("POST", CORPO));
    expect(r.status).toBe(200);
    const { data } = await r.json();
    expect(data.connected).toBe(true);
    expect(data.sincronizacao[0]).toMatchObject({ pedida: false, erro: "nope" });
  });

  it("modo suporte sem escrita é barrado antes de tudo", async () => {
    h.support.mockResolvedValue(new Response(null, { status: 403 }));
    const r = await POST(req("POST", CORPO));
    expect(r.status).toBe(403);
    expect(h.role).not.toHaveBeenCalled();
  });
});
