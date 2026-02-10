# Secure Secret Input for OpenClaw — Technical Research Document

> **Status:** Draft for SuperGrok review
> **Date:** 2026-02-10
> **Scope:** Pre-LLM secret interception, secure storage, and inbound message redaction

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Prior Art Analysis](#2-prior-art-analysis)
3. [OpenClaw Codebase Audit](#3-openclaw-codebase-audit)
4. [Proposed Architecture](#4-proposed-architecture)
5. [Implementation Plan](#5-implementation-plan)
6. [Security Threat Model](#6-security-threat-model)
7. [Open Questions for SuperGrok Review](#7-open-questions-for-supergrok-review)

---

## 1. Problem Statement

### How Secrets Leak Today

OpenClaw is a multi-channel personal AI assistant. Users interact via Telegram, Discord, Slack, WhatsApp, WebChat, and other surfaces. Configuration lives in `~/.openclaw/openclaw.json` (JSON5) and credentials in `~/.openclaw/credentials/auth-profiles.json`.

When a user configures a new model provider or service through the chat interface, secrets can leak through three vectors:

**Vector 1: LLM Conversation Context (Critical)**

```
User (Telegram): "Set my XAI API key to sk-ant-abc123def456..."
                    │
                    ▼
    dispatchInboundMessage()          ← src/auto-reply/dispatch.ts:17-32
        │
        ▼
    finalizeInboundContext()           ← src/auto-reply/reply/inbound-context.ts:21-81
        │                               Normalizes text, adds sender meta
        │                               NO secret scanning here
        ▼
    dispatchReplyFromConfig()          ← Message body sent to LLM as-is
        │
        ▼
    Anthropic/OpenAI API               ← Secret now in provider's logs
```

The raw user message (containing `sk-ant-abc123def456...`) is passed through `finalizeInboundContext()` which normalizes newlines and adds sender metadata, but performs **zero** secret scanning. The message reaches the LLM provider as conversation content.

**Vector 2: Session Transcripts (High)**

Session transcripts are persisted via `SessionManager.open(sessionFile)` (see `src/config/sessions/transcript.ts:111`). The `appendAssistantMessageToSessionTranscript` function writes JSONL entries to disk. User messages containing secrets are stored in the session file as plaintext.

**Vector 3: Payload Logs (Medium)**

When `OPENCLAW_ANTHROPIC_PAYLOAD_LOG=true`, full API request/response payloads are logged. User messages containing secrets end up in these logs.

### Real Attack Scenarios

1. **Casual key sharing:** User pastes an API key in chat to "set it up." The key is sent to the LLM provider, stored in session transcript, and potentially logged.
2. **Shoulder surfing:** Someone reads session files on a shared machine to extract API keys from chat history.
3. **Provider compromise:** If a model provider's conversation logs are breached, all secrets shared through chat are exposed.
4. **Tool output leakage:** A tool like `cat ~/.openclaw/credentials/auth-profiles.json` returns credentials as tool output. While `redactToolDetail()` catches common patterns, novel credential formats may slip through.

---

## 2. Prior Art Analysis

### Ghostty — OS-Level Secure Input

Ghostty (terminal emulator) uses macOS `EnableSecureEventInput()` to prevent other processes from reading keystrokes via the CGEventTap API. It shows a lock icon in the cursor when secure input is active.

**Relevance to OpenClaw:** Ghostty solves a different problem (inter-process keystroke sniffing). OpenClaw's challenge is intra-application: preventing a user's message from reaching the LLM pipeline. The insight is that secure input should be a **distinct mode** with clear visual feedback (lock icon = "your input is not going to the AI").

### 1Password CLI — URI-Based Secret References

1Password CLI uses `op://vault/item/field` URIs for runtime secret resolution:

```bash
export API_KEY="op://Development/XAI/credential"
op run -- my-command   # resolves at invocation time
```

**Relevance to OpenClaw:** The `op://` URI pattern maps directly to a proposed `$SECRET:KEY_NAME` config reference scheme. Secrets live in a separate store and are resolved at runtime. The user never writes the actual secret into the config file.

### age — Simple File Encryption

age (Actually Good Encryption) provides per-file encryption with X25519 keys:

```bash
age-keygen -o key.txt
age -r $(cat key.txt.pub) -o secrets.age secrets.json
age -d -i key.txt secrets.age
```

**Relevance to OpenClaw:** age is a strong candidate for encrypting the secrets section of `auth-profiles.json` at rest (Phase 4). Key advantages: no configuration, textual keys, SSH key support, well-audited.

### macOS Keychain Services

The system Keychain provides AES-256-GCM encryption, per-item ACLs, and biometric unlock. CLI tools like `envchain` bridge Keychain to environment variables.

**Relevance to OpenClaw:** Optional Phase 3 backend. Pro: OS-native security, biometric unlock. Con: macOS-only (Linux equivalent is libsecret/GNOME Keyring), adds native dependency.

### HashiCorp Vault

Path-based secret access, dynamic credentials, audit logging. Enterprise-grade but extremely heavy for single-user use.

**Relevance to OpenClaw:** Vault's path-based model (`secret/openclaw/xai-api-key`) is elegant but overkill. The auth-profiles store already provides equivalent functionality for a single-user assistant.

### SOPS (Secrets OPerationS)

Mozilla SOPS encrypts specific fields in YAML/JSON/ENV files, leaving structure visible but values encrypted. Supports multiple KMS backends (AWS KMS, GCP KMS, age, PGP).

**Relevance to OpenClaw:** SOPS could encrypt `openclaw.json` API key fields in-place. However, OpenClaw already has `${ENV_VAR}` substitution which achieves a similar goal (keep secrets out of the config file). SOPS adds value for git-committed configs in team deployments.

### Summary Matrix

| Tool           | Pattern                    | Applicable Phase      | Effort |
| -------------- | -------------------------- | --------------------- | ------ |
| Ghostty        | Distinct secure input mode | Phase 1 (conceptual)  | Low    |
| 1Password CLI  | URI-based secret refs      | Phase 3 (`$SECRET:*`) | Medium |
| age            | File encryption            | Phase 4 (at-rest)     | Medium |
| macOS Keychain | OS-native secure storage   | Phase 3 (optional)    | High   |
| Vault          | Path-based access          | N/A (too heavy)       | N/A    |
| SOPS           | Field-level encryption     | Phase 4 (alternative) | Medium |

---

## 3. OpenClaw Codebase Audit

### Existing Security Defenses

OpenClaw has solid **outbound** defenses. Here is what exists today:

#### Config Redaction — `src/config/redact-snapshot.ts`

```
redactConfigSnapshot(snapshot)
    ├── redactConfigObject()     Deep-walks parsed config, replaces values
    │                            where key matches SENSITIVE_KEY_PATTERNS:
    │                            /token/i, /password/i, /secret/i, /api.?key/i
    │                            → "__OPENCLAW_REDACTED__"
    │
    ├── redactRawText()          Replaces known sensitive VALUES in raw JSON5 string
    │                            (longest-first to avoid partial matches)
    │                            + regex key:value pattern matching
    │
    └── restoreRedactedValues()  Write-side: restores __OPENCLAW_REDACTED__ from
                                 original config on set/apply/patch (Web UI round-trip)
```

This prevents credential leakage through the **Web UI gateway**. The sentinel `__OPENCLAW_REDACTED__` is recognized by write handlers to preserve credentials through round-trips.

#### Log Redaction — `src/logging/redact.ts`

Pattern-based redaction of **tool output** before it enters conversation context:

```
DEFAULT_REDACT_PATTERNS (16 patterns):
  - ENV-style assignments: KEY=value, TOKEN=value, etc.
  - JSON fields: "apiKey": "...", "token": "...", etc.
  - CLI flags: --api-key value, --token value
  - Authorization headers: Bearer tokens
  - PEM blocks: -----BEGIN PRIVATE KEY-----
  - Token prefixes: sk-*, ghp_*, github_pat_*, xox[baprs]-*, xapp-*,
                    gsk_*, AIza*, pplx-*, npm_*, Telegram bot tokens
```

Redaction keeps first 6 and last 4 characters for tokens >= 18 chars (e.g., `sk-ant…f456`). PEM blocks show only BEGIN/END lines.

**Mode:** Controlled by `logging.redactSensitive` config (`"off"` or `"tools"`, default `"tools"`).

**Gap:** Only runs on tool output via `redactToolDetail()`. Does NOT scan user messages.

#### Secret Normalization — `src/utils/normalize-secret-input.ts`

```typescript
function normalizeSecretInput(value: unknown): string {
  // Strips \r\n\u2028\u2029 then trims
  return value.replace(/[\r\n\u2028\u2029]+/g, "").trim();
}
```

Called by `upsertAuthProfile()` (profiles.ts:54-62) and `requireApiKey()` (model-auth.ts:394). Prevents line-break corruption in pasted credentials.

#### File Permissions — `src/config/io.ts`

- Config directory created with `mode: 0o700` (io.ts:509)
- Config files written with `mode: 0o600` (io.ts:520-522)
- Atomic writes via temp file + rename (io.ts:514-550)
- Backup rotation: keeps last 5 config versions (io.ts:95-112)

#### Env Var Substitution — `src/config/env-substitution.ts`

```json5
{
  models: {
    providers: {
      xai: { apiKey: "${XAI_API_KEY}" },
    },
  },
}
```

Resolved at config load time. Only uppercase env vars matched: `[A-Z_][A-Z0-9_]*`. Missing vars throw `MissingEnvVarError` with context path. Escape with `$${}`.

**This is the current recommended path for keeping secrets out of the config file.** However, users must know to use it, and it doesn't help with secrets shared in chat.

#### detect-secrets — `.detect-secrets.cfg` + `.secrets.baseline`

Pre-commit scanning excludes `pnpm-lock.yaml`, `dist/`, `vendor/`, and known false positives (Fastlane private key checks, schema labels, CodingKeys mappings).

### Critical Gaps

#### Gap 1: No Pre-LLM User Message Scanning

The inbound pipeline (`finalizeInboundContext` in `src/auto-reply/reply/inbound-context.ts`) performs text normalization, chat type resolution, and sender meta formatting. It does NOT scan for secrets. The message body reaches the LLM as-is.

```
Message flow:
  Platform Adapter → finalizeInboundContext() → dispatchReplyFromConfig() → LLM API
                     ^^^^^^^^^^^^^^^^^^^^^^^^
                     NO secret scanning here
```

#### Gap 2: No Command-Level Secret Interception

The command handler chain (`src/auto-reply/reply/commands-core.ts:40-63`) processes 20+ built-in commands:

```typescript
HANDLERS = [
  handlePluginCommand, // Plugin commands first
  handleBashCommand,
  handleActivationCommand,
  handleSendPolicyCommand,
  handleUsageCommand,
  handleRestartCommand,
  handleTtsCommands,
  handleHelpCommand,
  // ... 12 more handlers
  handleAbortTrigger,
];
```

When a handler returns `{ shouldContinue: false }`, the pipeline stops — the message never reaches the LLM. This is the **exact interception point** for a `/secret` command. No such command exists today.

#### Gap 3: Session Transcripts Store Secrets in Plaintext

`appendAssistantMessageToSessionTranscript()` (transcript.ts:78-147) writes JSONL via `SessionManager`. User messages containing secrets are stored unredacted. No retroactive scrubbing exists.

#### Gap 4: No "Safe Channel" for Credential Setup

Users have three options to configure API keys:

1. Edit `openclaw.json` manually (requires file system access)
2. Use `${ENV_VAR}` substitution (requires shell knowledge)
3. Run `openclaw onboard` CLI wizard (not available from chat)

There is no chat-based way to securely provide credentials without them entering the LLM pipeline.

### Auth-Profiles Store — Existing Infrastructure

The auth-profiles store (`src/agents/auth-profiles/store.ts`) is the natural storage backend for a `/secret` command:

```
~/.openclaw/credentials/auth-profiles.json
{
  "version": 1,
  "profiles": {
    "anthropic:default": {
      "type": "oauth",
      "provider": "anthropic",
      "access": "...",
      "refresh": "...",
      "expires": 1234567890
    },
    "xai:default": {
      "type": "api_key",
      "provider": "xai",
      "key": "sk-..."
    }
  },
  "order": { ... },
  "lastGood": { ... },
  "usageStats": { ... }
}
```

Key features:

- **File locking** via `proper-lockfile` (`updateAuthProfileStoreWithLock`)
- **Main→subagent inheritance** (`ensureAuthProfileStore` merges main into subagent stores)
- **Legacy migration** (auto-migrates old auth.json format)
- **External CLI sync** (`syncExternalCliCredentials` imports from external tools)
- **Upsert API** (`upsertAuthProfile` with secret normalization)

The `AuthProfileStore` type has `profiles: Record<string, AuthProfileCredential>`. A new `secrets?: Record<string, string>` field could store generic key-value secrets without touching the existing profile infrastructure.

### Command Registry — Registration Point

Commands are defined in `src/auto-reply/commands-registry.data.ts` via `defineChatCommand()`:

```typescript
defineChatCommand({
  key: "secret",
  nativeName: "secret",
  description: "Manage secrets (keys, tokens) without exposing them to the AI.",
  textAlias: "/secret",
  category: "management",
  args: [
    { name: "action", type: "string", choices: ["set", "get", "list", "delete", "import-env"] },
    { name: "key", type: "string", description: "Secret name" },
    { name: "value", type: "string", captureRemaining: true },
  ],
});
```

Aliases registered via `registerAlias(commands, "secret", "/s")`.

### API Key Resolution — Integration Point

`resolveApiKeyForProvider()` in `src/agents/model-auth.ts:135-233` resolves API keys through a priority chain:

```
1. Explicit profileId → resolveApiKeyForProfile()
2. Auth override → aws-sdk check
3. Profile order → iterate auth-profiles by provider
4. Environment variable → resolveEnvApiKey()
5. Config apiKey field → getCustomProviderApiKey()
6. Error → throw with instructions
```

A `$SECRET:*` reference in the config's `apiKey` field would be resolved at step 5, before the error throw.

---

## 4. Proposed Architecture

### Core Concept: Pre-LLM Message Interception

```
User types: /secret set XAI_API_KEY sk-ant-abc123...
                │
                ▼
┌─────────────────────────────────┐
│  Platform Adapter               │  Telegram / Discord / Slack / Web UI
│  (receives raw message)         │
└──────────┬──────────────────────┘
           │
           ▼
┌─────────────────────────────────┐
│  handleCommands()               │  src/auto-reply/reply/commands-core.ts
│  HANDLERS array                 │
│                                 │
│  ┌──────────────────────────┐   │
│  │ handleSecretCommand  [0] │   │  ◄── NEW: First in handler chain
│  └──────────┬───────────────┘   │
│             │                   │
│  ┌──────────▼───────────────┐   │
│  │ 1. Parse /secret syntax  │   │
│  │ 2. Normalize value       │   │
│  │ 3. Store in auth-profiles│   │
│  │ 4. Delete platform msg   │   │
│  │    (best-effort)         │   │
│  │ 5. Reply: sanitized ack  │   │
│  └──────────┬───────────────┘   │
│             │                   │
│  return { shouldContinue:       │
│           false }               │  ◄── Pipeline stops here
└─────────────────────────────────┘
                │
                ▼  (message NEVER reaches LLM)
           ┌─────────┐
           │  Done.   │
           └─────────┘
```

### Secret Reference Resolution

```
openclaw.json:                         Runtime:
┌────────────────────────────────┐    ┌──────────────────────────────────┐
│ {                              │    │ resolveApiKeyForProvider()        │
│   models: {                    │    │                                  │
│     providers: {               │    │ 1. Check explicit profileId      │
│       xai: {                   │    │ 2. Check auth-profiles by order  │
│         apiKey:                │    │ 3. Check env vars                │
│  "$SECRET:XAI_API_KEY"  ──────│───▶│ 4. Check config apiKey field     │
│       }                        │    │    → detect $SECRET: prefix      │
│     }                          │    │    → resolve from secure store   │
│   }                            │    │ 5. Return plaintext key          │
│ }                              │    │    (never logged/sent to LLM)    │
└────────────────────────────────┘    └──────────────────────────────────┘
```

### Pre-LLM Inbound Message Scanning

```
                Message body
                    │
                    ▼
┌─────────────────────────────────┐
│  finalizeInboundContext()       │  src/auto-reply/reply/inbound-context.ts
│                                 │
│  Existing:                      │
│  - normalizeInboundTextNewlines │
│  - normalizeChatType            │
│  - formatInboundBodyWithSender  │
│                                 │
│  NEW:                           │
│  - scanForStoredSecrets()       │  ◄── Compare body against all stored
│    Body contains "sk-ant-abc"?  │      secret values
│    → Replace with              │
│    "[REDACTED: matches stored   │
│     secret XAI_API_KEY]"        │
└─────────────────────────────────┘
```

### Storage Backend Progression

```
Phase 1: Auth-Profiles Extension
  ~/.openclaw/credentials/auth-profiles.json
  {
    "version": 1,
    "profiles": { ... },              ← existing
    "secrets": {                       ← NEW namespace
      "XAI_API_KEY": "sk-...",
      "CUSTOM_TOKEN": "tok-..."
    }
  }
  ├── File locked (proper-lockfile)
  ├── 0o600 permissions (inherited)
  └── Main→subagent inheritance (existing)

Phase 2: Pre-LLM Scanning
  Stored secret values used as scanning corpus.
  collectSensitiveValues() extended to include secrets.

Phase 3: $SECRET:* Config References
  env-substitution.ts extended:
  - ${VAR} → env var lookup (existing)
  - $SECRET:KEY → auth-profiles secrets lookup (new)

Phase 4: Encrypted at Rest (Optional)
  ~/.openclaw/credentials/secrets.age
  ├── Encrypted with age (X25519)
  ├── Key: ~/.openclaw/credentials/secret-key.txt
  └── Decrypted only in-memory at runtime
```

---

## 5. Implementation Plan

### Phase 1: `/secret` Command + Auth-Profile Storage (MVP)

**Estimated scope:** 3 files new, 3 files modified

#### New Files

**`src/auto-reply/reply/commands-secret.ts`** — Command handler

```
Exports: handleSecretCommand(params, allowTextCommands) → CommandHandlerResult | null

Subcommands:
  /secret set <KEY> <VALUE>     → store, reply "Secret KEY stored (N chars)"
  /secret get <KEY>             → reply "KEY exists (N chars)" or "KEY not found"
  /secret list                  → reply "Stored secrets: KEY1, KEY2, ..."
  /secret delete <KEY>          → remove, reply "Secret KEY deleted"
  /secret import-env <VAR>      → read process.env[VAR], store, reply

Key behaviors:
  - Returns { shouldContinue: false } for all /secret subcommands
  - Uses upsertSecretValue() from profiles.ts for storage
  - Authorization: only from authorized senders (command.isAuthorizedSender)
  - Sanitized reply only (never echo the secret value back)
```

#### Modified Files

**`src/auto-reply/commands-registry.data.ts`**

Add `/secret` command definition with `/s` alias in the `buildChatCommands()` function. Category: `"management"`.

**`src/auto-reply/reply/commands-core.ts`**

Add `handleSecretCommand` as the **first** entry in the HANDLERS array (before `handlePluginCommand`). This ensures secrets are intercepted before any plugin can process the message.

```typescript
HANDLERS = [
  handleSecretCommand, // ← NEW: Intercept secrets before anything else
  handlePluginCommand,
  handleBashCommand,
  // ... rest unchanged
];
```

**`src/agents/auth-profiles/profiles.ts`**

Add functions for generic secret storage:

```typescript
export function upsertSecretValue(params: { key: string; value: string; agentDir?: string }): void;

export function getSecretValue(params: { key: string; agentDir?: string }): string | undefined;

export function listSecretKeys(agentDir?: string): string[];

export function deleteSecretValue(params: { key: string; agentDir?: string }): boolean;
```

**`src/agents/auth-profiles/types.ts`**

Extend `AuthProfileStore` with optional secrets field:

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

### Phase 2: Pre-LLM Message Scanning

**Estimated scope:** 2 files modified

**`src/auto-reply/reply/inbound-context.ts`**

Add secret scanning after text normalization in `finalizeInboundContext()`:

```typescript
// After existing normalization...
normalized.Body = redactStoredSecrets(normalized.Body);
normalized.BodyForAgent = redactStoredSecrets(normalized.BodyForAgent);
normalized.BodyForCommands = redactStoredSecrets(normalized.BodyForCommands);
```

`redactStoredSecrets()` loads all stored secret values and replaces matches:

```typescript
function redactStoredSecrets(text: string): string {
  const secrets = listSecretEntries(); // { key, value } pairs
  // Sort by value length descending (avoid partial matches)
  for (const { key, value } of secrets) {
    text = text.replaceAll(value, `[REDACTED: matches stored secret "${key}"]`);
  }
  return text;
}
```

**`src/config/redact-snapshot.ts`**

Extend `collectSensitiveValues()` to also include values from the secrets store. This ensures that if a stored secret appears anywhere in a config snapshot (e.g., hardcoded by accident), it is redacted.

### Phase 3: `$SECRET:*` Config References

**Estimated scope:** 2 files modified

**`src/config/env-substitution.ts`**

Extend `substituteString()` to recognize `$SECRET:KEY_NAME` syntax:

```
Current:  ${VAR_NAME}      → process.env[VAR_NAME]
New:      $SECRET:KEY_NAME → getSecretValue({ key: KEY_NAME })
```

The `$SECRET:` prefix is intentionally distinct from `${...}` to avoid ambiguity. No braces needed since secret names follow `[A-Z_][A-Z0-9_]*`.

**`src/agents/model-auth.ts`**

In `getCustomProviderApiKey()`, detect and resolve `$SECRET:` prefixed values before returning:

```typescript
export function getCustomProviderApiKey(cfg, provider): string | undefined {
  const entry = resolveProviderConfig(cfg, provider);
  const raw = entry?.apiKey;
  if (typeof raw === "string" && raw.startsWith("$SECRET:")) {
    const key = raw.slice("$SECRET:".length);
    return getSecretValue({ key }) ?? undefined;
  }
  return normalizeOptionalSecretInput(raw);
}
```

### Phase 4: Encrypted Storage Backend (Optional)

**Estimated scope:** 1 new file, 1 modified file

Add age-based encryption for the `secrets` section of auth-profiles:

- Key generation: `~/.openclaw/credentials/secret-key.txt` (X25519, generated on first `/secret set`)
- Encryption: secrets JSON → age-encrypted blob stored in `auth-profiles.json` as base64
- Decryption: transparent at read time, plaintext only in memory
- Dependency: `age-encryption` npm package (JS implementation) or shell out to `age` binary

---

## 6. Security Threat Model

| #   | Threat                                                      | Severity     | Phase    | Mitigation                                                                           |
| --- | ----------------------------------------------------------- | ------------ | -------- | ------------------------------------------------------------------------------------ |
| T1  | Secret in user chat message sent to LLM provider            | **Critical** | 1        | `/secret` command intercepts before LLM; `shouldContinue: false` stops pipeline      |
| T2  | Secret in user chat message persisted in session transcript | **High**     | 1        | Command handler returns before transcript append; message never enters session       |
| T3  | Secret in user chat message visible in payload logs         | **High**     | 1        | Command handler returns before payload serialization                                 |
| T4  | Secret accidentally pasted in normal chat (not /secret)     | **High**     | 2        | Pre-LLM scanning replaces known secret values with `[REDACTED]`                      |
| T5  | Secret in tool output (e.g., `cat auth-profiles.json`)      | **High**     | 2        | Extend `collectSensitiveValues()` to include stored secrets in redaction corpus      |
| T6  | Config file read by LLM via file-reading tool               | **Medium**   | Existing | `redactConfigSnapshot()` already replaces sensitive fields with sentinel             |
| T7  | Secret in `$SECRET:*` config reference leaks to LLM         | **Low**      | 3        | Reference resolved at runtime only; config file contains `$SECRET:KEY` not the value |
| T8  | Auth-profiles.json readable by attacker on disk             | **Medium**   | 1+4      | Phase 1: 0o600 permissions. Phase 4: age encryption at rest                          |
| T9  | Secret not zeroed in Node.js memory after use               | **Low**      | 4        | Use `Buffer.alloc()` + explicit `.fill(0)` for in-memory secret handling             |
| T10 | Platform message containing secret not deleted              | **Medium**   | 1        | Best-effort platform message deletion + user warning if deletion unsupported         |
| T11 | Old session transcripts contain pre-existing secrets        | **Medium**   | 2        | Retroactive scan-and-redact of `.pi-session` files for known secret values           |
| T12 | MITM on LLM API connections                                 | **Low**      | Existing | All provider APIs use HTTPS/TLS                                                      |
| T13 | Unauthorized sender uses /secret set to store junk          | **Low**      | 1        | `command.isAuthorizedSender` check required for all /secret subcommands              |
| T14 | Timing attack on secret scanning (value inference)          | **Very Low** | 2        | Constant-time comparison not needed; attacker cannot observe timing from chat        |
| T15 | Multi-agent secret isolation violation                      | **Low**      | 1        | Secrets follow existing main→subagent inheritance via `ensureAuthProfileStore()`     |

### Defense-in-Depth Layers

```
Layer 1: Command Interception (Phase 1)
  /secret command → message never reaches LLM
  First line of defense. Handles intentional secret input.

Layer 2: Inbound Scanning (Phase 2)
  Pre-LLM body scan → known secrets replaced with [REDACTED]
  Safety net for accidental secret inclusion in normal messages.

Layer 3: Tool Output Redaction (Existing + Phase 2 extension)
  redactToolDetail() + extended sensitive value corpus
  Catches secrets in tool results before they enter context.

Layer 4: Config Redaction (Existing)
  redactConfigSnapshot() → __OPENCLAW_REDACTED__
  Prevents credential leakage through Web UI gateway.

Layer 5: At-Rest Encryption (Phase 4)
  age encryption of secrets section
  Protects against disk-level attacks.
```

---

## 7. Open Questions for SuperGrok Review

### Q1: Platform Message Deletion Reliability

Discord and Slack support deleting bot-received messages via API. Telegram's `deleteMessage` requires bot admin in groups. WhatsApp and iMessage do not support programmatic message deletion.

**Proposed approach:** Best-effort deletion with clear user feedback:

- If deletion succeeds: "Secret stored. Original message deleted."
- If deletion fails/unsupported: "Secret stored. Warning: your message containing the secret could not be deleted from [platform]. Consider clearing your chat history."

**Question:** Is this sufficient, or should we block `/secret set` on platforms that don't support deletion?

### Q2: Retroactive Session Transcript Scrubbing

Existing `.pi-session` files may contain secrets from before the `/secret` command existed. Should we:

- (a) Scan and redact on startup (performance hit for large session dirs)?
- (b) Scan on first `/secret set` only?
- (c) Provide a manual `openclaw security scrub-sessions` CLI command?
- (d) Skip retroactive scrubbing entirely (document as known limitation)?

**Recommendation:** Option (c) — a manual CLI command avoids startup overhead and gives the user control.

### Q3: Multi-Agent Secret Inheritance

Auth profiles already merge `main → subagent` via `ensureAuthProfileStore()` (store.ts:351-366). The `secrets` field would naturally follow the same pattern since it's part of `AuthProfileStore`.

**Question:** Should there be a way to restrict certain secrets to the main agent only (e.g., master API keys that subagents shouldn't access)?

### Q4: Web UI Secret Input

The gateway Web UI already has `redactConfigSnapshot()`. Should we add a dedicated "Set Secret" UI element that:

- Accepts secret input in a password field
- Sends it via `config.patch` with a `$SECRET:` marker
- Never displays the value in the config editor

**Recommendation:** Yes, but as a Phase 3+ enhancement. The `/secret` command provides immediate value across all platforms.

### Q5: Environment Variable Deprecation

Should we actively recommend migrating from `${ENV_VAR}` to `$SECRET:KEY_NAME` for credentials?

**Recommendation:** Keep both as equal citizens. `${ENV_VAR}` is standard practice and works with external secret managers (1Password CLI, Doppler, etc.). `$SECRET:KEY_NAME` is for users who prefer chat-based setup or don't have a shell environment.

### Q6: Tool Sandboxing for Credential Files

Even with pre-LLM scanning, a tool could execute `cat ~/.openclaw/credentials/auth-profiles.json` and return credentials as tool output. The existing `redactToolDetail()` catches common patterns but may miss novel formats.

**Options:**

- (a) Add `~/.openclaw/credentials/` to a file access blocklist for tool execution
- (b) Rely on pattern-based redaction (existing + extended)
- (c) Both

**Recommendation:** Option (c). The security audit (`src/security/audit.ts`) already performs filesystem checks. Adding a credential directory access warning would be consistent.

### Q7: Rate Limiting for `/secret set`

Should `/secret set` have rate limiting to prevent storage spam from unauthorized senders?

**Analysis:** The `command.isAuthorizedSender` check already restricts `/secret` to authorized senders. Rate limiting adds complexity without meaningful security benefit for single-user deployment.

**Recommendation:** Skip rate limiting for Phase 1. The authorization check is sufficient.

---

## Appendix A: File Reference

| File                                       | Role                                            | Phase |
| ------------------------------------------ | ----------------------------------------------- | ----- |
| `src/auto-reply/reply/commands-secret.ts`  | NEW: `/secret` command handler                  | 1     |
| `src/auto-reply/commands-registry.data.ts` | Register `/secret` + `/s` alias                 | 1     |
| `src/auto-reply/reply/commands-core.ts`    | Add handler to HANDLERS array                   | 1     |
| `src/agents/auth-profiles/profiles.ts`     | Secret CRUD functions                           | 1     |
| `src/agents/auth-profiles/types.ts`        | `secrets` field on AuthProfileStore             | 1     |
| `src/agents/auth-profiles/store.ts`        | Store read/write (unchanged, secrets inherited) | 1     |
| `src/auto-reply/reply/inbound-context.ts`  | Pre-LLM secret scanning                         | 2     |
| `src/config/redact-snapshot.ts`            | Extended sensitive value collection             | 2     |
| `src/config/env-substitution.ts`           | `$SECRET:*` reference resolution                | 3     |
| `src/agents/model-auth.ts`                 | Resolve `$SECRET:*` in apiKey fields            | 3     |

## Appendix B: Command Syntax Reference

```
/secret set <KEY_NAME> <value>
  Store a secret. KEY_NAME must match [A-Z_][A-Z0-9_]*.
  Example: /secret set XAI_API_KEY sk-ant-abc123...

/secret get <KEY_NAME>
  Check if a secret exists. Never shows the value.
  Example: /secret get XAI_API_KEY
  → "XAI_API_KEY exists (44 chars, stored 2024-01-15)"

/secret list
  List all stored secret names. No values shown.
  → "Stored secrets: XAI_API_KEY, OPENROUTER_API_KEY, CUSTOM_TOKEN"

/secret delete <KEY_NAME>
  Remove a stored secret.
  Example: /secret delete XAI_API_KEY

/secret import-env <VAR_NAME>
  Import a secret from an environment variable.
  Example: /secret import-env ANTHROPIC_API_KEY

Aliases: /s set ..., /s list, etc.
```

## Appendix C: Verification Plan

1. **Unit tests** for `commands-secret.ts`:
   - Parse all subcommand syntaxes
   - Verify `shouldContinue: false` for all subcommands
   - Verify authorization check rejects unauthorized senders
   - Store/retrieve/delete round-trip

2. **Integration test**: send `/secret set TEST_KEY abc123` via test adapter
   - Verify message never reaches mock LLM
   - Verify secret stored in auth-profiles
   - Verify sanitized reply sent back

3. **Redaction test** (Phase 2): send normal message containing stored secret value
   - Verify LLM receives `[REDACTED: matches stored secret "TEST_KEY"]`
   - Verify session transcript contains redacted version

4. **Config reference test** (Phase 3): set `apiKey: "$SECRET:TEST_KEY"` in config
   - Verify `resolveApiKeyForProvider()` returns actual secret value
   - Verify config snapshot shows `$SECRET:TEST_KEY` (not the value)

5. **Message deletion test**: verify platform-specific deletion attempted
   - Discord: verify `deleteMessage` called
   - Telegram: verify `deleteMessage` called
   - Unsupported: verify warning message sent

6. **Manual test**: use Web UI + Telegram to set a secret
   - Verify it works for model auth
   - Verify secret not visible in session history
   - Verify secret not visible in Web UI config editor
