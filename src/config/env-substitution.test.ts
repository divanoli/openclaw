import { beforeEach, describe, expect, it } from "vitest";
import {
  upsertSecretValue,
  deleteSecretValue,
  listSecretKeys,
} from "../agents/auth-profiles/profiles.js";
import { MissingEnvVarError, resolveConfigEnvVars } from "./env-substitution.js";

describe("resolveConfigEnvVars", () => {
  beforeEach(async () => {
    // Clean up secrets from previous tests
    const keys = listSecretKeys();
    for (const key of keys) {
      await deleteSecretValue({ key });
    }
  });

  describe("basic substitution", () => {
    it("substitutes a single env var", () => {
      const result = resolveConfigEnvVars({ key: "${FOO}" }, { FOO: "bar" });
      expect(result).toEqual({ key: "bar" });
    });

    it("substitutes multiple different env vars in same string", () => {
      const result = resolveConfigEnvVars({ key: "${A}/${B}" }, { A: "x", B: "y" });
      expect(result).toEqual({ key: "x/y" });
    });

    it("substitutes inline with prefix and suffix", () => {
      const result = resolveConfigEnvVars({ key: "prefix-${FOO}-suffix" }, { FOO: "bar" });
      expect(result).toEqual({ key: "prefix-bar-suffix" });
    });

    it("substitutes same var multiple times", () => {
      const result = resolveConfigEnvVars({ key: "${FOO}:${FOO}" }, { FOO: "bar" });
      expect(result).toEqual({ key: "bar:bar" });
    });
  });

  describe("nested structures", () => {
    it("substitutes in nested objects", () => {
      const result = resolveConfigEnvVars(
        {
          outer: {
            inner: {
              key: "${API_KEY}",
            },
          },
        },
        { API_KEY: "secret123" },
      );
      expect(result).toEqual({
        outer: {
          inner: {
            key: "secret123",
          },
        },
      });
    });

    it("substitutes in arrays", () => {
      const result = resolveConfigEnvVars(
        { items: ["${A}", "${B}", "${C}"] },
        { A: "1", B: "2", C: "3" },
      );
      expect(result).toEqual({ items: ["1", "2", "3"] });
    });

    it("substitutes in deeply nested arrays and objects", () => {
      const result = resolveConfigEnvVars(
        {
          providers: [
            { name: "openai", apiKey: "${OPENAI_KEY}" },
            { name: "anthropic", apiKey: "${ANTHROPIC_KEY}" },
          ],
        },
        { OPENAI_KEY: "sk-xxx", ANTHROPIC_KEY: "sk-yyy" },
      );
      expect(result).toEqual({
        providers: [
          { name: "openai", apiKey: "sk-xxx" },
          { name: "anthropic", apiKey: "sk-yyy" },
        ],
      });
    });
  });

  describe("missing env var handling", () => {
    it("throws MissingEnvVarError for missing env var", () => {
      expect(() => resolveConfigEnvVars({ key: "${MISSING}" }, {})).toThrow(MissingEnvVarError);
    });

    it("includes var name in error", () => {
      try {
        resolveConfigEnvVars({ key: "${MISSING_VAR}" }, {});
        throw new Error("Expected to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(MissingEnvVarError);
        const error = err as MissingEnvVarError;
        expect(error.varName).toBe("MISSING_VAR");
      }
    });

    it("includes config path in error", () => {
      try {
        resolveConfigEnvVars({ outer: { inner: { key: "${MISSING}" } } }, {});
        throw new Error("Expected to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(MissingEnvVarError);
        const error = err as MissingEnvVarError;
        expect(error.configPath).toBe("outer.inner.key");
      }
    });

    it("includes array index in config path", () => {
      try {
        resolveConfigEnvVars({ items: ["ok", "${MISSING}"] }, { OK: "val" });
        throw new Error("Expected to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(MissingEnvVarError);
        const error = err as MissingEnvVarError;
        expect(error.configPath).toBe("items[1]");
      }
    });

    it("treats empty string env var as missing", () => {
      expect(() => resolveConfigEnvVars({ key: "${EMPTY}" }, { EMPTY: "" })).toThrow(
        MissingEnvVarError,
      );
    });
  });

  describe("escape syntax", () => {
    it("outputs literal ${VAR} when escaped with $$", () => {
      const result = resolveConfigEnvVars({ key: "$${VAR}" }, { VAR: "value" });
      expect(result).toEqual({ key: "${VAR}" });
    });

    it("handles mix of escaped and unescaped", () => {
      const result = resolveConfigEnvVars({ key: "${REAL}/$${LITERAL}" }, { REAL: "resolved" });
      expect(result).toEqual({ key: "resolved/${LITERAL}" });
    });

    it("handles escaped and unescaped of the same var (escaped first)", () => {
      const result = resolveConfigEnvVars({ key: "$${FOO} ${FOO}" }, { FOO: "bar" });
      expect(result).toEqual({ key: "${FOO} bar" });
    });

    it("handles escaped and unescaped of the same var (unescaped first)", () => {
      const result = resolveConfigEnvVars({ key: "${FOO} $${FOO}" }, { FOO: "bar" });
      expect(result).toEqual({ key: "bar ${FOO}" });
    });

    it("handles multiple escaped vars", () => {
      const result = resolveConfigEnvVars({ key: "$${A}:$${B}" }, {});
      expect(result).toEqual({ key: "${A}:${B}" });
    });

    it("does not unescape $${VAR} sequences from env values", () => {
      const result = resolveConfigEnvVars({ key: "${FOO}" }, { FOO: "$${BAR}" });
      expect(result).toEqual({ key: "$${BAR}" });
    });
  });

  describe("non-matching patterns unchanged", () => {
    it("leaves $VAR (no braces) unchanged", () => {
      const result = resolveConfigEnvVars({ key: "$VAR" }, { VAR: "value" });
      expect(result).toEqual({ key: "$VAR" });
    });

    it("leaves ${lowercase} unchanged (uppercase only)", () => {
      const result = resolveConfigEnvVars({ key: "${lowercase}" }, { lowercase: "value" });
      expect(result).toEqual({ key: "${lowercase}" });
    });

    it("leaves ${MixedCase} unchanged", () => {
      const result = resolveConfigEnvVars({ key: "${MixedCase}" }, { MixedCase: "value" });
      expect(result).toEqual({ key: "${MixedCase}" });
    });

    it("leaves ${123INVALID} unchanged (must start with letter or underscore)", () => {
      const result = resolveConfigEnvVars({ key: "${123INVALID}" }, {});
      expect(result).toEqual({ key: "${123INVALID}" });
    });

    it("substitutes ${_UNDERSCORE_START} (valid)", () => {
      const result = resolveConfigEnvVars(
        { key: "${_UNDERSCORE_START}" },
        { _UNDERSCORE_START: "valid" },
      );
      expect(result).toEqual({ key: "valid" });
    });

    it("substitutes ${VAR_WITH_NUMBERS_123} (valid)", () => {
      const result = resolveConfigEnvVars(
        { key: "${VAR_WITH_NUMBERS_123}" },
        { VAR_WITH_NUMBERS_123: "valid" },
      );
      expect(result).toEqual({ key: "valid" });
    });
  });

  describe("passthrough behavior", () => {
    it("passes through primitives unchanged", () => {
      expect(resolveConfigEnvVars("hello", {})).toBe("hello");
      expect(resolveConfigEnvVars(42, {})).toBe(42);
      expect(resolveConfigEnvVars(true, {})).toBe(true);
      expect(resolveConfigEnvVars(null, {})).toBe(null);
    });

    it("passes through empty object", () => {
      expect(resolveConfigEnvVars({}, {})).toEqual({});
    });

    it("passes through empty array", () => {
      expect(resolveConfigEnvVars([], {})).toEqual([]);
    });

    it("passes through non-string values in objects", () => {
      const result = resolveConfigEnvVars({ num: 42, bool: true, nil: null, arr: [1, 2] }, {});
      expect(result).toEqual({ num: 42, bool: true, nil: null, arr: [1, 2] });
    });
  });

  describe("real-world config patterns", () => {
    it("substitutes API keys in provider config", () => {
      const config = {
        models: {
          providers: {
            "vercel-gateway": {
              apiKey: "${VERCEL_GATEWAY_API_KEY}",
            },
            openai: {
              apiKey: "${OPENAI_API_KEY}",
            },
          },
        },
      };
      const env = {
        VERCEL_GATEWAY_API_KEY: "vg_key_123",
        OPENAI_API_KEY: "sk-xxx",
      };
      const result = resolveConfigEnvVars(config, env);
      expect(result).toEqual({
        models: {
          providers: {
            "vercel-gateway": {
              apiKey: "vg_key_123",
            },
            openai: {
              apiKey: "sk-xxx",
            },
          },
        },
      });
    });

    it("substitutes gateway auth token", () => {
      const config = {
        gateway: {
          auth: {
            token: "${OPENCLAW_GATEWAY_TOKEN}",
          },
        },
      };
      const result = resolveConfigEnvVars(config, {
        OPENCLAW_GATEWAY_TOKEN: "secret-token",
      });
      expect(result).toEqual({
        gateway: {
          auth: {
            token: "secret-token",
          },
        },
      });
    });

    it("substitutes base URL with env var", () => {
      const config = {
        models: {
          providers: {
            custom: {
              baseUrl: "${CUSTOM_API_BASE}/v1",
            },
          },
        },
      };
      const result = resolveConfigEnvVars(config, {
        CUSTOM_API_BASE: "https://api.example.com",
      });
      expect(result).toEqual({
        models: {
          providers: {
            custom: {
              baseUrl: "https://api.example.com/v1",
            },
          },
        },
      });
    });
  });

  describe("$SECRET:KEY_NAME secret store references", () => {
    it("resolves $SECRET:KEY to stored secret value", async () => {
      await upsertSecretValue({ key: "MY_API_KEY", value: "sk-secret-123" });

      const result = resolveConfigEnvVars({ key: "$SECRET:MY_API_KEY" }, {});

      expect(result).toEqual({ key: "sk-secret-123" });
    });

    it("throws MissingEnvVarError for missing secret", () => {
      expect(() => resolveConfigEnvVars({ key: "$SECRET:MISSING_KEY" }, {})).toThrow(
        MissingEnvVarError,
      );
    });

    it("includes secret reference in error for missing secret", () => {
      try {
        resolveConfigEnvVars({ key: "$SECRET:MISSING_KEY" }, {});
        throw new Error("Expected to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(MissingEnvVarError);
        const error = err as MissingEnvVarError;
        expect(error.varName).toBe("$SECRET:MISSING_KEY");
        expect(error.configPath).toContain("secret store");
      }
    });

    it("mixes $SECRET: and ${ENV} in same string", async () => {
      await upsertSecretValue({ key: "API_KEY", value: "sk-secret" });

      // The colon between $SECRET:API_KEY and ${ENV_SUFFIX} is literal text
      const result = resolveConfigEnvVars(
        { key: "$SECRET:API_KEY:${ENV_SUFFIX}" },
        { ENV_SUFFIX: "-prod" },
      );

      expect(result).toEqual({ key: "sk-secret:-prod" });
    });

    it("does not match lowercase $SECRET:key (uppercase only)", async () => {
      await upsertSecretValue({ key: "UPPERCASE", value: "secret" });

      // lowercase 'key' after $SECRET: should NOT match
      const result = resolveConfigEnvVars({ key: "$SECRET:lowercase" }, {});

      // Left unchanged because lowercase doesn't match ENV_VAR_NAME_PATTERN
      expect(result).toEqual({ key: "$SECRET:lowercase" });
    });

    it("does not match $SECRET:KEY123INVALID (must start with letter or underscore)", async () => {
      const result = resolveConfigEnvVars({ key: "$SECRET:123INVALID" }, {});

      // Left unchanged because it doesn't start with letter/underscore
      expect(result).toEqual({ key: "$SECRET:123INVALID" });
    });

    it("leaves literal $SECRET text alone if no valid key follows", () => {
      const result = resolveConfigEnvVars({ key: "$SECRET" }, {});
      expect(result).toEqual({ key: "$SECRET" });
    });

    it("leaves $SECRET: alone if no key name follows", () => {
      const result = resolveConfigEnvVars({ key: "$SECRET:" }, {});
      expect(result).toEqual({ key: "$SECRET:" });
    });

    it("resolves multiple $SECRET: references", async () => {
      await upsertSecretValue({ key: "KEY_ONE", value: "value-one" });
      await upsertSecretValue({ key: "KEY_TWO", value: "value-two" });

      const result = resolveConfigEnvVars({ key: "$SECRET:KEY_ONE:$SECRET:KEY_TWO" }, {});

      expect(result).toEqual({ key: "value-one:value-two" });
    });

    it("resolves $SECRET:KEY with underscore prefix", async () => {
      await upsertSecretValue({ key: "_PRIVATE", value: "private-value" });

      const result = resolveConfigEnvVars({ key: "$SECRET:_PRIVATE" }, {});

      expect(result).toEqual({ key: "private-value" });
    });

    it("works with nested provider configs", async () => {
      await upsertSecretValue({ key: "XAI_KEY", value: "xai-secret" });
      await upsertSecretValue({ key: "OPENAI_KEY", value: "openai-secret" });

      const config = {
        models: {
          providers: {
            xai: { apiKey: "$SECRET:XAI_KEY" },
            openai: { apiKey: "$SECRET:OPENAI_KEY" },
          },
        },
      };

      const result = resolveConfigEnvVars(config, {});

      expect(result).toEqual({
        models: {
          providers: {
            xai: { apiKey: "xai-secret" },
            openai: { apiKey: "openai-secret" },
          },
        },
      });
    });
  });
});
