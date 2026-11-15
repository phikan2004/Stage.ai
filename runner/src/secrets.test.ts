import { describe, expect, it } from "vitest";
import { maskMoments, maskSecrets } from "./secrets.ts";

describe("maskSecrets", () => {
  it("hides credentials with a known shape", () => {
    const keys = ["sk-ant-api03-abcdefghij1234567890", "ghp_abcdefghijklmnopqrstuvwxyz123456", "AKIAIOSFODNN7EXAMPLE", "xoxb-1234567890-abcdef", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijk"];
    for (const key of keys) expect(maskSecrets(`use ${key} now`), key).toBe("use [hidden] now");
  });

  it("keeps the label on assignments and flags", () => {
    expect(maskSecrets("DB_PASSWORD=hunter2 npm start")).toBe("DB_PASSWORD=[hidden] npm start");
    expect(maskSecrets('"api_key": "abc123"')).toBe('"api_key": [hidden]');
    expect(maskSecrets("mysql --password hunter2")).toBe("mysql --password [hidden]");
    expect(maskSecrets("Authorization: Bearer abcdefghij1234567890")).toBe("Authorization: Bearer [hidden]");
  });

  it("hides the password in a connection url", () => {
    expect(maskSecrets("postgres://admin:hunter2@db.example.com/app")).toBe("postgres://admin:[hidden]@db.example.com/app");
  });

  it("hides a whole private key", () => {
    expect(maskSecrets("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")).toBe("[hidden]");
  });

  it("leaves ordinary demo text alone", () => {
    for (const text of ["npm test", "git checkout 53d3ff6a1b2c3d4e5f60718293a4b5c6d7e8f901", "https://app.example.com/reports?region=eu", "Reset your password", "Token usage"]) {
      expect(maskSecrets(text), text).toBe(text);
    }
  });
});

describe("maskMoments", () => {
  it("covers what was typed, said and clicked, and leaves the rest", () => {
    const frame = { t: 1, kind: "frame", file: "f0001.jpg" } as const;
    const masked = maskMoments([
      frame,
      { t: 2, kind: "typed", app: "Terminal", text: "export API_KEY=abc123" },
      { t: 3, kind: "said", text: "the token is abcdefghij1234567890" },
      { t: 4, kind: "click", button: "left", app: "Chrome", name: "Copy sk-abcdefghij1234567890" },
    ]);
    expect(masked).toEqual([
      frame,
      { t: 2, kind: "typed", app: "Terminal", text: "export API_KEY=[hidden]" },
      { t: 3, kind: "said", text: "the token is [hidden]" },
      { t: 4, kind: "click", button: "left", app: "Chrome", name: "Copy [hidden]" },
    ]);
  });
});
