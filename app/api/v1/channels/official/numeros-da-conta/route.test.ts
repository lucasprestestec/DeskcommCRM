import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  conectar: vi.fn(),
  listar: vi.fn(),
  sync: vi.fn(),
  uso: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.support }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/channels/meta/conectar-canal", () => ({ conectarCanalOficial: h.conectar }));
vi.mock("@/lib/channels/meta/cadastro-incorporado", () => ({ pedirSincronizacaoDoApp: h.sync }));
vi.mock("@/lib/channels/meta/numeros-da-conta", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels/meta/numeros-da-conta")>()),
  listarNumerosDaConta: h.listar,
}));
vi.mock("@/lib/channels/archived", () => ({
  ARCHIVED_AT: "archived_at",
  queryTolerantToMissingArchived: async (q: () => unknown) => q(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          in: () => ({
            is: async () => ({ data: h.uso(), error: null }),
          }),
        }),
      }),
    }),
  }),
}));

import { GET, POST } from "./route";

const URL_ = "https://crm.test/api/v1/channels/official/numeros-da-conta";
const req = (method: string, body?: unknown) =>
  new NextRequest(URL_, { method, body: body === undefined ? undefined : JSON.stringify(body) });

const VALOR_DO_TOKEN = ["falso", "da", "conta"].join("-");

const ADMIN_DA_INSTALACAO = {
  ok: true,
  org: { orgId: "org-confiavel" },
  user: { id: "u1", idioma: "pt-BR", is_platform_admin: true, support: null },
};
const ADMIN_DE_ORG = {
  ok: true,
  org: { orgId: "org-confiavel" },
  user: { id: "u2", idioma: "pt-BR", is_platform_admin: false, support: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("META_NUMEROS_WABA_ID", "555");
  vi.stubEnv("META_NUMEROS_TOKEN", VALOR_DO_TOKEN);
  h.role.mockResolvedValue(ADMIN_DA_INSTALACAO);
  h.support.mockResolvedValue(null);
  h.listar.mockResolvedValue({
    ok: true,
    numeros: [
      { phoneNumberId: "11111111", numero: "+55 15 1", nome: "A", noApp: true },
      { phoneNumberId: "22222222", numero: "+55 15 2", nome: "B", noApp: false },
      { phoneNumberId: "33333333", numero: "+55 15 3", nome: "C", noApp: null },
    ],
  });
  h.uso.mockReturnValue([]);
  h.conectar.mockResolvedValue({
    ok: true,
    channelSessionId: "sess-1",
    displayName: "A",
    phoneNumber: "+5515",
    webhook: { registrado: true, url: "https://x", erro: null, em: "2026-11-04T00:00:00Z" },
  });
  h.sync.mockResolvedValue([{ tipo: "history", pedida: true, erro: null }]);
});

describe("GET", () => {
  it("admin de organização comum NÃO vê a lista — é a carteira de clientes de quem opera", async () => {
    h.role.mockResolvedValue(ADMIN_DE_ORG);
    const { data } = await (await GET()).json();
    expect(data).toEqual({ disponivel: false, numeros: [], erro: null });
    expect(h.listar).not.toHaveBeenCalled();
  });

  it("modo suporte também não vê", async () => {
    h.role.mockResolvedValue({ ...ADMIN_DA_INSTALACAO, user: { ...ADMIN_DA_INSTALACAO.user, support: { status: "active" } } });
    const { data } = await (await GET()).json();
    expect(data.disponivel).toBe(false);
    expect(h.listar).not.toHaveBeenCalled();
  });

  it("instalação sem a conta configurada: não existe", async () => {
    vi.stubEnv("META_NUMEROS_TOKEN", "");
    const { data } = await (await GET()).json();
    expect(data.disponivel).toBe(false);
  });

  it("administrador da instalação vê os números, com o estado de cada um, sem revelar a outra organização", async () => {
    h.uso.mockReturnValue([
      { organization_id: "org-confiavel", meta_phone_number_id: "11111111" },
      { organization_id: "org-de-outro-cliente", meta_phone_number_id: "22222222" },
    ]);
    const r = await GET();
    const texto = JSON.stringify(await r.json());
    expect(texto).not.toContain("org-de-outro-cliente");
    expect(texto).not.toContain(VALOR_DO_TOKEN);
    const { data } = JSON.parse(texto);
    expect(data.numeros.map((n: { phone_number_id: string; estado: string }) => [n.phone_number_id, n.estado])).toEqual([
      ["11111111", "nesta_organizacao"],
      ["22222222", "em_uso"],
      ["33333333", "livre"],
    ]);
  });

  it("falha da Meta vira motivo na resposta, não erro 500", async () => {
    h.listar.mockResolvedValue({ ok: false, motivo: "token vencido" });
    const r = await GET();
    expect(r.status).toBe(200);
    expect((await r.json()).data).toMatchObject({ disponivel: true, erro: "token vencido", numeros: [] });
  });
});

