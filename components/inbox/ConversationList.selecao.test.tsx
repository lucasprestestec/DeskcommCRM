/**
 * Seleção em massa do Inbox: marcar várias conversas e arquivar de uma vez.
 * A lista é montada com a query já pronta (como no InboxLayout); só os hooks de
 * rede são trocados.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ mutateAsync: vi.fn(), toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/hooks/channels/useChannelSessions", () => ({ useChannelSessions: () => ({ data: [] }) }));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({ useAutomaticoAtivo: () => ({ data: undefined }) }));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useArquivarVarias: () => ({ mutateAsync: h.mutateAsync, isPending: false }),
}));

import { ConversationList } from "./ConversationList";
import { conversaDeExemplo } from "./__fixtures__/conversa";

const conv = (id: string, nome: string, revisao: number) => ({
  ...conversaDeExemplo.conversation,
  id,
  service_revision: revisao,
  contacts: { ...(conversaDeExemplo.conversation.contacts ?? {}), id: `c-${id}`, name: nome },
});

function montar(status?: "archived", onSelect = vi.fn()) {
  const itens = [conv("a", "Ana", 1), conv("b", "Bia", 2), conv("c", "Caio", 3)];
  const listQuery = {
    isLoading: false,
    isError: false,
    hasNextPage: false,
    data: { pages: [{ data: itens }] },
  } as never;
  render(
    <ConversationList listQuery={listQuery} filters={status ? { status } : {}} selectedId={null} onSelect={onSelect} />,
  );
  return { onSelect };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.mutateAsync.mockResolvedValue({ arquivadas: ["a", "b", "c"], falhas: [] });
});

describe("ConversationList — seleção em massa", () => {
  it("fora do modo de seleção o clique abre a conversa", () => {
    const { onSelect } = montar();
    fireEvent.click(document.querySelector('[data-conversation-id="a"]')!);
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("no modo de seleção o clique marca em vez de abrir; 'Selecionar todas' marca tudo e o botão conta", () => {
    const { onSelect } = montar();
    fireEvent.click(screen.getByRole("button", { name: "Selecionar" }));
    fireEvent.click(document.querySelector('[data-conversation-id="a"]')!);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Arquivar (1)" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Selecionar todas (3)" }));
    expect(screen.getByRole("button", { name: "Arquivar (3)" })).toBeEnabled();
  });

  it("sem nada marcado o botão Arquivar fica desligado", () => {
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Selecionar" }));
    expect(screen.getByRole("button", { name: "Arquivar (0)" })).toBeDisabled();
  });

  it("confirmar arquiva as marcadas com a revisão de cada uma e sai do modo", async () => {
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Selecionar" }));
    fireEvent.click(screen.getByRole("button", { name: "Selecionar todas (3)" }));
    fireEvent.click(screen.getByRole("button", { name: "Arquivar (3)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Arquivar" }));
    await waitFor(() => expect(h.mutateAsync).toHaveBeenCalledTimes(1));
    expect(h.mutateAsync).toHaveBeenCalledWith([
      { id: "a", service_revision: 1 },
      { id: "b", service_revision: 2 },
      { id: "c", service_revision: 3 },
    ]);
    await waitFor(() => expect(h.toast.success).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Selecionar" })).toBeInTheDocument();
  });

  it("falha parcial avisa e mantém marcadas só as que falharam", async () => {
    h.mutateAsync.mockResolvedValue({ arquivadas: ["a", "c"], falhas: ["b"] });
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Selecionar" }));
    fireEvent.click(screen.getByRole("button", { name: "Selecionar todas (3)" }));
    fireEvent.click(screen.getByRole("button", { name: "Arquivar (3)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Arquivar" }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Arquivar (1)" })).toBeInTheDocument();
  });

  it("na aba Arquivadas o modo de seleção nem é oferecido", () => {
    montar("archived");
    expect(screen.queryByRole("button", { name: "Selecionar" })).toBeNull();
  });
});
