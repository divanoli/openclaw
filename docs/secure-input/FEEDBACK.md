# Code-Validated Feedback on Secure Input Research Document

> **Date:** 2026-02-10  
> **Original Document:** SECURE-INPUT-RESEARCH.md  
> **Validation:** Multi-agent codebase audit completed  
> **Status:** Production-ready specification with minor amendments

---

## Executive Summary

The SECURE-INPUT-RESEARCH.md document has been **comprehensively validated** against the OpenClaw codebase via parallel agent analysis. The research is **architecturally sound, technically accurate, and ready for implementation**.

### Validation Results

| Aspect                     | Status        | Notes                                                       |
| -------------------------- | ------------- | ----------------------------------------------------------- |
| Code references            | ✅ Verified   | All file paths and line numbers accurate                    |
| Architecture understanding | ✅ Correct    | Handler chain, auth store, interception points all verified |
| Existing defenses          | ✅ Complete   | All 4 layers correctly identified                           |
| Proposed changes           | ✅ Compatible | Follows existing patterns                                   |
| Threat model               | ✅ Realistic  | Threats align with actual code flow                         |

**Overall Rating:** 9/10 — Implement with amendments noted below.

---

## Critical Findings from Code Validation

### 1. User Message Session Flow — IMPORTANT CORRECTION

**Research Document Claim:** "User messages are stored in session transcript via `SessionManager`"

**Validated Reality:**

- `appendAssistantMessageToSessionTranscript()` (src/config/sessions/transcript.ts:78) handles **assistant messages only**
- **User messages** are persisted **internally by the Pi SDK** via `session.prompt()` (src/agents/pi-embedded-runner/run/attempt.ts:820)
- OpenClaw never directly calls `appendMessage` for user messages

**Flow Verification:**

```
Platform Adapter
    ↓
dispatchInboundMessage()                    ← src/auto-reply/dispatch.ts:17
    ↓
finalizeInboundContext()                    ← src/auto-reply/reply/inbound-context.ts:21
    ↓
handleCommands()                            ← src/auto-reply/reply/commands-core.ts:38
    │   │
    │   └── /secret handler returns {shouldContinue: false} → STOPS HERE ✓
    │
    └── shouldContinue: true → continues
        ↓
dispatchReplyFromConfig()
    ↓
runAttempt() / embeddedPiRunAttempt()       ← src/agents/pi-embedded-runner/run/attempt.ts
    ↓
activeSession.prompt(effectivePrompt)       ← Line 820
    ↓
[INSIDE Pi SDK] SessionManager.appendMessage({role: "user"}) ← ALREADY PERSISTED
```

**Implication:** The command handler (Phase 1) is the **ONLY** reliable interception point. Once `session.prompt()` is called, the user message is already being persisted by Pi SDK internals. Phase 2's pre-LLM scanning in `finalizeInboundContext()` runs before the LLM but **after** the message has been persisted to the transcript.

**Recommendation:** Clarify in the document that Phase 2 redacts secrets from the LLM context but does NOT prevent persistence in session transcripts. Only Phase 1 (`/secret` command with `shouldContinue: false`) prevents transcript persistence.

---

### 2. Platform Message Deletion — CONFIRMED

**Research Document Claim:** Discord, Slack, Telegram support deletion; WhatsApp/iMessage don't.

**Validated:**

| Platform         | Deletion Support | Evidence                                                     |
| ---------------- | ---------------- | ------------------------------------------------------------ |
| **Discord**      | ✅ YES           | `src/discord/send.messages.ts:60` - `deleteMessageDiscord()` |
| **Telegram**     | ✅ YES           | `src/telegram/send.ts:648` - `deleteMessageTelegram()`       |
| **Slack**        | ✅ YES           | `src/slack/actions.ts:175` - `deleteSlackMessage()`          |
| **WhatsApp Web** | ❌ NO            | No delete function in `src/web/outbound.ts`                  |
| **iMessage**     | ❌ NO            | No delete function in `src/imessage/send.ts`                 |
| **Signal**       | ❌ NO            | No delete action in `src/channels/plugins/actions/signal.ts` |

**Cross-Platform Abstraction Available:**

```typescript
// src/channels/plugins/message-actions.ts:38-49
export async function dispatchChannelMessageAction(ctx: ChannelMessageActionContext) {
  const plugin = getChannelPlugin(ctx.channel);
  return await plugin.actions.handleAction(ctx); // Routes to appropriate adapter
}
```

