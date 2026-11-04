"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

/** O que a rota diz sobre o botão "Conectar WhatsApp": pode aparecer, e com quais ids. */
export interface ConfigDoCadastroIncorporado {
  disponivel: boolean;
  app_id: string | null;
  config_id: string | null;
  graph_version: string | null;
  /** Nomes de variável que faltam na instalação — nunca valores. */
  faltando: string[];
}

/** O que a Meta devolve ao navegador quando o cliente termina o fluxo. */
export interface RetornoDoCadastro {
  code: string;
  waba_id: string;
  phone_number_id: string;
  evento: string;
}

export interface ResultadoDoCadastro {
  connected: boolean;
  displayName: string;
  phoneNumber: string | null;
  sincronizacao: { tipo: string; pedida: boolean; erro: string | null }[];
}

export function useCadastroIncorporadoConfig() {
  return useQuery({
    queryKey: ["cadastro-incorporado-config"],
    queryFn: async () =>
      apiClient.get<{ data: ConfigDoCadastroIncorporado }>(
        "/api/v1/channels/official/cadastro-incorporado",
      ),
    staleTime: 60_000,
  });
}

export function useTerminarCadastroIncorporado() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RetornoDoCadastro) =>
      apiClient.post<{ data: ResultadoDoCadastro }>(
        "/api/v1/channels/official/cadastro-incorporado",
        input,
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["official-channel"] });
    },
  });
}

interface RespostaDoLogin {
  authResponse?: { code?: string } | null;
}

interface SdkDoFacebook {
  init: (opcoes: {
    appId: string;
    autoLogAppEvents: boolean;
    xfbml: boolean;
    version: string;
  }) => void;
  login: (retorno: (resposta: RespostaDoLogin) => void, opcoes: Record<string, unknown>) => void;
}

declare global {
  interface Window {
    FB?: SdkDoFacebook;
    fbAsyncInit?: () => void;
  }
}

const URL_DO_SDK = "https://connect.facebook.net/en_US/sdk.js";

let promessaDoSdk: Promise<SdkDoFacebook> | null = null;

/** Carrega o SDK da Meta uma vez só, e o inicializa com o app desta instalação. */
function carregarSdk(appId: string, version: string): Promise<SdkDoFacebook> {
  if (promessaDoSdk) return promessaDoSdk;
  promessaDoSdk = new Promise<SdkDoFacebook>((resolve, reject) => {
    window.fbAsyncInit = () => {
      if (!window.FB) return reject(new Error("sdk_indisponivel"));
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: true, version });
      resolve(window.FB);
    };
    const script = document.createElement("script");
    script.src = URL_DO_SDK;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => {
      promessaDoSdk = null; // deixa tentar de novo (bloqueador de anúncio, rede)
      reject(new Error("sdk_bloqueado"));
    };
    document.body.appendChild(script);
  });
  return promessaDoSdk;
}

/** A mensagem veio mesmo da Meta? Compara o host exato — `endsWith` cru aceitaria `evilfacebook.com`. */
function origemEDaMeta(origem: string): boolean {
  try {
    const host = new URL(origem).hostname;
    return host === "facebook.com" || host.endsWith(".facebook.com");
  } catch {
    return false;
  }
}

export type MotivoDaFalha = "cancelado" | "sdk_bloqueado" | "sem_codigo";

export class FalhaDoCadastro extends Error {
  constructor(readonly motivo: MotivoDaFalha) {
    super(motivo);
  }
}

/**
 * Abre o fluxo da Meta e devolve `{code, waba_id, phone_number_id, evento}`.
 *
 * Duas fontes chegam em ordens imprevisíveis — o código vem do callback do `FB.login`
 * e os ids vêm de uma mensagem postada pela janela —, então a promessa só resolve
 * quando as duas já chegaram. `featureType: whatsapp_business_app_onboarding` é o que
 * liga a coexistência (número que já usa o app); sem ele a Meta recusa esse número.
 */
export async function abrirCadastroDaMeta(cfg: {
  app_id: string;
  config_id: string;
  graph_version: string;
}): Promise<RetornoDoCadastro> {
  const fb = await carregarSdk(cfg.app_id, cfg.graph_version).catch(() => {
    throw new FalhaDoCadastro("sdk_bloqueado");
  });

  return new Promise<RetornoDoCadastro>((resolve, reject) => {
    let code: string | null = null;
    let ids: { waba_id: string; phone_number_id: string; evento: string } | null = null;

    const encerrar = () => window.removeEventListener("message", ouvir);
    const tentarResolver = () => {
      if (code && ids) {
        encerrar();
        resolve({ code, ...ids });
      }
    };

    function ouvir(e: MessageEvent) {
      if (!origemEDaMeta(e.origin)) return;
      let msg: { type?: string; event?: string; data?: Record<string, string> } | null = null;
      try {
        msg = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if (msg?.type !== "WA_EMBEDDED_SIGNUP") return;
      if (msg.event === "CANCEL" || msg.event === "ERROR") {
        encerrar();
        reject(new FalhaDoCadastro("cancelado"));
        return;
      }
      if (msg.event?.startsWith("FINISH") && msg.data?.waba_id && msg.data?.phone_number_id) {
        ids = {
          waba_id: msg.data.waba_id,
          phone_number_id: msg.data.phone_number_id,
          evento: msg.event,
        };
        tentarResolver();
      }
    }
    window.addEventListener("message", ouvir);

    fb.login(
      (resposta) => {
        const recebido = resposta.authResponse?.code;
        if (!recebido) {
          encerrar();
          reject(new FalhaDoCadastro(ids ? "sem_codigo" : "cancelado"));
          return;
        }
        code = recebido;
        tentarResolver();
      },
      {
        config_id: cfg.config_id,
        response_type: "code",
        override_default_response_type: true,
        extras: {
          setup: {},
          featureType: "whatsapp_business_app_onboarding",
          sessionInfoVersion: "3",
        },
      },
    );
  });
}
