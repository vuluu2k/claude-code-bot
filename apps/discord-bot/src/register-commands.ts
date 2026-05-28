import { REST, Routes } from "discord.js";
import { loadConfig } from "@ccb/shared/config";
import { commands } from "./commands.js";

async function main() {
  const cfg = loadConfig();
  const { token, clientId, guildId } = cfg.discord;

  if (!token || !clientId) {
    console.error("DISCORD_TOKEN and DISCORD_CLIENT_ID must be set.");
    process.exit(1);
  }

  const rest = new REST({ version: "10" }).setToken(token);

  if (guildId) {
    console.log(`Registering ${commands.length} guild commands → guild ${guildId}`);
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  } else {
    console.log(`Registering ${commands.length} global commands (may take up to 1 hour to propagate)`);
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
  }
  console.log("Commands registered.");
}

main().catch((err) => {
  console.error("Failed to register commands:", err);
  process.exit(1);
});