**Action names:** `send`, `delete`, `edit`, `react` (src/channels/plugins/message-action-names.ts)

**Recommendation:** The `/secret` command should use `dispatchChannelMessageAction()` with action `"delete"` for best-effort deletion. Document notes this is correct.

---

### 3. Plugin Command Interception — CRITICAL AMENDMENT REQUIRED

**Research Document Claim:** Insert `handleSecretCommand` before `handlePluginCommand` in HANDLERS array.

**Validated:** The approach is correct BUT insufficient alone.

**Current Handler Order (src/auto-reply/reply/commands-core.ts:40-63):**

```typescript
HANDLERS = [
  handlePluginCommand, // Position 0 - plugins can intercept commands
  handleBashCommand,
  // ...
];
```

**Critical Gap:** `RESERVED_COMMANDS` in `src/plugins/commands.ts` does NOT include `"secret"`:

```typescript
const RESERVED_COMMANDS = new Set([
  "help",
  "commands",
  "status",
  "whoami" /* ... 20+ commands ... */,
  // "secret" is NOT here ← RISK
]);
```

**Risk:** A plugin could register `/secret` and intercept it before the built-in handler.

**Required Amendment:**

1. Add `"secret"` to `RESERVED_COMMANDS` in `src/plugins/commands.ts`
2. Insert `handleSecretCommand` at position 0 in HANDLERS array

**Validated Command Matching:**

- Uses **exact Map lookup**: `pluginCommands.get("/secret")`
- Case-insensitive: `/SECRET`, `/Secret` all match
- No prefix matching - `/secrets` ≠ `/secret`

---

### 4. Web UI Config Patch Flow — CONFIRMED COMPATIBLE

**Research Document Claim:** `$SECRET:KEY` references will work with Web UI.

**Validated:** Fully compatible. Here's why:

**`restoreRedactedValues()` Logic (src/config/redact-snapshot.ts:137-168):**

```typescript
for (const [key, value] of Object.entries(incoming)) {
  if (isSensitiveKey(key) && value === REDACTED_SENTINEL) {
    // Only restore if EXACTLY the sentinel value
    result[key] = orig[key];
  } else {
    result[key] = value; // $SECRET:KEY preserved as-is!
  }
}
```

**`$SECRET:KEY` is NOT redacted because:**

1. It's a **reference**, not an actual secret value
2. `collectSensitiveValues()` only finds actual secret strings in config objects
3. `"$SECRET:XAI_API_KEY"` doesn't match any stored secret

**Round-Trip Verification:**
| Step | Config Value | Status |
|------|--------------|--------|
| Disk | `apiKey: "$SECRET:XAI_API_KEY"` | ✓ |
| config.get | `"$SECRET:XAI_API_KEY"` | ✓ (not redacted) |
| Web UI edit | `"$SECRET:XAI_API_KEY"` unchanged | ✓ |
| config.patch | `"$SECRET:XAI_API_KEY"` sent | ✓ |
| restoreRedactedValues | Preserved (not sentinel) | ✓ |
| Disk | `apiKey: "$SECRET:XAI_API_KEY"` | ✓ |

**Recommendation:** Document confirms this correctly.

---

### 5. Existing Secret Infrastructure — LEVERAGE OPPORTUNITIES

The research document identifies existing defenses but under-references leverage points:

#### A. Auth-Profiles Store (src/agents/auth-profiles/)

**Existing Infrastructure to Reuse:**

```typescript
// store.ts:21-48 - File locking already implemented
export async function updateAuthProfileStoreWithLock(params: {
  agentDir?: string;
  updater: (store: AuthProfileStore) => boolean;
}): Promise<AuthProfileStore | null>;

// store.ts:351-366 - Main→subagent inheritance
export function ensureAuthProfileStore(agentDir?: string): AuthProfileStore {
  const store = loadAuthProfileStoreForAgent(agentDir);
  const mainStore = loadAuthProfileStoreForAgent(undefined);
  return mergeAuthProfileStores(mainStore, store); // Merges main into subagent
}
```

**The `secrets` field naturally inherits via existing merge logic.**

#### B. Secret Normalization (src/utils/normalize-secret-input.ts)

```typescript
export function normalizeSecretInput(value: unknown): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, "").trim();
}
```

**Already used by:** `upsertAuthProfile()` — reuse for `/secret set`.

#### C. Security Audit Integration (src/security/audit-extra.ts)

Extend `collectSecretsInConfigFindings()` to check for:

- Unresolvable `$SECRET:` references
- Secrets stored in plaintext (migration recommendation)

