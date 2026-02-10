# Secure Secret Input — Implementation Reference

> **Branch**: `feat/secret-command`
> **Status**: Phases 1-3 implemented, Phase 4 deferred
> **Tests**: 144 passing across 5 test files
> **Authors**: Claude (architect) + Kimi (implementer), coordinated by Divan

---

## What Was Built

### Phase 1: `/secret` Command + Auth-Profile Storage

Intercepts `/secret` commands **before** the LLM pipeline. Secrets are stored in `auth-profiles.json` and never reach conversation context or session transcripts.

**Subcommands:**

```
/secret set <KEY> <value>       Store a secret (UPPER_SNAKE_CASE key)
/secret get <KEY>               Check existence + char count (no value shown)
/secret list                    List stored secret names
/secret delete <KEY>            Remove a secret
/secret import-env <VAR>        Import from environment variable
```

Alias: `/s` (e.g., `/s set MY_KEY value`)

**Security guarantees:**

- Handler is first in HANDLERS array — runs before plugins
- `"secret"` and `"s"` in RESERVED_COMMANDS — plugins can't hijack
- Always returns `shouldContinue: false` — message never reaches LLM
- Best-effort deletion of original message (Discord, Telegram, Slack)
- Key validation: `/^[A-Z_][A-Z0-9_]*$/`, `__` prefix reserved, 16KB value limit

### Phase 2: Pre-LLM Message Scanning

Safety net for accidental secret inclusion in normal messages. All stored secret values are compared against inbound message text. Matches are replaced with `[REDACTED: stored secret "KEY"]`.

**Scanned fields:** `Body`, `BodyForAgent`, `BodyForCommands`, `RawBody`, `CommandBody`

**Also:** Config snapshot redaction (`redactRawText`) now includes stored secret values, preventing leakage through Web UI or tool output.

**Caveat:** Pi SDK persists original user messages to session transcripts via `session.prompt()` → `appendFileSync`. Phase 2 protects the LLM context but NOT transcripts. Only Phase 1's `/secret` command prevents transcript persistence.

### Phase 3: `$SECRET:KEY` Config References

Config values can reference stored secrets:

```json5
{
  models: {
    providers: {
      xai: { apiKey: "$SECRET:XAI_API_KEY" },
    },
  },
}
```

Resolved at config load time. Missing secrets throw `MissingEnvVarError`.

`getCustomProviderApiKey()` also resolves `$SECRET:` prefix directly for the model auth resolution chain.

---

## Files Changed

### Phase 1

| File                                       | Action                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `src/agents/auth-profiles/types.ts`        | Added `secrets?: Record<string, string>` to `AuthProfileStore`                                          |
| `src/agents/auth-profiles/store.ts`        | Updated `_syncAuthProfileStore`, `coerceAuthStore`, `mergeAuthProfileStores`, `saveAuthProfileStore`    |
| `src/agents/auth-profiles/profiles.ts`     | Added `validateSecretKey`, `upsertSecretValue`, `getSecretValue`, `listSecretKeys`, `deleteSecretValue` |
| `src/auto-reply/reply/commands-secret.ts`  | **NEW** — `/secret` command handler                                                                     |
| `src/auto-reply/commands-registry.data.ts` | Registered command definition + `/s` alias                                                              |
| `src/auto-reply/reply/commands-core.ts`    | `handleSecretCommand` first in HANDLERS array                                                           |
| `src/plugins/commands.ts`                  | `"secret"` + `"s"` added to `RESERVED_COMMANDS`                                                         |

### Phase 2

| File                                      | Action                                                     |
| ----------------------------------------- | ---------------------------------------------------------- |
| `src/auto-reply/reply/inbound-context.ts` | Added `redactStoredSecrets()`, applied to 5 text fields    |
| `src/config/redact-snapshot.ts`           | Added `collectStoredSecretValues()` into `redactRawText()` |

### Phase 3

| File                             | Action                                                     |
| -------------------------------- | ---------------------------------------------------------- |
| `src/config/env-substitution.ts` | Added `$SECRET:KEY_NAME` handler in `substituteString()`   |
| `src/agents/model-auth.ts`       | `$SECRET:` prefix detection in `getCustomProviderApiKey()` |
| `src/agents/auth-profiles.ts`    | Exported secret CRUD functions from barrel file            |

### Test Files

| File                                                   | Tests                                      |
| ------------------------------------------------------ | ------------------------------------------ |
| `src/agents/auth-profiles/profiles.test.ts`            | 39 (secret CRUD, validation, inheritance)  |
| `src/auto-reply/reply/commands-secret.test.ts`         | 28 (handler, auth, subcommands, alias)     |
| `src/auto-reply/reply/inbound-context-secrets.test.ts` | 17 (redaction, edge cases)                 |
| `src/config/env-substitution.test.ts`                  | 42 total (12 new for `$SECRET:`)           |
| `src/agents/model-auth.test.ts`                        | 18 total (5 new for `$SECRET:` resolution) |

---

## Architecture

```
User: /secret set XAI_KEY sk-abc123
         │
         ▼
  handleSecretCommand [HANDLERS[0]]
         │
         ├── Validates key (UPPER_SNAKE_CASE)
         ├── Normalizes value (strips line breaks, trims)
         ├── Stores in auth-profiles.json secrets field
         ├── Best-effort deletes original message
         └── Returns { shouldContinue: false }
              → Pipeline STOPS. LLM never sees the message.

User: My key is sk-abc123 (normal message)
         │
         ▼
  finalizeInboundContext()
         │
         ├── normalizeInboundTextNewlines (existing)
         ├── redactStoredSecrets() [NEW]
         │    └── "My key is [REDACTED: stored secret "XAI_KEY"]"
         └── formatInboundBodyWithSenderMeta (existing)
              → LLM sees redacted text

Config: { apiKey: "$SECRET:XAI_KEY" }
         │
         ▼
  substituteString() / getCustomProviderApiKey()
         │
         └── Resolves to "sk-abc123" at runtime
              → Config file never contains actual secret
```

---

## Phase 4: Encrypted At-Rest (Deferred)

Planned but deferred pending community validation:

- age-based encryption for the `secrets` section of auth-profiles.json
- X25519 key stored in `~/.openclaw/credentials/secret-key.txt`
- Decrypted only in-memory at runtime
- Dependency: `age-encryption` npm package or shell-out to `age` binary

---

## Validation Checklist

- [ ] Test on fresh OpenClaw setup in VM
- [ ] `/secret set TEST_KEY abc123` → stored, not in LLM context
- [ ] `/secret get TEST_KEY` → "exists (6 chars)"
- [ ] `/secret list` → "• TEST_KEY"
- [ ] `/secret delete TEST_KEY` → deleted
- [ ] Normal message with secret value → redacted before LLM
- [ ] Config `apiKey: "$SECRET:KEY"` → resolves correctly
- [ ] Plugin can't register `/secret` → blocked by RESERVED_COMMANDS
- [ ] Unauthorized sender → blocked
- [ ] Propose to OpenClaw community

---

## Related Documents

- [RESEARCH.md](RESEARCH.md) — Original research (problem statement, prior art, codebase audit, threat model)
- [FEEDBACK.md](FEEDBACK.md) — Kimi's code-validated feedback + Claude Opus cross-validation
- [KNOWN-ISSUES.md](KNOWN-ISSUES.md) — Edge cases and concerns from post-implementation review
- [README.md](README.md) — Documentation index
