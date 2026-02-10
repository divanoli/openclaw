/**
 * Secure Secret Command Handler
 *
 * Intercepts /secret commands BEFORE the LLM pipeline.
 * Secrets are stored in auth-profiles and never reach conversation context.
 */

import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";
import {
  upsertSecretValue,
  getSecretValue,
  listSecretKeys,
  deleteSecretValue,
} from "../../agents/auth-profiles/profiles.js";
import { logVerbose } from "../../globals.js";
import { runMessageAction } from "../../infra/outbound/message-action-runner.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";

function parseSecretCommand(body: string): {
  subcommand: string;
  args: string[];
  raw: string;
} | null {
  const trimmed = body.trim();
  const lower = trimmed.toLowerCase();

  // Match "/secret ..." or exactly "/s" or "/s <subcommand>"
  // Must NOT match /status, /stop, /subagents, etc.
  if (!lower.startsWith("/secret") && lower !== "/s" && !lower.startsWith("/s ")) {
    return null;
  }

  // Re-parse from original (not lowered) body to preserve value casing
  const parts = trimmed.split(/\s+/);
  const command = parts[0]!.toLowerCase();
  if (command !== "/secret" && command !== "/s") {
    return null;
  }

  const subcommand = (parts[1] ?? "").toLowerCase();
  const args = parts.slice(2);

  return { subcommand, args, raw: trimmed };
}

export const handleSecretCommand: CommandHandler = async (
  params,
  allowTextCommands,
): Promise<CommandHandlerResult | null> => {
  if (!allowTextCommands) {
    return null;
  }

  const parsed = parseSecretCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }

  // Always intercept — never let /secret reach the LLM
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /secret from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false, reply: { text: "⚠️ This command requires authorization." } };
  }

  const { subcommand, args } = parsed;

  // Best-effort delete the original message (it may contain the secret value)
  if (subcommand === "set" || subcommand === "import-env") {
    const messageId = params.ctx.MessageSid ?? params.ctx.MessageSidFull;
    if (messageId) {
      runMessageAction({
        cfg: params.cfg,
        action: "delete",
        params: { messageId },
        sessionKey: params.sessionKey,
        agentId: params.agentId,
      }).catch(() => {
        logVerbose(`Best-effort message deletion failed for ${messageId}`);
      });
    }
  }

  switch (subcommand) {
    case "set": {
      const keyName = args[0];
      // Value is everything after the key (preserves spaces in "Bearer xyz" style values)
      const valueMatch = params.command.commandBodyNormalized.match(
        /\/s(?:ecret)?\s+set\s+\S+\s+([\s\S]+)/i,
      );
      const value = valueMatch?.[1];

      if (!keyName || !value) {
        return {
          shouldContinue: false,
          reply: { text: "Usage: /secret set <KEY_NAME> <value>" },
        };
      }

      const upperKey = keyName.toUpperCase();
      const result = await upsertSecretValue({ key: upperKey, value });
      if (!result.ok) {
        return { shouldContinue: false, reply: { text: `⚠️ ${result.error}` } };
      }

      const charCount = normalizeSecretInput(value).length;
      return {
        shouldContinue: false,
        reply: { text: `🔐 Secret ${upperKey} stored (${charCount} chars)` },
      };
    }

    case "get": {
      const keyName = args[0];
      if (!keyName) {
        return { shouldContinue: false, reply: { text: "Usage: /secret get <KEY_NAME>" } };
      }
      const upperKey = keyName.toUpperCase();
      const val = getSecretValue({ key: upperKey });
      if (!val) {
        return {
          shouldContinue: false,
          reply: { text: `Secret ${upperKey} not found.` },
        };
      }
      return {
        shouldContinue: false,
        reply: { text: `🔐 ${upperKey} exists (${val.length} chars)` },
      };
    }

    case "list": {
      const keys = listSecretKeys();
      if (keys.length === 0) {
        return { shouldContinue: false, reply: { text: "No secrets stored." } };
      }
      const list = keys.map((k) => `• ${k}`).join("\n");
      return {
        shouldContinue: false,
        reply: { text: `🔐 Stored secrets:\n${list}` },
      };
    }

    case "delete": {
      const keyName = args[0];
      if (!keyName) {
        return { shouldContinue: false, reply: { text: "Usage: /secret delete <KEY_NAME>" } };
      }
      const upperKey = keyName.toUpperCase();
      const result = await deleteSecretValue({ key: upperKey });
      if (!result.existed) {
        return {
          shouldContinue: false,
          reply: { text: `Secret ${upperKey} not found.` },
        };
      }
      return {
        shouldContinue: false,
        reply: { text: `🔐 Secret ${upperKey} deleted.` },
      };
    }

    case "import-env": {
      const varName = args[0];
      if (!varName) {
        return {
          shouldContinue: false,
          reply: { text: "Usage: /secret import-env <VAR_NAME>" },
        };
      }
      const envValue = process.env[varName] ?? process.env[varName.toUpperCase()];
      if (!envValue) {
        return {
          shouldContinue: false,
          reply: { text: `⚠️ Environment variable ${varName} not found.` },
        };
      }
      const upperKey = varName.toUpperCase();
      const result = await upsertSecretValue({ key: upperKey, value: envValue });
      if (!result.ok) {
        return { shouldContinue: false, reply: { text: `⚠️ ${result.error}` } };
      }
      return {
        shouldContinue: false,
        reply: {
          text: `🔐 Imported ${upperKey} from env (${envValue.length} chars)`,
        },
      };
    }

    default: {
      return {
        shouldContinue: false,
        reply: {
          text: "Usage: /secret <set|get|list|delete|import-env> [KEY] [value]\nAlias: /s",
        },
      };
    }
  }
};
