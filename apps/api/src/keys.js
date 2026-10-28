#!/usr/bin/env node
// Manage MundusX API keys: node keys.js create <USERID> | list | revoke <id>

const { create, revoke, load, KEYS_FILE } = require("./keys-store");

const [command, argument] = process.argv.slice(2);

if (command === "create" && argument) {
  try {
    const { key, entry } = create(argument);
    console.log(
      `Key for ${entry.user} (id ${entry.id}) — shown only now:\n\n  ${key}\n`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
} else if (command === "list") {
  const keys = load();
  if (!keys.length) console.log(`No keys yet (${KEYS_FILE}).`);
  for (const key of keys) {
    console.log(
      `${key.id}  ${key.revoked ? "revoked" : "active "}  ${key.created.slice(0, 10)}  ${key.user}`,
    );
  }
} else if (command === "revoke" && argument) {
  console.log(
    revoke(argument)
      ? `Key ${argument} revoked.`
      : `No key with id ${argument}.`,
  );
  if (!load().some((key) => key.id === argument)) process.exitCode = 1;
} else {
  console.log("usage: node keys.js create <USERID> | list | revoke <id>");
  process.exitCode = 2;
}
