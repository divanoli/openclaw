import { beforeEach, describe, expect, it } from "vitest";
import type { MsgContext } from "../templating.js";
import {
  upsertSecretValue,
  deleteSecretValue,
  listSecretKeys,
} from "../../agents/auth-profiles/profiles.js";
import { finalizeInboundContext } from "./inbound-context.js";

describe("finalizeInboundContext - secret redaction", () => {
  beforeEach(async () => {
    // Clean up secrets from previous tests
    const keys = listSecretKeys();
    for (const key of keys) {
      await deleteSecretValue({ key });
    }
  });

  function buildContext(body: string): MsgContext {
    return {
      Body: body,
      BodyForAgent: body,
      BodyForCommands: body,
      CommandBody: body,
      RawBody: body,
      CommandSource: "text",
      CommandAuthorized: true,
      Provider: "whatsapp",
      Surface: "whatsapp",
    } as MsgContext;
  }

  it("redacts stored secret values from Body", async () => {
    await upsertSecretValue({ key: "API_KEY", value: "sk-ant-secret123" });
    const ctx = buildContext("My API key is sk-ant-secret123 for testing");

    const result = finalizeInboundContext(ctx);

    expect(result.Body).toContain('[REDACTED: stored secret "API_KEY"]');
    expect(result.Body).not.toContain("sk-ant-secret123");
  });

  it("redacts stored secret values from BodyForAgent", async () => {
    await upsertSecretValue({ key: "API_KEY", value: "sk-ant-secret123" });
    const ctx = buildContext("My API key is sk-ant-secret123 for testing");

    const result = finalizeInboundContext(ctx);

    expect(result.BodyForAgent).toContain('[REDACTED: stored secret "API_KEY"]');
    expect(result.BodyForAgent).not.toContain("sk-ant-secret123");
  });

  it("redacts stored secret values from BodyForCommands", async () => {
    await upsertSecretValue({ key: "API_KEY", value: "sk-ant-secret123" });
    const ctx = buildContext("My API key is sk-ant-secret123 for testing");

    const result = finalizeInboundContext(ctx);

    expect(result.BodyForCommands).toContain('[REDACTED: stored secret "API_KEY"]');
    expect(result.BodyForCommands).not.toContain("sk-ant-secret123");
  });

  it("redacts stored secret values from RawBody", async () => {
    await upsertSecretValue({ key: "API_KEY", value: "sk-ant-secret123" });
    const ctx = buildContext("My API key is sk-ant-secret123 for testing");

    const result = finalizeInboundContext(ctx);

    expect(result.RawBody).toContain('[REDACTED: stored secret "API_KEY"]');
    expect(result.RawBody).not.toContain("sk-ant-secret123");
  });

  it("redacts stored secret values from CommandBody", async () => {
    await upsertSecretValue({ key: "API_KEY", value: "sk-ant-secret123" });
    const ctx = buildContext("My API key is sk-ant-secret123 for testing");

    const result = finalizeInboundContext(ctx);

    expect(result.CommandBody).toContain('[REDACTED: stored secret "API_KEY"]');
    expect(result.CommandBody).not.toContain("sk-ant-secret123");
  });

  it("redacts multiple secrets in one pass", async () => {
    await upsertSecretValue({ key: "KEY_ONE", value: "secret-value-abc" });
    await upsertSecretValue({ key: "KEY_TWO", value: "secret-value-xyz" });
    const ctx = buildContext("First: secret-value-abc, Second: secret-value-xyz");

    const result = finalizeInboundContext(ctx);

    expect(result.Body).toContain('[REDACTED: stored secret "KEY_ONE"]');
    expect(result.Body).toContain('[REDACTED: stored secret "KEY_TWO"]');
    expect(result.Body).not.toContain("secret-value-abc");
    expect(result.Body).not.toContain("secret-value-xyz");
  });

  it("longest match wins (no partial replacements)", async () => {
    // Store a shorter value that is a substring of a longer value
    await upsertSecretValue({ key: "SHORT", value: "abc123" });
    await upsertSecretValue({ key: "LONG", value: "abc123def456" });
    const ctx = buildContext("The value is abc123def456 and abc123");

    const result = finalizeInboundContext(ctx);

    // Both should be redacted, but the longer one should be matched first
    expect(result.Body).toContain('[REDACTED: stored secret "LONG"]');
    expect(result.Body).toContain('[REDACTED: stored secret "SHORT"]');
    expect(result.Body).not.toContain("abc123def456");
    expect(result.Body).not.toContain("abc123");
  });

  it("does not redact short secrets (< 4 chars) to avoid false positives", async () => {
    await upsertSecretValue({ key: "SHORT", value: "ab" }); // 2 chars
    const ctx = buildContext("The value is ab in text");

    const result = finalizeInboundContext(ctx);

    // Short secrets should NOT be redacted
    expect(result.Body).toBe("The value is ab in text");
  });

  it("does not modify text when no secrets are stored", () => {
    // Ensure no secrets are stored
    expect(listSecretKeys()).toEqual([]);

    const originalText = "This is a normal message without secrets";
    const ctx = buildContext(originalText);

    const result = finalizeInboundContext(ctx);

    expect(result.Body).toBe(originalText);
  });

  it("handles empty/undefined text gracefully", async () => {
    await upsertSecretValue({ key: "API_KEY", value: "sk-ant-secret123" });

    const ctx = {
      Body: "",
      BodyForAgent: undefined,
      CommandSource: "text",
      CommandAuthorized: true,
      Provider: "whatsapp",
      Surface: "whatsapp",
    } as unknown as MsgContext;

    const result = finalizeInboundContext(ctx);

    expect(result.Body).toBe("");
    // BodyForAgent gets normalized to Body (which is ""), not left undefined
    expect(result.BodyForAgent).toBe("");
  });

  it("redacts secrets in partial matches (substring)", async () => {
    await upsertSecretValue({ key: "TOKEN", value: "ghp_abc123def456" });
    const ctx = buildContext("Here is my token: ghp_abc123def456. Don't share it!");

    const result = finalizeInboundContext(ctx);

    expect(result.Body).toContain('[REDACTED: stored secret "TOKEN"]');
    expect(result.Body).not.toContain("ghp_abc123def456");
  });

  it("preserves surrounding text when redacting", async () => {
    await upsertSecretValue({ key: "SECRET", value: "my-secret-value" });
    const ctx = buildContext("Prefix my-secret-value suffix");

    const result = finalizeInboundContext(ctx);

    expect(result.Body).toBe('Prefix [REDACTED: stored secret "SECRET"] suffix');
  });

  it("handles multiple occurrences of the same secret", async () => {
    await upsertSecretValue({ key: "API_KEY", value: "sk-same-key" });
    const ctx = buildContext("Key: sk-same-key and again sk-same-key");

    const result = finalizeInboundContext(ctx);

    // Both occurrences should be redacted
    const matches = result.Body.match(/REDACTED: stored secret "API_KEY"/g);
    expect(matches).toHaveLength(2);
    expect(result.Body).not.toContain("sk-same-key");
  });

  it("does not redact similar but different values", async () => {
    await upsertSecretValue({ key: "PROD_KEY", value: "sk-prod-123" });
    const ctx = buildContext("Prod: sk-prod-123, Dev: sk-dev-456");

    const result = finalizeInboundContext(ctx);

    expect(result.Body).toContain('[REDACTED: stored secret "PROD_KEY"]');
    expect(result.Body).toContain("sk-dev-456"); // Should NOT be redacted
    expect(result.Body).not.toContain("sk-prod-123");
  });

  it("handles secrets with special regex characters", async () => {
    await upsertSecretValue({ key: "SPECIAL", value: "key.with.dots$and^specials" });
    const ctx = buildContext("Value: key.with.dots$and^specials here");

    const result = finalizeInboundContext(ctx);

    expect(result.Body).toContain('[REDACTED: stored secret "SPECIAL"]');
    expect(result.Body).not.toContain("key.with.dots$and^specials");
  });

  it("exactly 4 character secrets are redacted", async () => {
    await upsertSecretValue({ key: "FOUR", value: "abcd" }); // exactly 4 chars
    const ctx = buildContext("Code: abcd");

    const result = finalizeInboundContext(ctx);

    expect(result.Body).toContain('[REDACTED: stored secret "FOUR"]');
    expect(result.Body).not.toContain("abcd");
  });

  it("3 character secrets are NOT redacted", async () => {
    await upsertSecretValue({ key: "THREE", value: "abc" }); // 3 chars
    const ctx = buildContext("Code: abc");

    const result = finalizeInboundContext(ctx);

    // Should NOT be redacted (too short)
    expect(result.Body).toBe("Code: abc");
  });
});