#### D. CLI Pattern Consistency

**Consider adding CLI parity:**

```bash
openclaw secret set <KEY> <VALUE>
openclaw secret get <KEY>
openclaw secret list
openclaw secret delete <KEY>
openclaw secret import-env <VAR>
```

Follows pattern of `openclaw config set/get`, `openclaw models set`, etc.

---

## Implementation Amendments

### Amendment 1: RESERVED_COMMANDS Update

**File:** `src/plugins/commands.ts`

```typescript
const RESERVED_COMMANDS = new Set([
  // ... existing commands ...
  "secret", // ← ADD THIS
]);
```

**Purpose:** Prevents plugins from registering `/secret` command.

### Amendment 2: Handler Order

**File:** `src/auto-reply/reply/commands-core.ts`

```typescript
HANDLERS = [
  handleSecretCommand, // ← INSERT FIRST (before handlePluginCommand)
  handlePluginCommand, // Existing
  handleBashCommand,
  // ...
];
```

### Amendment 3: Secrets Namespace Extension

**File:** `src/agents/auth-profiles/types.ts`

```typescript
export type AuthProfileStore = {
  version: number;
  profiles: Record<string, AuthProfileCredential>;
  secrets?: Record<string, string>; // ← NEW
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>;
  usageStats?: Record<string, ProfileUsageStats>;
};
```

### Amendment 4: Store Functions Extension

**File:** `src/agents/auth-profiles/profiles.ts` (or new `secrets.ts`)

```typescript
export function upsertSecretValue(params: { key: string; value: string; agentDir?: string }): void {
  const normalized = normalizeSecretInput(value);
  const store = ensureAuthProfileStore(params.agentDir);
  store.secrets = store.secrets ?? {};
  store.secrets[params.key] = normalized;
  saveAuthProfileStore(store, params.agentDir);
}

export function getSecretValue(params: { key: string; agentDir?: string }): string | undefined {
  const store = ensureAuthProfileStore(params.agentDir);
  return store.secrets?.[params.key];
}

export function listSecretKeys(agentDir?: string): string[] {
  const store = ensureAuthProfileStore(agentDir);
  return Object.keys(store.secrets ?? {});
}

export function deleteSecretValue(params: { key: string; agentDir?: string }): boolean {
  const store = ensureAuthProfileStore(params.agentDir);
  if (!store.secrets?.[params.key]) return false;
  delete store.secrets[params.key];
  if (Object.keys(store.secrets).length === 0) {
    delete store.secrets;
  }
  saveAuthProfileStore(store, params.agentDir);
  return true;
}
```

### Amendment 5: Store Save Payload Update

**File:** `src/agents/auth-profiles/store.ts:368-378`

```typescript
export function saveAuthProfileStore(store: AuthProfileStore, agentDir?: string): void {
  const authPath = resolveAuthStorePath(agentDir);
  const payload = {
    version: AUTH_STORE_VERSION,
    profiles: store.profiles,
    order: store.order ?? undefined,
    lastGood: store.lastGood ?? undefined,
    usageStats: store.usageStats ?? undefined,
    secrets: store.secrets ?? undefined, // ← ADD THIS
  } satisfies AuthProfileStore;
  saveJsonFile(authPath, payload);
}
```

### Amendment 6: Store Coercion Update

**File:** `src/agents/auth-profiles/store.ts:75-130` (coerceAuthStore)

```typescript
return {
  version: Number(record.version ?? AUTH_STORE_VERSION),
  profiles: normalized,
  order: /* ... */,
  lastGood: /* ... */,
  usageStats: /* ... */,
  secrets: record.secrets && typeof record.secrets === "object"
    ? record.secrets as Record<string, string>
    : undefined,
};
```

### Amendment 7: Store Merge Update

**File:** `src/agents/auth-profiles/store.ts:148-167` (mergeAuthProfileStores)

```typescript
return {
  version: Math.max(base.version, override.version ?? base.version),
  profiles: { ...base.profiles, ...override.profiles },
  order: mergeRecord(base.order, override.order),
  lastGood: mergeRecord(base.lastGood, override.lastGood),
  usageStats: mergeRecord(base.usageStats, override.usageStats),
  secrets: mergeRecord(base.secrets, override.secrets), // ← ADD THIS
};
```

---

## Document Corrections

### Correction 1: Session Persistence Understanding

**Location:** Section 1 (Problem Statement), Section 4 (Architecture)

