import { describe, expect, it } from "vitest";
import { Alerter, assertPublicWebhookUrl, isPrivateAddress, type AlertChannel } from "../../src/alerts/alerts.ts";

const recorder = (name: string, sent: string[]): AlertChannel => ({ name, send: async (subject) => void sent.push(`${name}:${subject}`) });

describe("alert routing", () => {
  it("sends a workspace's incidents only to that workspace's channels; the server's channels serve the default workspace", async () => {
    const sent: string[] = [];
    const a = new Alerter([recorder("server", sent)]);
    a.workspaceChannels = (ws) => (ws === "ws_a" ? [recorder("a-hook", sent)] : []);
    await a.send("breach", "x", {}, "ws_a");
    await a.send("other", "x", {}, "ws_b");
    await a.send("selfhosted", "x", {}, "default");
    expect(sent).toEqual(["a-hook:breach", "server:selfhosted"]);
    expect((await a.test("ws_a")).map((r) => r.channel)).toEqual(["a-hook"]);
    expect(await a.test("ws_b")).toEqual([]);
  });
});

describe("webhook addresses", () => {
  it("treats loopback, private, link-local, CGNAT and mapped addresses as private", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("accepts only https URLs on the public internet", async () => {
    await expect(assertPublicWebhookUrl("http://93.184.216.34/x")).rejects.toThrow(/https/);
    await expect(assertPublicWebhookUrl("https://localhost/x")).rejects.toThrow(/public internet/);
    await expect(assertPublicWebhookUrl("https://[::1]/x")).rejects.toThrow(/public internet/);
    await expect(assertPublicWebhookUrl("https://user:pw@93.184.216.34/x")).rejects.toThrow(/username/);
    await expect(assertPublicWebhookUrl("not a url")).rejects.toThrow(/valid URL/);
    expect((await assertPublicWebhookUrl("https://93.184.216.34/x")).hostname).toBe("93.184.216.34");
  });
});
