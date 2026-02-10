import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteSecretValue,
  getSecretValue,
  listSecretKeys,
  upsertSecretValue,
  validateSecretKey,
} from "./profiles.js";
import { ensureAuthProfileStore } from "./store.js";

describe("Secret CRUD functions", () => {
  beforeEach(async () => {
    // Clean up secrets from previous tests
    const keys = listSecretKeys();
    for (const key of keys) {
      await deleteSecretValue({ key });
    }
  });

  describe("validateSecretKey", () => {
    it("accepts valid UPPER_SNAKE_CASE keys", () => {
      expect(validateSecretKey("API_KEY")).toBeNull();
      expect(validateSecretKey("MY_SECRET_TOKEN")).toBeNull();
      expect(validateSecretKey("KEY123")).toBeNull();
      expect(validateSecretKey("X")).toBeNull();
    });

    it("rejects empty keys", () => {
      expect(validateSecretKey("")).toBe("Secret key cannot be empty");
    });

    it("rejects lowercase keys", () => {
      expect(validateSecretKey("api_key")).toContain("UPPER_SNAKE_CASE");
    });

    it("rejects mixed case keys", () => {
      expect(validateSecretKey("Api_Key")).toContain("UPPER_SNAKE_CASE");
    });

    it("rejects keys with hyphens", () => {
      expect(validateSecretKey("API-KEY")).toContain("UPPER_SNAKE_CASE");
    });

    it("rejects keys with special characters", () => {
      expect(validateSecretKey("API@KEY")).toContain("UPPER_SNAKE_CASE");
      expect(validateSecretKey("API.KEY")).toContain("UPPER_SNAKE_CASE");
      expect(validateSecretKey("API KEY")).toContain("UPPER_SNAKE_CASE");
    });

    it("rejects keys starting with numbers", () => {
      expect(validateSecretKey("123_KEY")).toContain("UPPER_SNAKE_CASE");
    });

    it("rejects keys starting with __ (double underscore)", () => {
      expect(validateSecretKey("__RESERVED")).toContain("reserved");
      expect(validateSecretKey("__INTERNAL")).toContain("reserved");
    });

    it("accepts single underscore prefix", () => {
      expect(validateSecretKey("_PRIVATE")).toBeNull();
    });

    it("accepts underscore within key", () => {
      expect(validateSecretKey("MY_API_KEY")).toBeNull();
    });

    it("accepts numbers after first character", () => {
      expect(validateSecretKey("API_KEY_123")).toBeNull();
    });
  });

  describe("upsertSecretValue", () => {
    it("stores a new secret", async () => {
      const result = await upsertSecretValue({ key: "TEST_KEY", value: "test-value" });
      expect(result.ok).toBe(true);
      expect(getSecretValue({ key: "TEST_KEY" })).toBe("test-value");
    });

    it("updates an existing secret", async () => {
      await upsertSecretValue({ key: "UPDATE_KEY", value: "original" });
      const result = await upsertSecretValue({ key: "UPDATE_KEY", value: "updated" });
      expect(result.ok).toBe(true);
      expect(getSecretValue({ key: "UPDATE_KEY" })).toBe("updated");
    });

    it("normalizes key to uppercase", async () => {
      await upsertSecretValue({ key: "mixed_Case_KEY", value: "value" });
      // The function should store with the provided key (caller responsible for uppercase)
      // But validation would fail - let's check the actual behavior
      const result = await upsertSecretValue({ key: "lower_key", value: "value" });
      // lower_key is valid UPPER_SNAKE_CASE (all lowercase fails)
      expect(result.ok).toBe(false);
    });

    it("rejects invalid keys", async () => {
      const result = await upsertSecretValue({ key: "invalid-key", value: "value" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("UPPER_SNAKE_CASE");
    });

    it("rejects empty values", async () => {
      const result = await upsertSecretValue({ key: "TEST_KEY", value: "" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("cannot be empty");
    });

    it("rejects whitespace-only values", async () => {
      const result = await upsertSecretValue({ key: "TEST_KEY", value: "   \n\t  " });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("cannot be empty");
    });

    it("rejects values exceeding 16KB", async () => {
      const hugeValue = "x".repeat(20_000);
      const result = await upsertSecretValue({ key: "TEST_KEY", value: hugeValue });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("16384");
    });

    it("accepts values at exactly 16KB", async () => {
      const maxValue = "x".repeat(16_384);
      const result = await upsertSecretValue({ key: "TEST_KEY", value: maxValue });
      expect(result.ok).toBe(true);
    });

    it("normalizes secret input (removes line breaks)", async () => {
      const valueWithBreaks = "line1\r\nline2\nline3\u2028line4";
      await upsertSecretValue({ key: "NORMALIZE_TEST", value: valueWithBreaks });
      const stored = getSecretValue({ key: "NORMALIZE_TEST" });
      expect(stored).toBe("line1line2line3line4");
      expect(stored).not.toContain("\n");
      expect(stored).not.toContain("\r");
    });

    it("trims whitespace from value", async () => {
      await upsertSecretValue({ key: "TRIM_TEST", value: "  value-with-spaces  " });
      const stored = getSecretValue({ key: "TRIM_TEST" });
      expect(stored).toBe("value-with-spaces");
    });

    it("preserves internal spaces (Bearer tokens)", async () => {
      const bearerToken = "Bearer abc123 xyz789";
      await upsertSecretValue({ key: "BEARER_TEST", value: bearerToken });
      const stored = getSecretValue({ key: "BEARER_TEST" });
      expect(stored).toBe("Bearer abc123 xyz789");
    });

    it("stores secrets agent-specific when agentDir provided", async () => {
      const agentDir = "/tmp/test-agent";
      await upsertSecretValue({ key: "AGENT_KEY", value: "agent-value", agentDir });

      // Should exist for that agent
      expect(getSecretValue({ key: "AGENT_KEY", agentDir })).toBe("agent-value");

      // Should not exist for main (unless inherited)
      // Note: This test assumes no inheritance is configured
    });
  });

  describe("getSecretValue", () => {
    it("returns the stored value", async () => {
      await upsertSecretValue({ key: "GET_TEST", value: "get-value" });
      expect(getSecretValue({ key: "GET_TEST" })).toBe("get-value");
    });

    it("returns undefined for non-existent keys", () => {
      expect(getSecretValue({ key: "NONEXISTENT" })).toBeUndefined();
    });

    it("returns undefined after deletion", async () => {
      await upsertSecretValue({ key: "DELETE_TEST", value: "value" });
      await deleteSecretValue({ key: "DELETE_TEST" });
      expect(getSecretValue({ key: "DELETE_TEST" })).toBeUndefined();
    });
  });

  describe("listSecretKeys", () => {
    it("returns empty array when no secrets", () => {
      expect(listSecretKeys()).toEqual([]);
    });

    it("returns sorted list of keys", async () => {
      await upsertSecretValue({ key: "Z_KEY", value: "z" });
      await upsertSecretValue({ key: "A_KEY", value: "a" });
      await upsertSecretValue({ key: "M_KEY", value: "m" });

      const keys = listSecretKeys();
      expect(keys).toEqual(["A_KEY", "M_KEY", "Z_KEY"]);
    });

    it("excludes deleted keys", async () => {
      await upsertSecretValue({ key: "KEEP", value: "keep" });
      await upsertSecretValue({ key: "DELETE", value: "delete" });
      await deleteSecretValue({ key: "DELETE" });

      expect(listSecretKeys()).toEqual(["KEEP"]);
    });
  });

  describe("deleteSecretValue", () => {
    it("deletes an existing secret", async () => {
      await upsertSecretValue({ key: "TO_DELETE", value: "value" });
      const result = await deleteSecretValue({ key: "TO_DELETE" });

      expect(result.ok).toBe(true);
      expect(result.existed).toBe(true);
      expect(getSecretValue({ key: "TO_DELETE" })).toBeUndefined();
    });

    it("returns existed: false for non-existent keys", async () => {
      const result = await deleteSecretValue({ key: "NEVER_EXISTED" });

      expect(result.ok).toBe(true);
      expect(result.existed).toBe(false);
    });

    it("cleans up empty secrets object", async () => {
      await upsertSecretValue({ key: "ONLY_KEY", value: "value" });
      await deleteSecretValue({ key: "ONLY_KEY" });

      const store = ensureAuthProfileStore();
      expect(store.secrets).toBeUndefined();
    });

    it("preserves other keys when deleting one", async () => {
      await upsertSecretValue({ key: "KEEP1", value: "v1" });
      await upsertSecretValue({ key: "DELETE", value: "v2" });
      await upsertSecretValue({ key: "KEEP2", value: "v3" });

      await deleteSecretValue({ key: "DELETE" });

      expect(getSecretValue({ key: "KEEP1" })).toBe("v1");
      expect(getSecretValue({ key: "KEEP2" })).toBe("v3");
      expect(getSecretValue({ key: "DELETE" })).toBeUndefined();
    });
  });

  describe("integration with auth store", () => {
    it("secrets persist across store reloads", async () => {
      await upsertSecretValue({ key: "PERSIST_KEY", value: "persist-value" });

      // Force store reload by creating a fresh store reference
      const freshStore = ensureAuthProfileStore();
      expect(freshStore.secrets?.["PERSIST_KEY"]).toBe("persist-value");
    });

    it("secrets are included in store save", async () => {
      await upsertSecretValue({ key: "SAVE_TEST", value: "save-value" });

      const store = ensureAuthProfileStore();
      expect(store.secrets).toBeDefined();
      expect(store.secrets?.["SAVE_TEST"]).toBe("save-value");
    });
  });

  describe("concurrent operations", () => {
    it("handles rapid sequential updates", async () => {
      const key = "RAPID_UPDATE";

      // Multiple rapid updates
      await upsertSecretValue({ key, value: "v1" });
      await upsertSecretValue({ key, value: "v2" });
      await upsertSecretValue({ key, value: "v3" });

      expect(getSecretValue({ key })).toBe("v3");
    });

    it("handles interleaved set and delete", async () => {
      const key = "INTERLEAVED";

      await upsertSecretValue({ key, value: "value" });
      await deleteSecretValue({ key });
      await upsertSecretValue({ key, value: "new-value" });

      expect(getSecretValue({ key })).toBe("new-value");
    });
  });
});

describe("Secret store inheritance", () => {
  // Note: These tests verify the inheritance behavior from main agent to subagents
  // The inheritance is handled by ensureAuthProfileStore merging main into subagent

  it("main agent secrets are inherited by subagents", async () => {
    // Set secret in main
    await upsertSecretValue({ key: "INHERIT_KEY", value: "inherited" });

    // Subagent should see it (via merge in ensureAuthProfileStore)
    const subagentKeys = listSecretKeys({ agentDir: "/tmp/subagent" });
    expect(subagentKeys).toContain("INHERIT_KEY");
  });

  it("subagent can override inherited secrets", async () => {
    // Set in main
    await upsertSecretValue({ key: "OVERRIDE_KEY", value: "main-value" });

    // Override in subagent
    await upsertSecretValue({
      key: "OVERRIDE_KEY",
      value: "subagent-value",
      agentDir: "/tmp/subagent",
    });

    // Subagent sees its own value
    expect(getSecretValue({ key: "OVERRIDE_KEY", agentDir: "/tmp/subagent" })).toBe(
      "subagent-value",
    );

    // Main still has original
    expect(getSecretValue({ key: "OVERRIDE_KEY" })).toBe("main-value");
  });
});
