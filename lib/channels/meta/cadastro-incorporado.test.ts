import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configDoCadastroIncorporado,
  EVENTO_DE_NUMERO_DO_APP,
  pedirSincronizacaoDoApp,
  trocarCodigoPorToken,
} from "./cadastro-incorporado";

afterEach(() => vi.unstubAllGlobals());

const resposta = (ok: boolean, body: unknown, status = ok ? 200 : 400) =>
  ({ ok, status, json: async () => body }) as Response;

describe("configDoCadastroIncorporado", () => {
  it("sem app id ou sem configuração o botão não existe", () => {
    expect(configDoCadastroIncorporado({})).toBeNull();
    expect(configDoCadastroIncorporado({ META_APP_ID: "123" })).toBeNull();
    expect(configDoCadastroIncorporado({ META_EMBEDDED_SIGNUP_CONFIG_ID: "9" })).toBeNull();
  });

  it("vazio com espaços conta como ausente (o .env.example gera `CHAVE=`)", () => {
    expect(configDoCadastroIncorporado({ META_APP_ID: "  ", META_EMBEDDED_SIGNUP_CONFIG_ID: "9" })).toBeNull();
  });

  it("com os dois devolve os ids e a versão da Graph", () => {
    const c = configDoCadastroIncorporado({ META_APP_ID: " 123 ", META_EMBEDDED_SIGNUP_CONFIG_ID: "9" });
    expect(c).toMatchObject({ appId: "123", configId: "9" });
    expect(c?.graphVersion).toMatch(/^v\d+\.\d+$/);
  });
});

describe("EVENTO_DE_NUMERO_DO_APP", () => {
  it("é o evento da coexistência, não o do número novo", () => {
    expect(EVENTO_DE_NUMERO_DO_APP).toBe("FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING");
  });
});

describe("trocarCodigoPorToken", () => {
  it("manda o segredo no CORPO, nunca na URL", async () => {
    const f = vi.fn().mockResolvedValue(resposta(true, { access_token: "EAAB" }));
    vi.stubGlobal("fetch", f);
    const r = await trocarCodigoPorToken({ code: "codigo-1234567", appId: "APP", appSecret: "segredo" });
    expect(r).toEqual({ ok: true, token: "EAAB" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit & { body: URLSearchParams | string }];
    expect(String(url)).toContain("/oauth/access_token");
    expect(String(url)).not.toContain("segredo");
    expect(String(url)).not.toContain("codigo-1234567");
    expect(init.method).toBe("POST");
    const corpo = new URLSearchParams(String(init.body));
    expect(corpo.get("client_secret")).toBe("segredo");
    expect(corpo.get("client_id")).toBe("APP");
    expect(corpo.get("code")).toBe("codigo-1234567");
  });

  it("devolve o motivo da Meta quando o código vence", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(resposta(false, { error: { message: "Invalid", error_data: { details: "code expired" } } })),
    );
    expect(await trocarCodigoPorToken({ code: "x".repeat(12), appId: "A", appSecret: "S" })).toEqual({
      ok: false,
      motivo: "code expired",
    });
  });

  it("resposta sem access_token é falha, mesmo com HTTP 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resposta(true, {})));
    const r = await trocarCodigoPorToken({ code: "x".repeat(12), appId: "A", appSecret: "S" });
    expect(r.ok).toBe(false);
  });

  it("rede caída diz que é rede, não código ruim", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const r = await trocarCodigoPorToken({ code: "x".repeat(12), appId: "A", appSecret: "S" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivo).toContain("rede indisponível");
  });
});

describe("pedirSincronizacaoDoApp", () => {
  it("pede contatos e depois histórico, nessa ordem, com o token no cabeçalho", async () => {
    const f = vi.fn().mockResolvedValue(resposta(true, { success: true }));
    vi.stubGlobal("fetch", f);
    const r = await pedirSincronizacaoDoApp({ phoneNumberId: "555", token: "TOK" });
    expect(r.map((x) => [x.tipo, x.pedida])).toEqual([
      ["smb_app_state_sync", true],
      ["history", true],
    ]);
    expect(f).toHaveBeenCalledTimes(2);
    const [primeira, segunda] = f.mock.calls as unknown as [
      [string, { body: string; headers: Record<string, string> }],
      [string, { body: string }],
    ];
    expect(String(primeira[0])).toContain("/555/smb_app_data");
    expect(JSON.parse(primeira[1].body)).toEqual({
      messaging_product: "whatsapp",
      sync_type: "smb_app_state_sync",
    });
    expect(JSON.parse(segunda[1].body).sync_type).toBe("history");
    expect(primeira[1].headers.Authorization).toBe("Bearer TOK");
  });

  it("a recusa de um pedido não derruba o outro nem lança — o motivo vai ao resultado", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(resposta(false, { error: { message: "nope" } }))
      .mockResolvedValueOnce(resposta(true, {}));
    vi.stubGlobal("fetch", f);
    const r = await pedirSincronizacaoDoApp({ phoneNumberId: "555", token: "TOK" });
    expect(r[0]).toEqual({ tipo: "smb_app_state_sync", pedida: false, erro: "nope" });
    expect(r[1]).toEqual({ tipo: "history", pedida: true, erro: null });
  });
});
