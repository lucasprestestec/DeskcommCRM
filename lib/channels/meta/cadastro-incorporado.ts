/**
 * Cadastro Incorporado (Embedded Signup) — o que a INSTALAÇÃO faz depois que o
 * cliente termina o fluxo da Meta na janela do navegador.
 *
 * O navegador entrega três coisas: um código de uso único (vale 30 segundos), o
 * `waba_id` e o `phone_number_id`. Aqui o código vira token (servidor a servidor, com
 * o App Secret que nunca vai ao navegador) e, para número que já usa o app WhatsApp
 * Business (coexistência), a instalação pede à Meta a sincronização de contatos e
 * histórico — que a Meta exige em até 24 horas depois do cadastro.
 *
 * Mora em `lib/channels/` pela mesma razão do resto da fronteira: só ela nomeia o
 * transporte (`pnpm lint:channels`).
 */
import { graphBaseUrl } from "./graph-base";
import { graphVersion } from "@/lib/graph-version";

/**
 * O que a tela precisa para abrir o fluxo. `null` = a instalação não configurou:
 * o botão não aparece e o formulário manual segue sendo o caminho.
 *
 * `appId` e `configId` não são segredo (a Meta os põe em qualquer página que abre o
 * fluxo); o App Secret, esse sim, só existe no servidor.
 */
export interface ConfigDoCadastroIncorporado {
  appId: string;
  configId: string;
  graphVersion: string;
}

export function configDoCadastroIncorporado(
  source: Record<string, string | undefined> = process.env,
): ConfigDoCadastroIncorporado | null {
  const appId = (source.META_APP_ID ?? "").trim();
  const configId = (source.META_EMBEDDED_SIGNUP_CONFIG_ID ?? "").trim();
  if (!appId || !configId) return null;
  return { appId, configId, graphVersion: graphVersion() };
}

/**
 * O evento da Meta que diz "o cliente conectou um número que JÁ usa o app WhatsApp
 * Business". É o único que esta versão sabe terminar: número novo (`FINISH`) exige
 * registrar o número com um PIN de verificação em duas etapas, e a instalação ainda
 * não guarda esse PIN.
 */
export const EVENTO_DE_NUMERO_DO_APP = "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING";

export type TrocaDoCodigo = { ok: true; token: string } | { ok: false; motivo: string };

function motivoDaMeta(body: unknown, status: number): string {
  const b = body as { error?: { message?: string; error_data?: { details?: string } } } | null;
  return b?.error?.error_data?.details ?? b?.error?.message ?? `http_${status}`;
}

/**
 * Troca o código do Cadastro Incorporado pelo token do cliente.
 *
 * POST com o corpo em formulário, e não GET com os parâmetros na URL como o exemplo
 * da documentação: o `client_secret` na query string vai parar em log de proxy e de
 * CDN. O segredo viaja no corpo. (A Graph aceita os dois verbos neste endpoint; se um
 * dia recusar, o motivo volta aqui — e a tela o mostra.)
 */
export async function trocarCodigoPorToken(input: {
  code: string;
  appId: string;
  appSecret: string;
}): Promise<TrocaDoCodigo> {
  try {
    const res = await fetch(`${graphBaseUrl()}/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: input.appId,
        client_secret: input.appSecret,
        code: input.code,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string };
    if (!res.ok || !body.access_token) {
      return { ok: false, motivo: motivoDaMeta(body, res.status) };
    }
    return { ok: true, token: body.access_token };
  } catch (err) {
    // Rede caída não é código vencido: o motivo precisa dizer isso, senão o operador
    // refaz o cadastro inteiro por um problema que não era dele.
    return {
      ok: false,
      motivo: `rede indisponível: ${err instanceof Error ? err.message : "erro"}`,
    };
  }
}

export type TipoDeSincronizacao = "smb_app_state_sync" | "history";

export interface DesfechoDaSincronizacao {
  tipo: TipoDeSincronizacao;
  pedida: boolean;
  /** O motivo, quando a Meta recusou — para a tela e o log. */
  erro: string | null;
}

/**
 * Pede à Meta a sincronização do número em coexistência: contatos
 * (`smb_app_state_sync`) e histórico de conversa (`history`). Os dados chegam depois,
 * por webhook.
 *
 * Sequencial e SEM lançar: a falha de um pedido não desfaz a conexão (o canal envia e
 * recebe mesmo assim), mas o motivo precisa ir à tela, porque a Meta só aceita o
 * histórico UMA vez e dentro de 24 horas — passar do prazo sem avisar o operador é o
 * defeito silencioso que este retorno evita.
 */
export async function pedirSincronizacaoDoApp(input: {
  phoneNumberId: string;
  token: string;
}): Promise<DesfechoDaSincronizacao[]> {
  const desfechos: DesfechoDaSincronizacao[] = [];
  for (const tipo of ["smb_app_state_sync", "history"] as const) {
    try {
      const res = await fetch(`${graphBaseUrl()}/${input.phoneNumberId}/smb_app_data`, {
        method: "POST",
        headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", sync_type: tipo }),
      });
      const body = await res.json().catch(() => ({}));
      desfechos.push(
        res.ok
          ? { tipo, pedida: true, erro: null }
          : { tipo, pedida: false, erro: motivoDaMeta(body, res.status) },
      );
    } catch (err) {
      desfechos.push({
        tipo,
        pedida: false,
        erro: `rede indisponível: ${err instanceof Error ? err.message : "erro"}`,
      });
    }
  }
  return desfechos;
}