describe("POST", () => {
  it("liga o número escolhido à organização DA SESSÃO, nunca à do corpo", async () => {
    const r = await POST(req("POST", { phone_number_id: "11111111", organization_id: "org-do-atacante" }));
    expect(r.status).toBe(200);
    expect(h.conectar).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-confiavel", phoneNumberId: "11111111", wabaId: "555", token: VALOR_DO_TOKEN }),
    );
    expect(JSON.stringify(await r.json())).not.toContain(VALOR_DO_TOKEN);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "channel.connected", organizationId: "org-confiavel" }),
    );
  });

  it("pede a sincronização só para número que ainda vive no app WhatsApp Business", async () => {
    await POST(req("POST", { phone_number_id: "11111111" }));
    expect(h.sync).toHaveBeenCalledTimes(1);
    h.sync.mockClear();
    await POST(req("POST", { phone_number_id: "22222222" }));
    expect(h.sync).not.toHaveBeenCalled();
  });

  it("admin de organização comum é recusado antes de qualquer chamada à Meta", async () => {
    h.role.mockResolvedValue(ADMIN_DE_ORG);
    const r = await POST(req("POST", { phone_number_id: "11111111" }));
    expect(r.status).toBe(403);
    expect(h.listar).not.toHaveBeenCalled();
    expect(h.conectar).not.toHaveBeenCalled();
  });

  it("número que a Meta não lista na conta é recusado (o corpo não inventa endereço)", async () => {
    const r = await POST(req("POST", { phone_number_id: "999999" }));
    expect(r.status).toBe(422);
    expect(h.conectar).not.toHaveBeenCalled();
  });

  it("número já ligado a OUTRA organização é recusado com 409", async () => {
    h.uso.mockReturnValue([{ organization_id: "org-de-outro-cliente", meta_phone_number_id: "11111111" }]);
    const r = await POST(req("POST", { phone_number_id: "11111111" }));
    expect(r.status).toBe(409);
    expect(h.conectar).not.toHaveBeenCalled();
  });

  it("corpo inválido é 422 e não toca na Meta", async () => {
    const r = await POST(req("POST", { phone_number_id: "abc" }));
    expect(r.status).toBe(422);
    expect(h.listar).not.toHaveBeenCalled();
  });

  it("falha ao conectar não audita nem pede sincronização", async () => {
    h.conectar.mockResolvedValue({ ok: false, status: 422, code: "invalid_request", message: "recusado" });
    const r = await POST(req("POST", { phone_number_id: "11111111" }));
    expect(r.status).toBe(422);
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("modo suporte sem escrita é barrado antes de tudo", async () => {
    h.support.mockResolvedValue(new Response(null, { status: 403 }));
    const r = await POST(req("POST", { phone_number_id: "11111111" }));
    expect(r.status).toBe(403);
    expect(h.role).not.toHaveBeenCalled();
  });
});
