import { describe, expect, it, vi } from "vitest";
import { validateTokenShape, verifyToken } from "../lib/session";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("validateTokenShape", () => {
  it("rejects empty, short and spaced tokens", () => {
    expect(validateTokenShape("")).toMatch(/Enter/);
    expect(validateTokenShape("short")).toMatch(/16/);
    expect(validateTokenShape("0123456789 abcdef0")).toMatch(/spaces/);
    expect(validateTokenShape(`  ${TOKEN}  `)).toBeNull();
  });
});

describe("verifyToken", () => {
  it("sends the token as a bearer header to an operator-only endpoint", async () => {
    const f = vi.fn(async () => new Response("[]", { status: 200 }));
    expect(await verifyToken(` ${TOKEN} `, f as unknown as typeof fetch)).toEqual({ ok: true });
    expect(f).toHaveBeenCalledWith("/api/protocols", { headers: { authorization: `Bearer ${TOKEN}` } });
  });

  it("reports a rejected token", async () => {
    const f = async () => new Response("{}", { status: 401 });
    expect(await verifyToken(TOKEN, f as typeof fetch)).toMatchObject({ ok: false, reason: "rejected" });
  });

  it("reports an unreachable or misbehaving server", async () => {
    const down = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await verifyToken(TOKEN, down as typeof fetch)).toMatchObject({ ok: false, reason: "unreachable" });
    const proxyError = async () => new Response("", { status: 502 });
    expect(await verifyToken(TOKEN, proxyError as typeof fetch)).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("does not call the server for a malformed token", async () => {
    const f = vi.fn();
    expect(await verifyToken("short", f as unknown as typeof fetch)).toMatchObject({ ok: false, reason: "invalid" });
    expect(f).not.toHaveBeenCalled();
  });
});