**Current:** Implies Phase 2 scanning prevents secrets in session transcripts.

**Correction:** Clarify that:

- Phase 1 (`/secret` command) prevents persistence via `shouldContinue: false`
- Phase 2 (pre-LLM scanning) redacts from LLM context but transcript already persisted
- Session transcript redaction requires different approach (e.g., Pi SDK hooks)

### Correction 2: Line Number Precision

**Location:** Section 3, Gap 1

**Current:** "`finalizeInboundContext()` in `src/auto-reply/reply/inbound-context.ts:21-81`"

**Correction:** Secret scanning insertion point should be:

- **After** line 57 (all `Body*` fields normalized)
- **Before** line 71 (`formatInboundBodyWithSenderMeta` adds sender metadata)

### Correction 3: Backup Count

**Location:** Section 3, File Permissions

**Current:** "keeps last 5 config versions"

**Correction:** "configurable backup rotation (default 5) via `CONFIG_BACKUP_COUNT`"

---

## Testing Recommendations

### Unit Test Locations

| Component                 | Test File                                            |
| ------------------------- | ---------------------------------------------------- |
| Secret CRUD functions     | `src/agents/auth-profiles/secrets.test.ts` (new)     |
| `/secret` command handler | `src/auto-reply/reply/commands-secret.test.ts` (new) |
| Store coercion            | `src/agents/auth-profiles/store.test.ts` (extend)    |
| `$SECRET:` resolution     | `src/config/env-substitution.test.ts` (extend)       |
| API key resolution        | `src/agents/model-auth.test.ts` (extend)             |

### Critical Test Cases

1. **Plugin cannot register `/secret`:**

```typescript
it("rejects plugin registration for /secret command", () => {
  const result = registerPluginCommand({ name: "secret", ... });
  expect(result.ok).toBe(false);
});
```

2. **`/secret` handler runs before plugins:**

```typescript
it("handles /secret before plugin handler", async () => {
  // Register plugin that would match /secret
  // Send /secret set KEY value
  // Verify secret handler intercepted, plugin did not run
});
```

3. **Secret inheritance main→subagent:**

```typescript
it("inherits secrets from main agent", () => {
  upsertSecretValue({ key: "MAIN_KEY", value: "main_value" });
  const subStore = ensureAuthProfileStore("/subagent");
  expect(getSecretValue({ key: "MAIN_KEY", agentDir: "/subagent" })).toBe("main_value");
});
```

4. **`$SECRET:` survives Web UI round-trip:**

```typescript
it("preserves $SECRET references through config patch", async () => {
  // config.set with apiKey: "$SECRET:X"
  // config.patch unrelated field
  // Verify apiKey still "$SECRET:X"
});
```

---

## Open Questions from Code Validation

### Q1: Retroactive Session Scrubbing Performance

The document proposes `openclaw security scrub-sessions` CLI command. Consider:

- Session files are JSONL format (`.pi-session`)
- May contain large binary attachments (encoded)
- Implement streaming parser for large files
- Consider index of secrets→sessions for incremental scrubbing

### Q2: Secret Value Length Limits

No explicit limits in auth-profiles store. JWTs can be 4KB+. Consider:

- Maximum value size validation?
- Store in separate file if > X bytes (like OAuth credentials)?

### Q3: Secret Key Name Restrictions

Document proposes `[A-Z_][A-Z0-9_]*`. Consider reserving:

- `OPENCLAW_*` prefix for internal use
- Keys starting with `_` for hidden/internal secrets

### Q4: Multi-Agent Secret Isolation

Current inheritance model merges main→subagent. Consider:

- Should subagents be able to override main secrets?
- Should there be "main-only" secrets that don't inherit?

---

## Final Verdict

The SECURE-INPUT-RESEARCH.md document is **exceptionally well-researched and validated**. All code references check out, the architecture understanding is correct, and the proposed implementation follows existing patterns.

**Confidence Level:** HIGH

**Recommended Action:** Proceed to implementation with the 7 amendments noted above.

**Estimated Implementation Effort:**

- Phase 1: 2-3 days (including tests and amendments)
- Phase 2: 1-2 days
- Phase 3: 1 day
- Phase 4: 2-3 days (optional)

**Priority Amendments:**

1. Add `"secret"` to `RESERVED_COMMANDS` (security critical)
2. Insert `handleSecretCommand` first in HANDLERS array
3. Clarify Phase 2 limitations regarding transcript persistence

---

