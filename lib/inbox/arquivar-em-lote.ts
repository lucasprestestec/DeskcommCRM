/**
 * Arquivar várias conversas de uma vez, pela MESMA transição de uma só.
 *
 * Não existe rota em lote de propósito: cada arquivamento passa pelo PATCH de
 * sempre (`status: "archived"` + `expected_revision`), então RBAC, suporte
 * temporário, audit e o lock otimista valem igualzinho. Em sequência, e não em
 * paralelo, para não abrir dezenas de requisições de escrita ao mesmo tempo
 * contra a mesma organização.
 *
 * Uma falha NÃO interrompe as outras: o operador quer saber quantas saíram e
 * quantas ficaram, e as que ficaram continuam marcadas para tentar de novo.
 */
export interface AlvoDoLote {
  id: string;
  service_revision?: number;
}

export interface ResultadoDoLote {
  arquivadas: string[];
  falhas: string[];
}

export async function arquivarEmLote(
  alvos: AlvoDoLote[],
  arquivar: (alvo: AlvoDoLote) => Promise<unknown>,
): Promise<ResultadoDoLote> {
  const arquivadas: string[] = [];
  const falhas: string[] = [];
  for (const alvo of alvos) {
    try {
      await arquivar(alvo);
      arquivadas.push(alvo.id);
    } catch {
      falhas.push(alvo.id);
    }
  }
  return { arquivadas, falhas };
}
