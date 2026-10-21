// Read {username, password} as JSON from stdin; never print or persist the password.
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes, scryptSync } from "node:crypto";

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 4096) throw new Error("Input too large");
}
const { username, password } = JSON.parse(input);
if (typeof username !== "string" || !/^[a-zA-Z0-9_.-]{1,120}$/.test(username) || typeof password !== "string" || password.length < 12 || password.length > 256) throw new Error("Use a valid username and a password of 12–256 characters");
const salt = randomBytes(32);
const hash = scryptSync(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
const encoded = `scrypt:131072:8:1:${salt.toString("hex")}:${hash.toString("hex")}`;
const target = new URL("../../../.env", import.meta.url);
let env = await readFile(target, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
env = env.replace(/^(?:EDITOR_USERNAME|EDITOR_PASSWORD_HASH|DEMO_LOGIN_ENABLED|DEMO_USERNAME|DEMO_PASSWORD)=.*(?:\r?\n|$)/gm, "");
await writeFile(target, `${env.trimEnd()}\nEDITOR_USERNAME=${username}\nEDITOR_PASSWORD_HASH=${encoded}\n`, { mode: 0o600 });
console.log("Editor account configured in the private .env file. Recreate the web container to apply it.");
