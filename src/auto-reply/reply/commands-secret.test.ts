import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import {
  deleteSecretValue,
  getSecretValue,
  listSecretKeys,
  upsertSecretValue,
} from "../../agents/auth-profiles/profiles.js";
import { runMessageAction } from "../../infra/outbound/message-action-runner.js";
import { registerPluginCommand, clearPluginCommands } from "../../plugins/commands.js";
import { buildCommandContext, handleCommands } from "./commands.js";
import { parseInlineDirectives } from "./directive-handling.js";

vi.mock("../../infra/outbound/message-action-runner.js", () => ({
  runMessageAction: vi.fn(),
}));

// Helper to build command params (based on commands-approve.test.ts pattern)
function buildParams(commandBody: string, cfg: OpenClawConfig, ctxOverrides?: Partial<MsgContext>) {
  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "whatsapp",
    Surface: "whatsapp",
    ...ctxOverrides,
  } as MsgContext;

  // Use original casing for triggerBody to preserve secret values
  // The normalization to lowercase happens inside buildCommandContext
  const command = buildCommandContext({
    ctx,
    cfg,
    isGroup: false,
    triggerBodyNormalized: commandBody.trim(),
    commandAuthorized: true,
  });

  return {
    ctx,
    cfg,
    command,
    directives: parseInlineDirectives(commandBody),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off" as const,
    resolvedReasoningLevel: "off" as const,
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "whatsapp",
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  };
}

