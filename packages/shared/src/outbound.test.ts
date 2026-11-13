import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUTBOUND_ALLOWLIST,
  OutboundHostNotAllowedError,
  assertOutboundUrlAllowed,
  isPrivateOutboundHost,
  parseOutboundAllowlist,
} from "./outbound.js";

describe("outbound allowlist", () => {
  it("по умолчанию разрешает только необходимые домены Sprint 18", () => {
    expect(DEFAULT_OUTBOUND_ALLOWLIST).toEqual(
      expect.arrayContaining([
        "api.telegram.org",
        "www.googleapis.com",
        "oauth2.googleapis.com",
      ]),
    );
  });

  it("разбирает env и поддерживает wildcard", () => {
    expect(parseOutboundAllowlist("api.telegram.org, *.googleapis.com")).toEqual(
      ["api.telegram.org", "*.googleapis.com"],
    );
  });

  it("падает на некорректном домене (fail closed)", () => {
    expect(() => parseOutboundAllowlist("api.telegram.org,http://evil")).toThrow(
      /некорректный домен/,
    );
  });

  it("разрешает точный домен и поддомен wildcard", () => {
    const allowlist = ["api.telegram.org", "*.googleapis.com"];

    expect(() =>
      assertOutboundUrlAllowed("https://api.telegram.org/bot/sendMessage", allowlist),
    ).not.toThrow();
    expect(() =>
      assertOutboundUrlAllowed("https://www.googleapis.com/oauth2/v3/userinfo", allowlist),
    ).not.toThrow();
    expect(() =>
      assertOutboundUrlAllowed("https://sub.api.telegram.org/hook", allowlist),
    ).toThrow(OutboundHostNotAllowedError);
  });

  it("блокирует внешний http и неизвестный домен", () => {
    expect(() =>
      assertOutboundUrlAllowed("http://api.telegram.org/hook", ["api.telegram.org"]),
    ).toThrow(/только по https/);
    expect(() =>
      assertOutboundUrlAllowed("https://evil.example/hook", ["api.telegram.org"]),
    ).toThrow(/OUTBOUND_ALLOWLIST/);
  });

  it("разрешает локальные адреса без allowlist", () => {
    expect(isPrivateOutboundHost("host.docker.internal")).toBe(true);
    expect(isPrivateOutboundHost("172.20.0.5")).toBe(true);
    expect(isPrivateOutboundHost("api.telegram.org")).toBe(false);

    expect(() =>
      assertOutboundUrlAllowed("http://host.docker.internal:8034/v1", []),
    ).not.toThrow();
  });
});
