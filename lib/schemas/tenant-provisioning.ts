import { z } from "zod";

/**
 * Corpo de `POST /api/v1/tenants/provision`.
 *
 * Não é o schema de `tenant-creation.ts` (aquele é do formulário de criação
 * por platform admin — plano, convite, interface —, nenhum dos quais existe
 * aqui). `integration` nomeia quem provisiona e entra no slug e no escopo da
 * chave; por isso é um identificador curto, sem espaço nem barra.
 */
export const provisionTenantSchema = z
  .object({
    integration: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{1,30}$/),
    external_id: z.string().trim().min(1).max(200),
    organization_name: z.string().trim().min(1).max(200),
    owner_email: z.string().trim().email(),
    owner_name: z.string().trim().min(1).max(200),
    /** Papel da chave devolvida. Padrão `agent`; `manager` só com `TENANT_PROVISIONING_ALLOW_MANAGER` ligado na instalação. */
    key_role: z.enum(["agent", "manager"]).optional(),
  })
  .strict();

export type ProvisionTenantInput = z.infer<typeof provisionTenantSchema>;
