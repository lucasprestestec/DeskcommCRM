/**
 * Cadastro de clientes pelo MCP: cria quando o telefone é novo, atualiza (somando etiquetas e fatos) quando já existe,
 * normaliza o telefone brasileiro e nunca grava com telefone inválido ou sem nome (cliente novo).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/v1/contacts/_handler", () => ({
  createContactHandler: vi.fn(),
  patchContactHandler: vi.fn(),
  listContactsHandler: vi.fn(),
}));
vi.mock("@/lib/channels/contato-por-telefone", () => ({ encontrarContatoPorTelefone: vi.fn() }));

import { createContactHandler, listContactsHandler, patchContactHandler } from "@/app/api/v1/contacts/_handler";
import { encontrarContatoPorTelefone } from "@/lib/channels/contato-por-telefone";
import type { McpContext } from "@/lib/mcp/types";

import { crmListContacts, crmSaveContact, telefoneBR } from "./cadastro";

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const mkCtx = (row: unknown = null): McpContext => {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, { select: () => chain, eq: () => chain, maybeSingle: () => Promise.resolve({ data: row, error: null }) });
  return { organizationId: ORG, role: "manager", actor: { type: "user", id: "u" }, apiTokenId: "t", requestId: "r", supabase: { from: () => chain } } as unknown as McpContext;
};

beforeEach(() => {
  vi.mocked(createContactHandler).mockReset().mockResolvedValue({ contact: { id: ID }, action: "created" } as never);
  vi.mocked(patchContactHandler).mockReset().mockResolvedValue({} as never);
  vi.mocked(encontrarContatoPorTelefone).mockReset();
});

describe("telefoneBR", () => {
  it("aceita as grafias comuns do Brasil e devolve E.164; recusa lixo", () => {
    for (const raw of ["15 99111-2222", "(15) 99111-2222", "+55 15 99111-2222", "5515991112222"]) expect(telefoneBR(raw)).toMatch(/^\+55159?91112222$/);
    expect(telefoneBR("123")).toBeNull();
  });
});

describe("crm_save_contact", () => {
  it("cria cliente novo (telefone ainda não existe) com etiquetas e fatos, origem 'chico'", async () => {
    vi.mocked(encontrarContatoPorTelefone).mockResolvedValue(null);
    const r = (await crmSaveContact.handler({ name: "Maria Souza", phone_number: "15 99111-2222", tags: ["Coloração"], facts: { ultimo_servico: "coloração" } } as never, mkCtx())) as { created: boolean; contact_id: string };
    expect([r.created, r.contact_id]).toEqual([true, ID]);
    const sent = vi.mocked(createContactHandler).mock.calls[0]![2] as Record<string, unknown>;
    expect(sent).toMatchObject({ name: "Maria Souza", source: "chico", tags: ["coloração"], custom_fields: { ultimo_servico: "coloração" } });
    expect(String(sent.phone_number)).toMatch(/^\+55/);
  });

  it("recusa cliente novo sem nome e telefone inválido, sem gravar nada", async () => {
    vi.mocked(encontrarContatoPorTelefone).mockResolvedValue(null);
    await expect(crmSaveContact.handler({ phone_number: "15 99111-2222" } as never, mkCtx())).rejects.toThrow(/preciso do nome/);
    await expect(crmSaveContact.handler({ name: "X", phone_number: "123456789012345678" } as never, mkCtx())).rejects.toThrow(/Telefone inválido/);
    expect(createContactHandler).not.toHaveBeenCalled();
  });

  it("atualiza quem já existe SOMANDO etiquetas e fatos (nada é apagado) e só manda o que mudou", async () => {
    vi.mocked(encontrarContatoPorTelefone).mockResolvedValue({ id: ID, phone_number: "+5515991112222" });
    const r = (await crmSaveContact.handler({ phone_number: "15 99111-2222", tags: ["Mechas"], facts: { ultima_visita: "2026-09-10" } } as never, mkCtx({ id: ID, tags: ["coloração"], custom_fields: { ultimo_servico: "coloração" } }))) as { created: boolean; updated: string[] };
    expect([r.created, r.updated]).toEqual([false, ["tags", "custom_fields"]]);
    const patch = vi.mocked(patchContactHandler).mock.calls[0]![3] as Record<string, unknown>;
    expect(patch.tags).toEqual(["coloração", "mechas"]);
    expect(patch.custom_fields).toEqual({ ultimo_servico: "coloração", ultima_visita: "2026-09-10" });
    expect(patch.name).toBeUndefined();
  });

  it("existe e nada mudou: não chama a gravação", async () => {
    vi.mocked(encontrarContatoPorTelefone).mockResolvedValue({ id: ID, phone_number: "+5515991112222" });
    const r = (await crmSaveContact.handler({ phone_number: "15 99111-2222" } as never, mkCtx({ id: ID, tags: [], custom_fields: {} }))) as { updated: string[] };
    expect(r.updated).toEqual([]);
    expect(patchContactHandler).not.toHaveBeenCalled();
  });
});

describe("crm_list_contacts", () => {
  it("lista pela etiqueta, mais antigos primeiro quando pedido, e não devolve anonimizado nem bloqueado", async () => {
    vi.mocked(listContactsHandler).mockResolvedValue({ contacts: [
      { id: "a", name: "Maria", display_name: null, phone_number: "+5515991112222", tags: ["coloração"], custom_fields: { x: 1 }, is_anonymized: false, is_blocked: false, created_at: "c", last_activity_at: "l" },
      { id: "b", name: "Apagada", phone_number: "+5515000000000", tags: [], is_anonymized: true, is_blocked: false },
      { id: "c", name: "Bloqueada", phone_number: "+5515000000001", tags: [], is_anonymized: false, is_blocked: true },
    ], cursor: null, has_more: false } as never);
    const r = (await crmListContacts.handler({ tags: ["coloração"], order: "oldest", limit: 50 } as never, mkCtx())) as { contacts: Array<{ id: string }> };
    expect(r.contacts.map((c) => c.id)).toEqual(["a"]);
    expect(vi.mocked(listContactsHandler).mock.calls[0]![2]).toMatchObject({ tag: ["coloração"], modo: "e", order_by: "last_activity_at", order_dir: "asc" });
  });
});