describe("/secret command", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearPluginCommands();
    // Clean up any secrets from previous tests
    const keys = listSecretKeys();
    for (const key of keys) {
      await deleteSecretValue({ key });
    }
  });

  describe("RESERVED_COMMANDS protection", () => {
    it("prevents plugins from registering /secret command", () => {
      const result = registerPluginCommand("test-plugin", {
        name: "secret",
        description: "Malicious secret command",
        handler: async () => ({ text: "hacked!" }),
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("is reserved by a built-in command");
    });

    it("prevents plugins from registering /s alias", () => {
      const result = registerPluginCommand("test-plugin", {
        name: "s",
        description: "Malicious s command",
        handler: async () => ({ text: "hacked!" }),
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("is reserved by a built-in command");
    });
  });

  describe("handler ordering", () => {
    it("always returns shouldContinue: false to stop pipeline", async () => {
      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const params = buildParams("/secret list", cfg);

      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
    });

    it("blocks unauthorized senders", async () => {
      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      // Build params with isAuthorizedSender: false by setting sender not in allowFrom
      const params = buildParams("/secret list", cfg, {
        SenderId: "unauthorized-user",
        CommandAuthorized: false,
      });
      // Override the authorization check
      params.command.isAuthorizedSender = false;

      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("requires authorization");
    });
  });

  describe("subcommand: set", () => {
    it("stores a secret and returns sanitized confirmation", async () => {
      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const params = buildParams("/secret set TEST_KEY my-secret-value-123", cfg);

      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("TEST_KEY stored");
      expect(result.reply?.text).toContain("19 chars");
      expect(result.reply?.text).not.toContain("my-secret-value-123");

      // Verify it was stored
      expect(getSecretValue({ key: "TEST_KEY" })).toBe("my-secret-value-123");
    });

    it("normalizes key to uppercase", async () => {
      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const params = buildParams("/secret set lowercase_key value123", cfg);

      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("LOWERCASE_KEY stored");
      expect(getSecretValue({ key: "LOWERCASE_KEY" })).toBe("value123");
    });

    it("rejects invalid key names", async () => {
      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;

      // Key with special characters
      const params = buildParams("/secret set INVALID-KEY! value", cfg);
      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("UPPER_SNAKE_CASE");
    });

    it("rejects reserved __ prefixed keys", async () => {
      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;

      const params = buildParams("/secret set __RESERVED value", cfg);
      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("reserved");
    });

    it("rejects empty value", async () => {
      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;

      const params = buildParams("/secret set TEST_KEY", cfg);
      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("Usage:");
    });

    it("rejects values exceeding 16KB", async () => {
      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;

      const hugeValue = "x".repeat(20_000);
      const params = buildParams(`/secret set TEST_KEY ${hugeValue}`, cfg);
      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("exceeds");
      expect(result.reply?.text).toContain("16384");
    });

    it("preserves spaces in Bearer-style tokens", async () => {
      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;

      const params = buildParams("/secret set AUTH_TOKEN Bearer abc123 xyz", cfg);
      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(getSecretValue({ key: "AUTH_TOKEN" })).toBe("Bearer abc123 xyz");
    });

    it("attempts to delete the original message on set", async () => {
      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;

      const mockRunMessageAction = vi.mocked(runMessageAction);
      mockRunMessageAction.mockResolvedValueOnce({ ok: true });

      const params = buildParams("/secret set TEST_KEY value", cfg, {
        MessageSid: "msg-123",
      });

      await handleCommands(params);

      expect(mockRunMessageAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "delete",
          params: { messageId: "msg-123" },
        }),
      );
    });
  });

  describe("subcommand: get", () => {
    it("returns metadata without exposing the value", async () => {
      await upsertSecretValue({ key: "EXISTING_KEY", value: "super-secret-12345" });

      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const params = buildParams("/secret get EXISTING_KEY", cfg);

      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("EXISTING_KEY exists");
      expect(result.reply?.text).toContain("18 chars");
      expect(result.reply?.text).not.toContain("super-secret-12345");
    });

    it("returns not found for missing keys", async () => {
      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const params = buildParams("/secret get NONEXISTENT", cfg);

      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("not found");
    });

    it("requires key name", async () => {
      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const params = buildParams("/secret get", cfg);

      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("Usage:");
    });
  });

  describe("subcommand: list", () => {
    it("lists all stored secret keys", async () => {
      await upsertSecretValue({ key: "KEY_A", value: "value-a" });
      await upsertSecretValue({ key: "KEY_B", value: "value-b" });

      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const params = buildParams("/secret list", cfg);

      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("KEY_A");
      expect(result.reply?.text).toContain("KEY_B");
      expect(result.reply?.text).not.toContain("value-a");
      expect(result.reply?.text).not.toContain("value-b");
    });

    it("returns empty message when no secrets", async () => {
      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const params = buildParams("/secret list", cfg);

      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("No secrets stored");
    });
  });

  describe("subcommand: delete", () => {
    it("deletes an existing secret", async () => {
      await upsertSecretValue({ key: "TO_DELETE", value: "value" });

      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const params = buildParams("/secret delete TO_DELETE", cfg);

      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("deleted");
      expect(getSecretValue({ key: "TO_DELETE" })).toBeUndefined();
    });

    it("returns not found for non-existent key", async () => {
      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const params = buildParams("/secret delete NONEXISTENT", cfg);

      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("not found");
    });

    it("requires key name", async () => {
      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const params = buildParams("/secret delete", cfg);

      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("Usage:");
    });
  });

  describe("subcommand: import-env", () => {
    beforeEach(() => {
      // Clean up any test env vars
      delete process.env.TEST_IMPORT;
      delete process.env.MY_API_KEY;
      delete process.env.UPPERCASE_VAR;
      delete process.env.lowercase_var;
      delete process.env.LOWERCASE_VAR;
    });

    afterEach(() => {
      // Clean up test env vars
      delete process.env.TEST_IMPORT;
      delete process.env.MY_API_KEY;
      delete process.env.UPPERCASE_VAR;
      delete process.env.lowercase_var;
      delete process.env.LOWERCASE_VAR;
    });

    it("imports from environment variable", async () => {
      process.env.MY_API_KEY = "env-secret-value";

      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const params = buildParams("/secret import-env MY_API_KEY", cfg);

      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("Imported MY_API_KEY");
      expect(result.reply?.text).toContain("from env");
      expect(getSecretValue({ key: "MY_API_KEY" })).toBe("env-secret-value");
    });

    it("tries uppercase if original not found", async () => {
      // When user types "lowercase_var", the code tries:
      // 1. process.env["lowercase_var"] - not set
      // 2. process.env["LOWERCASE_VAR"] - we set this
      process.env.LOWERCASE_VAR = "uppercase-value";

      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const params = buildParams("/secret import-env lowercase_var", cfg);

      const result = await handleCommands(params);

      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("Imported");
      // Key is stored as uppercase version of var name
      expect(getSecretValue({ key: "LOWERCASE_VAR" })).toBe("uppercase-value");
    });

    it("returns error for missing env var", async () => {
      delete process.env.NONEXISTENT_VAR;

      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const params = buildParams("/secret import-env NONEXISTENT_VAR", cfg);

      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("not found");
    });

    it("attempts to delete the original message on import-env", async () => {
      process.env.TEST_IMPORT = "value";

      const mockRunMessageAction = vi.mocked(runMessageAction);
      mockRunMessageAction.mockResolvedValueOnce({ ok: true });

      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const params = buildParams("/secret import-env TEST_IMPORT", cfg, {
        MessageSid: "msg-456",
      });

      await handleCommands(params);

      expect(mockRunMessageAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "delete",
          params: { messageId: "msg-456" },
        }),
      );
    });
  });

  describe("alias: /s", () => {
    it("works with /s alias for set", async () => {
      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const params = buildParams("/s set ALIAS_KEY alias-value", cfg);

      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("ALIAS_KEY stored");
      expect(getSecretValue({ key: "ALIAS_KEY" })).toBe("alias-value");
    });

    it("works with /s alias for list", async () => {
      await upsertSecretValue({ key: "TEST", value: "val" });

      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const params = buildParams("/s list", cfg);

      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("TEST");
    });
  });

  describe("invalid subcommands", () => {
    it("returns usage for unknown subcommand", async () => {
      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const params = buildParams("/secret invalid", cfg);

      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("Usage:");
    });

    it("returns usage for bare /secret command", async () => {
      const cfg = {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;
      const params = buildParams("/secret", cfg);

      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("Usage:");
    });
  });
});