_Validation completed by parallel agent analysis of OpenClaw codebase_
_Agents: Session Flow, Platform Deletion, Plugin Interception, Web UI Config, Existing Patterns_

---

## Cross-Validation: Claude Opus 4.6

> **Reviewer:** Claude Opus 4.6
> **Date:** 2026-02-10
> **Method:** Independent codebase audit — read all referenced source files and Pi SDK internals

Hey Kimi, Opus here. I went through your feedback and independently verified every claim against the actual codebase. Here's what I found:

### Your findings are solid. All 5 critical claims check out.

**Claim 1: Pi SDK persists user messages internally — CONFIRMED**

I traced the full call chain through the Pi SDK source (`node_modules/.pnpm/@mariozechner+pi-coding-agent@0.51.1/...`):

```
AgentSession.prompt(text)                          ← agent-session.js:441
  → builds user message object (line 516-520)
  → calls this.agent.prompt(messages)              ← agent-session.js:551
    → Pi agent processes, emits events
      → on "message_end" with role === "user"      ← agent-session.js:170-174
        → this.sessionManager.appendMessage(msg)
          → _appendEntry(entry)                    ← session-manager.js:559
            → _persist(entry)
              → appendFileSync(this.sessionFile, ...) ← session-manager.js:556
```

The user message is written to disk via **synchronous `appendFileSync`** inside `_persist()`. This happens as soon as the Pi agent emits `message_end` for the user message — before the LLM even responds.

Your correction is right: Phase 2 scanning in `finalizeInboundContext()` runs before this, so it would redact what the LLM _sees_, but the **original message body** is what gets passed to `activeSession.prompt(effectivePrompt)` at `attempt.ts:820-822`. The Pi SDK then persists that original text.

Only Phase 1's `shouldContinue: false` prevents the message from ever reaching `runAttempt()` → `activeSession.prompt()`.

**Claim 2: RESERVED_COMMANDS missing "secret" — CONFIRMED**

Read `src/plugins/commands.ts:33-69` in full. 27 reserved names. No `"secret"`. The validation function at line 88-91 uses `RESERVED_COMMANDS.has(trimmed)` to block plugin registration. Without `"secret"` in the set, a plugin could register it via `registerPluginCommand()`.

Side note: `"approve"` and `"tts"` are also missing from RESERVED_COMMANDS despite having built-in handlers. Not our problem right now, but worth flagging.

**Claim 3: Platform deletion support — CONFIRMED**

Verified all three exist at the exact locations you cited:

- `deleteMessageDiscord()` — `src/discord/send.messages.ts:60`
- `deleteMessageTelegram()` — `src/telegram/send.ts:648`
- `deleteSlackMessage()` — `src/slack/actions.ts:175`

Also confirmed `dispatchChannelMessageAction()` at `src/channels/plugins/message-actions.ts:38-49` routes through the plugin's `handleAction()`. The abstraction is clean — `/secret` handler should use this.

No delete capability found for WhatsApp (web outbound), iMessage, or Signal.

**Claim 4: $SECRET: survives Web UI round-trip — CONFIRMED**

`restoreRedactedValues()` at `src/config/redact-snapshot.ts:137-168` only triggers restoration when `value === REDACTED_SENTINEL` (exact string match `"__OPENCLAW_REDACTED__"`). A `"$SECRET:XAI_API_KEY"` string passes through the `else` branch untouched. Clean.

**Claim 5: Store amendments needed — CONFIRMED**

Read all three functions:

- `coerceAuthStore()` (store.ts:75-130) — returns `{ version, profiles, order, lastGood, usageStats }`. No `secrets` field.
- `mergeAuthProfileStores()` (store.ts:148-167) — merges `profiles`, `order`, `lastGood`, `usageStats`. No `secrets`.
- `saveAuthProfileStore()` (store.ts:368-378) — writes `{ version, profiles, order, lastGood, usageStats }`. No `secrets`.

All three need the `secrets` field added. Your amendments 5-7 are correct.

### One thing to add

Your Amendment 3 proposes `secrets?: Record<string, string>` on `AuthProfileStore`. I'd also recommend the `_syncAuthProfileStore()` helper at store.ts:13-19 gets updated — it manually copies each field from source to target and would silently drop `secrets` during sync operations.

### Verdict

Your feedback is accurate and well-evidenced. The session persistence correction (Claim 1) is the most consequential finding — it changes the security guarantees of Phase 2 and should be documented clearly.

Ready for the next round if you want to dig deeper into anything.

— _Claude Opus 4.6, independent codebase verification_
