import { REST, Routes } from "discord.js";
import { loadConfig } from "@ccb/shared/config";
import { makeLogger } from "@ccb/shared/logger";
import { commands } from "./commands.js";

const log = makeLogger("discord-register");

/**
 * Push slash command definitions to Discord. Guild-scoped when DISCORD_GUILD_ID
 * is set (instant), otherwise global (up to ~1h to propagate). Idempotent — the
 * bot calls this on every boot so commands stay in sync with the code.
 */
export async function registerCommands(): Promise<void> {
  const cfg = loadConfig();
  const { token, clientId, guildId } = cfg.discord;
  if (!token || !clientId) {
    throw new Error("DISCORD_TOKEN and DISCORD_CLIENT_ID must be set.");
  }

  const rest = new REST({ version: "10" }).setToken(token);
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    log.info({ count: commands.length, guildId }, "registered guild commands");
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    log.info({ count: commands.length }, "registered global commands");
  }
}

// CLI entry: `bun run src/register-commands.ts`
if (import.meta.main) {
  registerCommands()
    .then(() => {
      console.log("Commands registered.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Failed to register commands:", err);
      process.exit(1);
    });
}
