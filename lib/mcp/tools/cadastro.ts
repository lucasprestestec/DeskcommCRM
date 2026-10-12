/**
 * MCP — cadastro de clientes feito por um sistema externo (o Piloto/Chico) a pedido do DONO do negócio.
 *
 *  - crm_save_contact: cria o cliente ou atualiza o que já existe (a chave é o telefone).
 *  - crm_list_contacts: lista clientes por etiqueta, ordenados por atividade (a busca de `crm_search_contacts` não lista a base).
 *
 * POR QUE NÃO USAR `crm_propose_contact_field`. Aquela ferramenta é para o que um CLIENTE diz ao atendente de IA: nunca grava, vira
 * proposta para uma pessoa confirmar. Aqui quem dita o dado é o DONO, uma pessoa que o sistema externo representa depois da
 * autenticação dele, então a gravação é direta. Por isso: manager + `apenasHumano` (fora do alcance do agente conversacional),
 * escopo de escrita, e os MESMOS handlers da tela (criar e alterar contato), que já recusam contato anonimizado (LGPD) e auditam.
 */
import { z } from "zod";

import { createContactHandler, listContactsHandler, patchContactHandler } from "@/app/api/v1/contacts/_handler";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { encontrarContatoPorTelefone } from "@/lib/channels/contato-por-telefone";
import { normalizarTags } from "@/lib/contacts/tag-normalizada";
import type { McpToolDefinition } from "../types";

const E164 = /^\+\d{8,15}$/;
const MAX_CUSTOM_BYTES = 32_768;

/** "15 99111-2222", "(15) 99111-2222" e "+55 15 99111-2222" viram o mesmo número em E.164; lixo vira null. */
export function telefoneBR(raw: string): string | null {
  let d = raw.replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) d = "55" + d;
  const canon = canonicalPhoneBR("+" + d);
  const plus = canon.startsWith("+") ? canon : "+" + canon.replace(/\D/g, "");
  return E164.test(plus) ? plus : null;
}

const saveShape = {
  name: z.string().trim().min(1).max(200).optional().describe("Nome do cliente. Obrigatório para criar um cliente novo."),
  phone_number: z.string().min(8).max(32).describe("Telefone com DDD (aceita 15 99111-2222, (15) 99111-2222 ou +5515991112222). É a chave: se já existe cliente com esse número, ele é atualizado."),
  email: z.string().email().optional(),
  birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("AAAA-MM-DD"),
  tags: z.array(z.string().min(1).max(60)).max(30).optional().describe("Etiquetas a ADICIONAR (ex.: coloração, cliente-fiel). Não apaga as que já existem."),
  facts: z.record(z.string().min(1).max(80), z.union([z.string().max(500), z.number(), z.boolean()])).optional().describe("Fatos do cliente em campos livres (ex.: ultimo_servico: 'coloração', ultima_visita: '2026-09-10'). Soma aos que já existem."),
};

export const crmSaveContact: McpToolDefinition<typeof saveShape> = {
  name: "crm_save_contact",
  description:
    "Cadastra um cliente ou atualiza o que já existe (pelo telefone), com os dados que o DONO ditou: nome, e-mail, aniversário, etiquetas e fatos livres. " +
    "Etiquetas e fatos SOMAM ao que já existe, nada é apagado. Recusa cliente que exerceu o direito de exclusão de dados (LGPD). Não envia nenhuma mensagem.",
  inputSchema: saveShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const phone = telefoneBR(input.phone_number);
    if (!phone) throw new Error("Telefone inválido: confira o DDD e o número.");
    const hctx = { organization_id: ctx.organizationId, actor: ctx.actor, requestId: ctx.requestId };
    const found = await encontrarContatoPorTelefone(ctx.supabase, ctx.organizationId, phone);

    if (!found) {
      if (!input.name) throw new Error("Para cadastrar um cliente novo preciso do nome.");
      const created = await createContactHandler(ctx.supabase, hctx, {
        name: input.name, phone_number: phone, ...(input.email ? { email: input.email } : {}), ...(input.birthdate ? { birthdate: input.birthdate } : {}),
        tags: normalizarTags(input.tags ?? []), source: "chico", ...(input.facts ? { custom_fields: input.facts } : {}),
      } as never);
      return { created: true, contact_id: (created as { contact?: { id: string }; id?: string }).contact?.id ?? (created as { id?: string }).id, phone_number: phone };
    }

    const { data: current } = await ctx.supabase.from("contacts").select("id, tags, custom_fields, name").eq("organization_id", ctx.organizationId).eq("id", found.id).maybeSingle();
    const tags = [...new Set([...(((current as { tags?: string[] } | null)?.tags) ?? []), ...normalizarTags(input.tags ?? [])])];
    const fields = { ...(((current as { custom_fields?: Record<string, unknown> } | null)?.custom_fields) ?? {}), ...(input.facts ?? {}) };
    if (JSON.stringify(fields).length > MAX_CUSTOM_BYTES) throw new Error("Os fatos deste cliente passaram do limite de tamanho.");
    const patch: Record<string, unknown> = {};
    if (input.name) patch.name = input.name;
    if (input.email) patch.email = input.email;
    if (input.birthdate) patch.birthdate = input.birthdate;
    if (input.tags) patch.tags = tags;
    if (input.facts) patch.custom_fields = fields;
    if (!Object.keys(patch).length) return { created: false, contact_id: found.id, phone_number: phone, updated: [], message: "Nada a atualizar." };
    await patchContactHandler(ctx.supabase, hctx, found.id, patch as never);
    return { created: false, contact_id: found.id, phone_number: phone, updated: Object.keys(patch) };
  },
};

const listShape = {
  tags: z.array(z.string().min(1).max(60)).max(5).optional().describe("Só clientes com TODAS estas etiquetas."),
  order: z.enum(["recent", "oldest"]).default("recent").describe("recent = com atividade mais recente primeiro; oldest = quem está há mais tempo sem atividade primeiro."),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
};

export const crmListContacts: McpToolDefinition<typeof listShape> = {
  name: "crm_list_contacts",
  description:
    "Lista os clientes da base (não é busca por nome): filtra por etiquetas e ordena pela última atividade. Devolve nome, telefone, etiquetas, fatos livres e última atividade, com paginação. " +
    "Use para montar públicos ('quem faz coloração', 'quem está há mais tempo sem vir').",
  inputSchema: listShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const r = await listContactsHandler(ctx.supabase, { organization_id: ctx.organizationId, actor: ctx.actor, requestId: ctx.requestId }, {
      ...(input.tags?.length ? { tag: input.tags, modo: "e" as const } : {}), limit: input.limit, cursor: input.cursor, order_by: "last_activity_at", order_dir: input.order === "recent" ? "desc" : "asc",
    });
    return {
      contacts: r.contacts.filter((c) => !c.is_anonymized && !c.is_blocked).map((c) => ({
        id: c.id, name: c.display_name || c.name, phone: c.phone_number, tags: c.tags ?? [], facts: c.custom_fields ?? {}, created_at: c.created_at, last_activity_at: c.last_activity_at,
      })),
      cursor: r.cursor, has_more: r.has_more,
    };
  },
};
