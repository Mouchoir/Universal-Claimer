import { describe, expect, it, vi } from "vitest";
import { deliver } from "./index.js";

const ok = { ok: true } as Response;
const notOk = { ok: false } as Response;

describe("deliver", () => {
  it("posts a Discord content payload", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok);
    const r = await deliver({ kind: "discord", url: "https://d/hook" }, "hello", { fetchImpl });
    expect(r).toBe(true);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(String(init!.body))).toEqual({ content: "hello" });
  });

  it("posts a text payload to telegram", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok);
    await deliver({ kind: "telegram", url: "https://api.tg/hook" }, "hey", { fetchImpl });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(String(init!.body))).toEqual({ text: "hey" });
  });

  it("posts a plain body to ntfy", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok);
    await deliver({ kind: "ntfy", url: "https://ntfy.sh/topic" }, "hi", { fetchImpl });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init!.body).toBe("hi");
  });

  it("returns false on a non-OK response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(notOk);
    expect(await deliver({ kind: "discord", url: "u" }, "m", { fetchImpl })).toBe(false);
  });

  it("returns false (never throws) when fetch rejects", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("network"));
    expect(await deliver({ kind: "discord", url: "u" }, "m", { fetchImpl })).toBe(false);
  });
});
