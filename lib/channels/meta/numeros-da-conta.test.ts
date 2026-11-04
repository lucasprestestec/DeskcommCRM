import { afterEach, describe, expect, it, vi } from "vitest";

import { contaDaMetaDoAmbiente, listarNumerosDaConta } from "./numeros-da-conta";

afterEach(() => vi.unstubAllGlobals());

const resposta = (ok: boolean, body: unknown, status = ok ? 200 : 400) =>
  ({ ok, status, json: async () => body }) as Response;

const CONTA = { wabaId: "555", token: ["tok", "de", "teste"].join("-") };

describe("contaDaMetaDoAmbiente", () => {
  it("sem os dois valores a funcionalidade não existe", () => {
    expect(contaDaMetaDoAmbiente({})).toBeNull();
    expect(contaDaMetaDoAmbiente({ META_NUMEROS_WABA_ID: "1" })).toBeNull();
    expect(contaDaMetaDoAmbiente({ META_NUMEROS_TOKEN: "x" })).toBeNull();
  });

  it("vazio com espaços conta como ausente", () => {
    expect(contaDaMetaDoAmbiente({ META_NUMEROS_WABA_ID: " ", META_NUMEROS_TOKEN: "x" })).toBeNull();
  });

  it("NÃO herda o token de instalação de número único", () => {
    expect(
      contaDaMetaDoAmbiente({ META_SYSTEM_USER_TOKEN: "x", META_WABA_ID: "1", META_PHONE_NUMBER_ID: "2" }),
    ).toBeNull();
  });

  it("com os dois devolve a conta", () => {
    expect(contaDaMetaDoAmbiente({ META_NUMEROS_WABA_ID: " 77 ", META_NUMEROS_TOKEN: " abc " })).toEqual({
      wabaId: "77",
      token: "abc",
    });
  });
});

describe("listarNumerosDaConta", () => {
  it("lista os números da WABA, com o token no cabeçalho e nunca na URL", async () => {
    const f = vi.fn().mockResolvedValue(
      resposta(true, {
        data: [
          { id: "1", display_phone_number: "+55 15 99999-0000", verified_name: "Loja", is_on_biz_app: true },
          { id: "2", display_phone_number: "+1 555", verified_name: "Teste" },
          { display_phone_number: "sem id" },
        ],
      }),
    );
    vi.stubGlobal("fetch", f);
    const r = await listarNumerosDaConta(CONTA);
    expect(r).toEqual({
      ok: true,
      numeros: [
        { phoneNumberId: "1", numero: "+55 15 99999-0000", nome: "Loja", noApp: true },
        { phoneNumberId: "2", numero: "+1 555", nome: "Teste", noApp: null },
      ],
    });
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toContain("/555/phone_numbers");
    expect(url).not.toContain(CONTA.token);
    expect(init.headers.Authorization).toBe(`Bearer ${CONTA.token}`);
  });

  it("devolve o motivo da Meta quando recusa", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(resposta(false, { error: { message: "Invalid", error_data: { details: "token vencido" } } })),
    );
    expect(await listarNumerosDaConta(CONTA)).toEqual({ ok: false, motivo: "token vencido" });
  });

  it("rede caída diz que é rede", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const r = await listarNumerosDaConta(CONTA);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivo).toContain("rede indisponível");
  });
});
