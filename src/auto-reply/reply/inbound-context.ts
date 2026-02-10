import type { FinalizedMsgContext, MsgContext } from "../templating.js";
import { listSecretKeys, getSecretValue } from "../../agents/auth-profiles/profiles.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveConversationLabel } from "../../channels/conversation-label.js";
import { formatInboundBodyWithSenderMeta } from "./inbound-sender-meta.js";
import { normalizeInboundTextNewlines } from "./inbound-text.js";

export type FinalizeInboundContextOptions = {
  forceBodyForAgent?: boolean;
  forceBodyForCommands?: boolean;
  forceChatType?: boolean;
  forceConversationLabel?: boolean;
};

function normalizeTextField(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return normalizeInboundTextNewlines(value);
}

/**
 * Redact stored secret values from inbound text before it reaches the LLM.
 *
 * IMPORTANT: This runs BEFORE the LLM sees the text, but the Pi SDK persists
 * the ORIGINAL user message to session transcripts via session.prompt().
 * Phase 2 protects the LLM context, but only Phase 1 (/secret command) prevents
 * secret persistence in transcripts.
 */
function redactStoredSecrets(text: string): string {
  if (!text) {
    return text;
  }
  const keys = listSecretKeys();
  if (keys.length === 0) {
    return text;
  }

  // Collect key-value pairs, sort by value length DESC to avoid partial matches
  const entries = keys
    .map((key) => ({ key, value: getSecretValue({ key })! }))
    .filter((e) => e.value && e.value.length >= 4) // skip very short values to avoid false positives
    .toSorted((a, b) => b.value.length - a.value.length);

  let result = text;
  for (const { key, value } of entries) {
    result = result.replaceAll(value, '[REDACTED: stored secret "' + key + '"]');
  }
  return result;
}

export function finalizeInboundContext<T extends Record<string, unknown>>(
  ctx: T,
  opts: FinalizeInboundContextOptions = {},
): T & FinalizedMsgContext {
  const normalized = ctx as T & MsgContext;

  normalized.Body = normalizeInboundTextNewlines(
    typeof normalized.Body === "string" ? normalized.Body : "",
  );
  normalized.RawBody = normalizeTextField(normalized.RawBody);
  normalized.CommandBody = normalizeTextField(normalized.CommandBody);
  normalized.Transcript = normalizeTextField(normalized.Transcript);
  normalized.ThreadStarterBody = normalizeTextField(normalized.ThreadStarterBody);
  if (Array.isArray(normalized.UntrustedContext)) {
    const normalizedUntrusted = normalized.UntrustedContext.map((entry) =>
      normalizeInboundTextNewlines(entry),
    ).filter((entry) => Boolean(entry));
    normalized.UntrustedContext = normalizedUntrusted;
  }

  const chatType = normalizeChatType(normalized.ChatType);
  if (chatType && (opts.forceChatType || normalized.ChatType !== chatType)) {
    normalized.ChatType = chatType;
  }

  const bodyForAgentSource = opts.forceBodyForAgent
    ? normalized.Body
    : (normalized.BodyForAgent ?? normalized.Body);
  normalized.BodyForAgent = normalizeInboundTextNewlines(bodyForAgentSource);

  const bodyForCommandsSource = opts.forceBodyForCommands
    ? (normalized.CommandBody ?? normalized.RawBody ?? normalized.Body)
    : (normalized.BodyForCommands ??
      normalized.CommandBody ??
      normalized.RawBody ??
      normalized.Body);
  normalized.BodyForCommands = normalizeInboundTextNewlines(bodyForCommandsSource);

  // Redact stored secrets from inbound text before it reaches the LLM
  // NOTE: This protects the LLM context but NOT session transcripts (Pi SDK persists original)
  normalized.Body = redactStoredSecrets(normalized.Body);
  normalized.BodyForAgent = redactStoredSecrets(normalized.BodyForAgent);
  normalized.BodyForCommands = redactStoredSecrets(normalized.BodyForCommands);
  if (normalized.RawBody) {
    normalized.RawBody = redactStoredSecrets(normalized.RawBody);
  }
  if (normalized.CommandBody) {
    normalized.CommandBody = redactStoredSecrets(normalized.CommandBody);
  }

  const explicitLabel = normalized.ConversationLabel?.trim();
  if (opts.forceConversationLabel || !explicitLabel) {
    const resolved = resolveConversationLabel(normalized)?.trim();
    if (resolved) {
      normalized.ConversationLabel = resolved;
    }
  } else {
    normalized.ConversationLabel = explicitLabel;
  }

  // Ensure group/channel messages retain a sender meta line even when the body is a
  // structured envelope (e.g. "[Signal ...] Alice: hi").
  normalized.Body = formatInboundBodyWithSenderMeta({ ctx: normalized, body: normalized.Body });
  normalized.BodyForAgent = formatInboundBodyWithSenderMeta({
    ctx: normalized,
    body: normalized.BodyForAgent,
  });

  // Always set. Default-deny when upstream forgets to populate it.
  normalized.CommandAuthorized = normalized.CommandAuthorized === true;

  return normalized as T & FinalizedMsgContext;
}
