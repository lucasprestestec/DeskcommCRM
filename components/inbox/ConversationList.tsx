"use client";
import { ehAFila } from "@/lib/inbox/comando-da-conversa";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import { useArquivarVarias } from "@/hooks/inbox/useCloseConversation";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { InfiniteData, UseInfiniteQueryResult } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useChannelSessions } from "@/hooks/channels/useChannelSessions";

import { useAutomaticoAtivo } from "@/hooks/ai/useAutomaticoAtivo";

import { ConversationListItem } from "./ConversationListItem";
import { EmptyInbox } from "@/components/empty";
import { EmptyPorFiltro } from "./EmptyPorFiltro";
import { filtrosAuxiliaresAtivos } from "@/lib/inbox/filtros-ativos";
import type {
  ConversationsFilters,
  ConversationWithContact,
} from "@/hooks/inbox/useConversationsRealtime";

interface ListResponse {
  data: ConversationWithContact[];
  meta?: { cursor?: string | null; has_more?: boolean };
}

interface Props {
  /** Query já montada no pai — evita duplicar subscription Realtime + refetch. */
  listQuery: UseInfiniteQueryResult<InfiniteData<ListResponse>, Error>;
  filters: ConversationsFilters;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Desliga os filtros auxiliares. Sem ele, o vazio por filtro nao oferece o botao. */
  onLimparFiltros?: () => void;
  /** Notifies parent when the visible list changes (used by keyboard nav). */
  onVisibleChange?: (ids: string[]) => void;
}

