/**
 * Os números da conta da Meta DESTA INSTALAÇÃO — para ligar um número a uma
 * organização com um clique, sem copiar `phone_number_id` e token à mão.
 *
 * ─── O modelo que isto atende ───────────────────────────────────────────────
 * Quem opera a instalação tem UM portfólio na Meta (e paga por ele), e os números
 * dos clientes entram nessa conta. O token de um usuário do sistema desse portfólio
 * enxerga todos eles; o CRM só precisa perguntar à Meta "quais números existem?" e
 * ligar o escolhido à organização. O cadastro do número na Meta (pela janela de
 * Cadastro Incorporado, ou pelo painel) continua sendo o passo que cria o número —
 * esta tela começa onde ele termina.
 *
 * ─── Por que variáveis PRÓPRIAS, e não META_SYSTEM_USER_TOKEN ───────────────
 * `META_SYSTEM_USER_TOKEN`/`META_PHONE_NUMBER_ID` são o piso de "instalação de um
 * número só": várias rotas já foram consertadas porque o token do ambiente acabava
 * falando em nome de QUALQUER canal (ver `credentials.ts`). Um token que enxerga a
 * conta inteira, posto nessa variável, reabriria exatamente essa fenda. Aqui o
 * token tem nome e uso próprios — listar números e entregá-lo ao canal que o
 * operador escolher — e nunca é usado para enviar mensagem de outra organização.
 *
 * Mora em `lib/channels/` porque só a fronteira do canal conhece a Meta
 * (`pnpm lint:channels`).
 */
import { graphBaseUrl } from "./graph-base";

export interface ContaDaMetaConfigurada {
  wabaId: string;
  token: string;
}

/** `null` = a instalação não configurou: a tela não aparece e nada muda. */
export function contaDaMetaDoAmbiente(
  source: Record<string, string | undefined> = process.env,
): ContaDaMetaConfigurada | null {
  const wabaId = (source.META_NUMEROS_WABA_ID ?? "").trim();
  const token = (source.META_NUMEROS_TOKEN ?? "").trim();
  if (!wabaId || !token) return null;
  return { wabaId, token };
}

export interface NumeroDaConta {
  phoneNumberId: string;
  numero: string | null;
  nome: string | null;
  /** O número ainda é usado no app WhatsApp Business (coexistência)? `null` = a Meta não disse. */
  noApp: boolean | null;
}

export type ListagemDeNumeros =
  | { ok: true; numeros: NumeroDaConta[] }
  | { ok: false; motivo: string };

interface LinhaDaGraph {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
  is_on_biz_app?: boolean;
}

/**
 * Lista os números da WABA. Nunca lança: a falha vira `motivo` para a tela — rede
 * caída, token vencido e WABA errada precisam de conselhos diferentes.
 */
export async function listarNumerosDaConta(conta: ContaDaMetaConfigurada): Promise<ListagemDeNumeros> {
  try {
    const res = await fetch(
      `${graphBaseUrl()}/${encodeURIComponent(conta.wabaId)}/phone_numbers` +
        `?fields=id,display_phone_number,verified_name,is_on_biz_app&limit=100`,
      { headers: { Authorization: `Bearer ${conta.token}` } },
    );
    const body = (await res.json().catch(() => ({}))) as {
      data?: LinhaDaGraph[];
      error?: { message?: string; error_data?: { details?: string } };
    };
    if (!res.ok || body.error) {
      return {
        ok: false,
        motivo: body.error?.error_data?.details ?? body.error?.message ?? `http_${res.status}`,
      };
    }
    const numeros = (body.data ?? [])
      .filter((l): l is LinhaDaGraph & { id: string } => typeof l.id === "string" && l.id.length > 0)
      .map((l) => ({
        phoneNumberId: l.id,
        numero: l.display_phone_number ?? null,
        nome: l.verified_name ?? null,
        noApp: typeof l.is_on_biz_app === "boolean" ? l.is_on_biz_app : null,
      }));
    return { ok: true, numeros };
  } catch (err) {
    return { ok: false, motivo: `rede indisponível: ${err instanceof Error ? err.message : "erro"}` };
  }
}
