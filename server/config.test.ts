import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_HOST, DEFAULT_PORT, isWildcardHost, localUrl, parseConfig } from "./config.js";

describe("parseConfig", () => {
  it("applies defaults to an empty object", () => {
    expect(parseConfig({})).toEqual({
      server: { host: DEFAULT_HOST, port: DEFAULT_PORT },
      users: [],
      llm: { providers: [], tasks: {} },
      backup: { dir: "data/backups", keep: 14 },
    });
  });

  it("server.host: loopback by default, IP literals only, normalized", () => {
    expect(DEFAULT_HOST).toBe("127.0.0.1");
    expect(parseConfig({ server: { port: 4300 } }).server).toEqual({ host: "127.0.0.1", port: 4300 });
    expect(parseConfig({ server: { host: " 172.17.0.1 " } }).server.host).toBe("172.17.0.1");
    expect(parseConfig({ server: { host: "0.0.0.0" } }).server.host).toBe("0.0.0.0");
    expect(parseConfig({ server: { host: "::1" } }).server.host).toBe("::1");
    expect(parseConfig({ server: { host: "FE80::1" } }).server.host).toBe("fe80::1");
    expect(parseConfig({ server: { host: null } }).server.host).toBe(DEFAULT_HOST);
    for (const host of ["localhost", "example.com", "[::1]", "", "127.0.0.1:4200", 127])
      expect(() => parseConfig({ server: { host } }), String(host)).toThrow(/server.host must be an IP address/);
  });

  it("localUrl: connectable URL for the bound address", () => {
    expect(localUrl({ host: "127.0.0.1", port: 4200 })).toBe("http://127.0.0.1:4200");
    expect(localUrl({ host: "172.17.0.1", port: 4200 })).toBe("http://172.17.0.1:4200");
    expect(localUrl({ host: "::1", port: 4200 })).toBe("http://[::1]:4200");
    // Wildcard binds are reachable via loopback.
    expect(localUrl({ host: "0.0.0.0", port: 4200 })).toBe("http://127.0.0.1:4200");
    expect(localUrl({ host: "::", port: 4200 })).toBe("http://127.0.0.1:4200");
    expect([isWildcardHost("0.0.0.0"), isWildcardHost("::"), isWildcardHost("127.0.0.1")]).toEqual([true, true, false]);
  });

  it("backup: dir + keep, validated", () => {
    expect(parseConfig({ backup: { dir: " /mnt/nas/pa ", keep: 30 } }).backup).toEqual({ dir: "/mnt/nas/pa", keep: 30 });
    expect(parseConfig({ backup: { keep: 3 } }).backup).toEqual({ dir: "data/backups", keep: 3 });
    const bad = () => parseConfig({ backup: { dir: "", keep: 0 } });
    expect(bad).toThrow(/backup.dir must be/);
    expect(bad).toThrow(/backup.keep must be/);
    expect(() => parseConfig({ backup: "x" })).toThrow(/backup must be an object/);
  });

  it("accepts config.example.json", () => {
    const raw = JSON.parse(readFileSync("config.example.json", "utf8"));
    const c = parseConfig(raw);
    expect(c.llm.providers.length).toBeGreaterThan(0);
    expect(c.llm.tasks.summary?.[0].provider).toBe(c.llm.providers[0].id);
  });

  it("task = one route or a list (first = default); normalized to a list", () => {
    const providers = [{ id: "local", baseUrl: "http://l" }, { id: "paid", baseUrl: "https://p" }];
    const c = parseConfig({
      llm: {
        providers,
        tasks: { search: { provider: "local", model: "m" }, summary: [{ provider: "local", model: "m" }, { provider: "paid", model: "big" }] },
      },
    });
    expect(c.llm.tasks.search).toEqual([{ provider: "local", model: "m", contextTokens: null }]);
    expect(c.llm.tasks.summary).toEqual([{ provider: "local", model: "m", contextTokens: null }, { provider: "paid", model: "big", contextTokens: null }]);
    const bad = () =>
      parseConfig({
        llm: {
          providers,
          tasks: { summary: [{ provider: "local", model: "m" }, { provider: "local", model: "m" }, { provider: "x", model: "m" }], search: [] },
        },
      });
    expect(bad).toThrow(/summary\[1\] duplicated/);
    expect(bad).toThrow(/summary\[2\].provider "x"/);
    expect(bad).toThrow(/search must not be empty/);
  });

  it("route contextTokens: optional (null), integer ≥ 4096", () => {
    const providers = [{ id: "local", baseUrl: "http://l" }];
    const route = (contextTokens: unknown) => parseConfig({ llm: { providers, tasks: { summary: { provider: "local", model: "m", contextTokens } } } });
    expect(route(90000).llm.tasks.summary).toEqual([{ provider: "local", model: "m", contextTokens: 90000 }]);
    expect(route(null).llm.tasks.summary?.[0].contextTokens).toBeNull();
    for (const bad of [1000, 8192.5, "90000"]) expect(() => route(bad)).toThrow(/summary.contextTokens must be an integer ≥ 4096/);
  });

  it("normalizes usernames, base URLs and empty api keys", () => {
    const c = parseConfig({
      users: ["  Alice ", "bob"],
      llm: { providers: [{ id: "local", baseUrl: "http://x:8000/v1/", apiKey: "", models: ["m"] }] },
    });
    expect(c.users).toEqual(["alice", "bob"]);
    expect(c.llm.providers[0]).toEqual({ id: "local", baseUrl: "http://x:8000/v1", apiKey: null, models: ["m"] });
  });

  it("rejects a task routed to an unknown provider", () => {
    expect(() =>
      parseConfig({ llm: { providers: [], tasks: { summary: { provider: "nope", model: "m" } } } }),
    ).toThrow(/llm.tasks.summary.provider "nope"/);
  });

  it("rejects unknown tasks, duplicate providers, bad ports, bad URLs", () => {
    const run = () =>
      parseConfig({
        server: { port: 70000 },
        llm: {
          providers: [
            { id: "a", baseUrl: "http://a" },
            { id: "a", baseUrl: "ftp://b" },
          ],
          tasks: { translate: { provider: "a", model: "m" } },
        },
      });
    expect(run).toThrow(/server.port/);
    expect(run).toThrow(/"a" duplicated/);
    expect(run).toThrow(/providers\[1\].baseUrl/);
    expect(run).toThrow(/translate: unknown task/);
  });

  it("rejects non-object root", () => {
    expect(() => parseConfig([])).toThrow(/root must be an object/);
  });
});