export function ConversationList({
  listQuery: q,
  filters,
  selectedId,
  onSelect,
  onVisibleChange,
  onLimparFiltros,
}: Props) {
  const t = useT();
  // Só mostra POR ONDE a conversa entrou quando há mais de um número. Com um
  // só, o rótulo seria a mesma palavra em toda linha — ruído que ensina o olho
  // a ignorar a área onde vivem os avisos que importam.
  //
  // `?? []` e não `undefined`: enquanto a lista de canais carrega, o certo é
  // NÃO mostrar. Mostrar e sumir depois é pior que aparecer um instante tarde.
  const canais = useChannelSessions().data ?? [];
  const maisDeUmCanal = canais.length > 1;

  // Fila (G5-03): a lista já vem ordenada por tempo de espera (server), então a
  // posição é o índice na lista visível. Só mostramos posição/espera nessa visão.
  // A Fila deixou de mandar `assigned_to=unassigned` (agora pede `comando`), e
  // sem esta linha a numeração "1º, 2º…" e o tempo de espera sumiriam da única
  // visão em que servem para alguma coisa — sem erro nenhum, só sumiriam.
  const isQueue = ehAFila(filters);
  // Uma leitura por lista, compartilhada por todas as linhas (react-query dedupa
  // com o cabeçalho, que faz a mesma pergunta).
  const automaticoDaOrg = useAutomaticoAtivo();

  // Sem filtro de cliente: TODO filtro é parâmetro do schema e roda no banco.
  // `clientFilter` era o mecanismo que permitia um filtro existir fora do contrato
  // — e foi por ele que "Não lidos" virou ilha, fora da cerca que vigia os demais.
  const items = useMemo(
    () => (q.data?.pages.flatMap((p) => p.data) ?? []) as ConversationWithContact[],
    [q.data],
  );

  // Notify parent of currently-visible IDs (for j/k nav). Must use effect
  // (not render-time call) — invoking onVisibleChange during render triggers
  // setState in InboxLayout from inside ConversationList's render phase,
  // which React 19 forbids.

  /**
   * O badge de atendente só entra quando DISCRIMINA — mesma regra do badge de
   * canal, e pelo mesmo motivo escrito lá: rótulo que se repete em toda linha
   * ensina o olho a ignorar a área onde vivem os avisos que importam.
   *
   * Medido nas abas: "Fila" pede `comando=aguardando` (nenhuma linha tem dono —
   * a régua põe quem tem dono em `humano`), "Minhas" filtra `assigned_to=me`
   * (todas têm o MESMO) e "Automático" pede `comando=automatico` (também sem
   * dono, pela mesma razão). Sobram "Todas" e "Fechadas" — e mesmo nelas, só
   * vale se a página realmente tiver mais de um dono distinto.
   *
   * O `filters.comando` entrou junto com as abas novas: sem ele, a Fila voltaria
   * a repetir o mesmo selo de atendente em cada uma das linhas.
   */
  const mostrarAtendente = useMemo(() => {
    if (filters.assigned_to) return false;
    if (filters.comando && !filters.comando.includes("humano")) return false;
    const donos = new Set(
      items.map((i) => i.assigned_to_user_id).filter((id): id is string => Boolean(id)),
    );
    return donos.size > 1;
  }, [filters.assigned_to, filters.comando, items]);

  /**
   * O ícone de robô, mesma regra dos dois badges acima: só entra quando
   * DISCRIMINA. A aba "Automático" pede `comando=["automatico"]` — toda linha
   * já é robô, e repetir o ícone em cada uma vira ruído. Nas outras abas a
   * lista é mista (ou pode ser), então o ícone segue dizendo algo.
   */
  const mostrarAutomatico =
    !(filters.comando?.length === 1 && filters.comando[0] === "automatico");

  useEffect(() => {
    if (onVisibleChange) onVisibleChange(items.map((i) => i.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // SELEÇÃO EM MASSA (arquivar várias). Só vale para o que está CARREGADO na
  // tela — "Carregar mais" traz mais linhas e elas entram desmarcadas. Na aba
  // Arquivadas não há o que arquivar, então o modo nem é oferecido.
  const arquivarVarias = useArquivarVarias();
  const [selecionando, setSelecionando] = useState(false);
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set());
  const [confirmarLote, setConfirmarLote] = useState(false);
  const jaArquivadas = filters.status === "archived";
  const modoSelecao = selecionando && !jaArquivadas;
  // Só conta o que ainda está na tela: a linha que sumiu (arquivada, ou por filtro)
  // não pode continuar entrando na conta do botão.
  const marcadasVisiveis = useMemo(() => items.filter((i) => marcadas.has(i.id)), [items, marcadas]);
  const todasMarcadas = items.length > 0 && marcadasVisiveis.length === items.length;
  const marcar = (id: string) =>
    setMarcadas((atual) => {
      const novo = new Set(atual);
      if (!novo.delete(id)) novo.add(id);
      return novo;
    });
  const sairDaSelecao = () => {
    setSelecionando(false);
    setMarcadas(new Set());
  };
  async function arquivarMarcadas() {
    const alvos = marcadasVisiveis.map((c) => ({ id: c.id, service_revision: c.service_revision }));
    const r = await arquivarVarias.mutateAsync(alvos);
    if (r.falhas.length === 0) {
      toast.success(`${t("Conversas arquivadas:")} ${r.arquivadas.length}`);
      sairDaSelecao();
    } else {
      // As que falharam continuam marcadas, para tentar de novo.
      toast.error(
        `${t("Arquivadas:")} ${r.arquivadas.length}. ${t("Não puderam ser arquivadas (alguém mexeu nelas ou você não tem permissão):")} ${r.falhas.length}`,
      );
      setMarcadas(new Set(r.falhas));
    }
  }

  if (q.isLoading) {
    return (
      <div className="space-y-3 p-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        <p>{t("Erro ao carregar conversas.")}</p>
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => q.refetch()}
        >
          Tentar novamente
        </Button>
      </div>
    );
  }

  // Vazio por AUSENCIA: a caixa esta mesmo vazia, e o texto pode prometer que
  // mensagens vao aparecer. Este e o unico caso que ainda sai por `return`
  // precoce, porque aqui nao ha pagina seguinte a alcancar.
  const filtrosAtivos = filtrosAuxiliaresAtivos(filters);
  if (items.length === 0 && filtrosAtivos.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyInbox />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {!jaArquivadas && items.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-3 py-1.5">
          {modoSelecao ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setMarcadas(todasMarcadas ? new Set() : new Set(items.map((i) => i.id)))}
              >
                {todasMarcadas ? t("Desmarcar todas") : `${t("Selecionar todas")} (${items.length})`}
              </Button>
              <Button
                size="sm"
                disabled={marcadasVisiveis.length === 0 || arquivarVarias.isPending}
                onClick={() => setConfirmarLote(true)}
              >
                {arquivarVarias.isPending ? t("Arquivando...") : `${t("Arquivar")} (${marcadasVisiveis.length})`}
              </Button>
              <Button size="sm" variant="ghost" onClick={sairDaSelecao} disabled={arquivarVarias.isPending}>
                {t("Cancelar")}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setSelecionando(true)}>
              {t("Selecionar")}
            </Button>
          )}
        </div>
      )}
      <AlertDialog open={confirmarLote} onOpenChange={setConfirmarLote}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Arquivar as conversas marcadas?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Arquivar encerra estes atendimentos e guarda as conversas no histórico. Se o cliente escrever de novo, a conversa volta.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void arquivarMarcadas()}>{t("Arquivar")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="flex-1 overflow-y-auto">
        {/* Vazio por FILTRO: fica DENTRO do return, nunca como `return` precoce —
            e por isso o bloco do `hasNextPage` abaixo continua sendo alcancado. */}
        {items.length === 0 && filtrosAtivos.length > 0 && (
          <EmptyPorFiltro filtros={filtrosAtivos} onLimpar={onLimparFiltros} />
        )}
        {items.map((c, i) => (
          <ConversationListItem
            key={c.id}
            conversation={c}
            isSelected={c.id === selectedId}
            onSelect={onSelect}
            queuePosition={isQueue ? i + 1 : undefined}
            mostrarCanal={maisDeUmCanal}
            mostrarAtendente={mostrarAtendente}
            mostrarAutomatico={mostrarAutomatico}
            automaticoDaOrg={automaticoDaOrg.data}
            modoSelecao={modoSelecao}
            marcada={marcadas.has(c.id)}
            onMarcar={marcar}
          />
        ))}
        {q.hasNextPage && (
          <div className="flex justify-center p-3">
            <Button
              size="sm"
              variant="outline"
              onClick={() => q.fetchNextPage()}
              disabled={q.isFetchingNextPage}
            >
              {q.isFetchingNextPage ? t("Carregando…") : t("Carregar mais")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
