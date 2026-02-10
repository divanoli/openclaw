# Known Issues & Edge Cases

> **Source:** Kimi's post-implementation reflection + Claude cross-validation
> **Date:** 2026-02-10
> **Status:** Pre-VM-testing — none of these are blockers

---

## Priority Summary

| Priority    | Issue                                           | Impact                    | Mitigation                               |
| ----------- | ----------------------------------------------- | ------------------------- | ---------------------------------------- |
| High (test) | Message deletion failures may spam logs         | Log noise                 | Verify in VM, adjust log level if needed |
| Medium      | `redactStoredSecrets()` perf with many secrets  | Slower message processing | Cache/optimize if >50 secrets            |
| Medium      | No event hooks for secret lifecycle             | Limited extensibility     | Add hooks in future iteration            |
| Low         | `MissingEnvVarError` reused for missing secrets | Confusing error message   | Rename or wrap error                     |
| Low         | No CLI parity (`openclaw secret` commands)      | Incomplete UX             | Add in follow-up                         |

---

## Detailed Analysis

### 1. Concurrent Secret Operations

The `updateAuthProfileStoreWithLock()` uses `proper-lockfile` for file locking, but concurrent `/secret` commands from multiple channels simultaneously were not explicitly tested. The lock _should_ handle this correctly, but it's not covered by unit tests.

**Action:** Test during VM validation with simultaneous writes.

### 2. Secret Value Containing Redaction Sentinel

If a user stores a secret value that contains `[REDACTED: stored secret "KEY"]`, Phase 2 redaction could create confusing nested redactions. Not harmful, but visually confusing.

**Severity:** Very Low — unlikely in practice.

### 3. Very Long Secret Keys in `$SECRET:` Resolution

The key name parsing in `env-substitution.ts` uses a `while` loop with regex test:

```typescript
while (end < value.length && /[A-Z0-9_]/.test(value[end]!)) {
  end++;
}
```

Extremely long keys (1000+ chars) could be slow. Mitigated by the fact that `substituteString()` returns early if `!value.includes("$")`.

**Severity:** Very Low — keys are user-defined and constrained by validation regex.

### 4. Unicode in Secret Keys

The validation regex `/^[A-Z_][A-Z0-9_]*$/` won't match Unicode uppercase letters (e.g., `E`, `U`). This is intentional for simplicity and consistency with env var naming conventions.

**Action:** Document as expected behavior.

### 5. `redactStoredSecrets()` Sorting Assumption

Secrets are sorted by value length DESC to avoid partial matches. This assumes longer values are "more specific" — which is usually true. But overlapping secrets (e.g., `abc` and `abc123`) with the text `abc123` will correctly match the longer one first.

Edge case: if someone stores `abc` and `abcdef`, and text contains `abcdefg`, the longer match takes precedence. This is correct behavior.

**Severity:** Very Low — sorting by length is the right approach.

### 6. `MissingEnvVarError` for Missing Secrets

In `env-substitution.ts`, missing `$SECRET:` references throw `MissingEnvVarError`. The error message says "Missing env var" but it's actually a missing secret. Slightly confusing.

**Improvement:** A dedicated `MissingSecretError` would be cleaner. Low priority since the error message includes the key name which provides context.

### 7. Message Deletion Best-Effort Logging

On platforms that don't support message deletion (WhatsApp, iMessage, Signal), or when deletion fails, the command handler logs a warning and continues. If deletion is _consistently_ failing (e.g., bot lacks permissions in a Telegram group), this could produce log spam.

**Action:** Verify in VM testing. Consider rate-limiting the warning or downgrading log level after first failure.

### 8. Secret Inheritance — Subagent Edge Cases

Subagents inherit secrets from main agent via `ensureAuthProfileStore()`. Two timing edge cases:

- **Fresh VM with no main secrets + new subagent:** Should work fine (empty merge).
- **Main adds secret after subagent exists:** Subagent won't see it until it re-reads the store. Since `ensureAuthProfileStore()` reads fresh on each call, this should be transparent. Verify in VM.

### 9. Config Reload Behavior

If a user changes secrets via `/secret set` while OpenClaw is running, the config reference `$SECRET:KEY` resolves correctly on next use because:

- `getSecretValue()` reads from the store each time
- `listSecretKeys()` (Phase 2 redaction) reads fresh each time

No caching issues expected, but verify in VM.

### 10. Phase 2 Limitation — Session Transcripts

**Critical caveat (already documented in IMPLEMENTATION.md):**

Pi SDK persists original user messages to session transcripts via `session.prompt()` -> `appendFileSync`. Phase 2's `redactStoredSecrets()` runs in `finalizeInboundContext()`, which protects the LLM context. But the _original_ message body is what gets passed to `activeSession.prompt()` later.

Only Phase 1's `/secret` command (with `shouldContinue: false`) prevents transcript persistence entirely.

---

## Confidence Assessment

**Overall confidence: 85%**

The implementation is solid for typical use cases (10-20 secrets). Untested areas:

- Performance with 100+ secrets
- Subagent inheritance timing
- Message deletion reliability across all platforms
- Concurrent multi-channel secret operations

VM testing should focus on these areas.
