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

  it("разрешает TTAPI и финансовые API из default allowlist", () => {
    expect(() =>
      assertOutboundUrlAllowed(
        "https://api.ttapi.io/midjourney/v1/fetch?jobId=test",
        DEFAULT_OUTBOUND_ALLOWLIST,
      ),
    ).not.toThrow();
    expect(() =>
      assertOutboundUrlAllowed(
        "https://api-performance.ozon.ru/api/client/campaign",
        DEFAULT_OUTBOUND_ALLOWLIST,
      ),
    ).not.toThrow();
    expect(() =>
      assertOutboundUrlAllowed(
        "https://discounts-prices-api.wildberries.ru/ping",
        DEFAULT_OUTBOUND_ALLOWLIST,
      ),
    ).not.toThrow();
    expect(() =>
      assertOutboundUrlAllowed(
        "https://api.goapi.ai/mj/v2/imagine",
        DEFAULT_OUTBOUND_ALLOWLIST,
      ),
    ).toThrow(/OUTBOUND_ALLOWLIST/);
  });

  it("разрешает Tavily для фактчекинга из default allowlist", () => {
    expect(() =>
      assertOutboundUrlAllowed(
        "https://api.tavily.com/search",
        DEFAULT_OUTBOUND_ALLOWLIST,
      ),
    ).not.toThrow();
  });

  it("разрешает облачный OCR и private SDE из default allowlist", () => {
    expect(() =>
      assertOutboundUrlAllowed(
        "https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText",
        DEFAULT_OUTBOUND_ALLOWLIST,
      ),
    ).not.toThrow();
    expect(() =>
      assertOutboundUrlAllowed(
        "http://sde.internal:8080/recognize",
        DEFAULT_OUTBOUND_ALLOWLIST,
      ),
    ).not.toThrow();
    expect(() =>
      assertOutboundUrlAllowed(
        "https://ocr.example.com/recognize",
        DEFAULT_OUTBOUND_ALLOWLIST,
      ),
    ).toThrow(/OUTBOUND_ALLOWLIST/);
  });
});
