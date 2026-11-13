import { describe, expect, it } from "vitest";
import { redactText, redactUrl } from "../lib/verify";

describe("provider URLs on the public page", () => {
  it("keeps public endpoints readable", () => {
    expect(redactUrl("https://free.rpc.fastnear.com")).toBe("https://free.rpc.fastnear.com");
    expect(redactUrl("https://archival-rpc.mainnet.near.org/")).toBe("https://archival-rpc.mainnet.near.org");
  });
  it("hides credentials in user info, query strings and key-like path segments", () => {
    expect(redactUrl("https://user:secret@rpc.example.com/v1")).toBe("https://rpc.example.com/v1");
    expect(redactUrl("https://rpc.example.com/?apiKey=abc123")).toBe("https://rpc.example.com?[hidden]");
    expect(redactUrl("https://near-mainnet.example.com/v2/a1b2c3d4e5f6a7b8c9d0e1f2")).toBe("https://near-mainnet.example.com/v2/[hidden]");
  });
  it("redacts every URL inside a curl command", () => {
    const curl = `curl -s -X POST https://rpc.example.com/?apikey=s3cr3t -H 'Content-Type: application/json' -d '{"x":1}'`;
    expect(redactText(curl)).not.toContain("s3cr3t");
    expect(redactText(curl)).toContain("https://rpc.example.com?[hidden]");
  });
});
