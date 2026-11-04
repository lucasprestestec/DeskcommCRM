"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

export interface NumeroDaConta {
  phone_number_id: string;
  numero: string | null;
  nome: string | null;
  /** Ainda usado no app WhatsApp Business (coexistência)? `null` = a Meta não disse. */
  no_app: boolean | null;
  estado: "livre" | "nesta_organizacao" | "em_uso";
}

export interface NumerosDaConta {
  /** `false` para quem não administra a instalação ou quando ela não configurou a conta. */
  disponivel: boolean;
  numeros: NumeroDaConta[];
  /** Motivo da Meta quando a lista não veio. */
  erro: string | null;
}

export interface ResultadoDaLigacao {
  connected: boolean;
  displayName: string;
  phoneNumber: string | null;
  sincronizacao: { tipo: string; pedida: boolean; erro: string | null }[];
}

const ENDERECO = "/api/v1/channels/official/numeros-da-conta";

export function useNumerosDaConta() {
  return useQuery({
    queryKey: ["numeros-da-conta"],
    queryFn: async () => apiClient.get<{ data: NumerosDaConta }>(ENDERECO),
    staleTime: 15_000,
  });
}

export function useLigarNumeroDaConta() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (phone_number_id: string) =>
      apiClient.post<{ data: ResultadoDaLigacao }>(ENDERECO, { phone_number_id }),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["official-channel"] });
      qc.invalidateQueries({ queryKey: ["numeros-da-conta"] });
    },
  });
}
