import { describe, expect, it, vi } from "vitest";

import { arquivarEmLote } from "./arquivar-em-lote";

describe("arquivarEmLote", () => {
  it("arquiva todas, em ordem, uma de cada vez", async () => {
    const ordem: string[] = [];
    let emVoo = 0;
    let pico = 0;
    const r = await arquivarEmLote(
      [{ id: "a", service_revision: 1 }, { id: "b" }, { id: "c", service_revision: 3 }],
      async (alvo) => {
        emVoo++;
        pico = Math.max(pico, emVoo);
        await Promise.resolve();
        ordem.push(alvo.id);
        emVoo--;
      },
    );
    expect(r).toEqual({ arquivadas: ["a", "b", "c"], falhas: [] });
    expect(ordem).toEqual(["a", "b", "c"]);
    expect(pico).toBe(1);
  });

  it("uma falha não interrompe as outras e fica listada", async () => {
    const f = vi.fn(async (alvo: { id: string }) => {
      if (alvo.id === "b") throw new Error("409");
    });
    const r = await arquivarEmLote([{ id: "a" }, { id: "b" }, { id: "c" }], f);
    expect(r).toEqual({ arquivadas: ["a", "c"], falhas: ["b"] });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("lista vazia não chama nada", async () => {
    const f = vi.fn();
    expect(await arquivarEmLote([], f)).toEqual({ arquivadas: [], falhas: [] });
    expect(f).not.toHaveBeenCalled();
  });
});
