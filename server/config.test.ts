import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_PORT, parseConfig } from "./config.js";

describe("parseConfig", () => {
  it("applies defaults to an empty object", () => {
    expect(parseConfig({})).toEqual({
      server: { port: DEFAULT_PORT },
      users: [],
      llm: { providers: [], tasks: {} },
    });
  });

  it("accepts config.example.json", () => {
    const raw = JSON.parse(readFileSync("config.example.json", "utf8"));
    const c = parseConfig(raw);
    expect(c.llm.providers.length).toBeGreaterThan(0);
    expect(c.llm.tasks.summary?.provider).toBe(c.llm.providers[0].id);
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
