import { createHash, scrypt, timingSafeEqual } from "crypto";

export function editorAccount() {
  const username = process.env.EDITOR_USERNAME?.trim();
  const hash = process.env.EDITOR_PASSWORD_HASH || "";
  if (!username || username.length > 120 || !/^scrypt:131072:8:1:[a-f0-9]{64}:[a-f0-9]{128}$/.test(hash)) return null;
  return { username, hash, version: createHash("sha256").update(`${username}:${hash}`).digest("hex") };
}

export async function verifyEditorPassword(password: string, hash: string) {
  const parts = hash.split(":");
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, Buffer.from(parts[4], "hex"), 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result));
  });
  return timingSafeEqual(derived, Buffer.from(parts[5], "hex"));
}
