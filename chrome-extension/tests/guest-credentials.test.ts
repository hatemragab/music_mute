import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MacGuestCredentialStore,
  validGuestCredential,
} from "../src/companion/guest-credentials.js";

const directories: string[] = [];
const credential = {
  token: "a".repeat(64),
  expires_at: "2099-10-04T12:00:00.000Z",
};
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture(script: string) {
  const path = await mkdtemp(join(tmpdir(), "musicmute-guest-vault-"));
  directories.push(path);
  const directory = join(path, "Contents", "MacOS");
  await mkdir(directory, { recursive: true });
  const helper = join(directory, "MusicMuteGuestCredentials");
  await writeFile(helper, `#!${process.execPath}\n${script}\n`, {
    mode: 0o700,
  });
  await chmod(helper, 0o700);
  return new MacGuestCredentialStore({
    app_resources: join(path, "Contents", "Resources"),
  });
}
describe("guest credential vault", () => {
  it("moves the credential through stdin, never process arguments", async () => {
    const store = await fixture(`
      let input = ''; for await (const chunk of process.stdin) input += chunk;
      if (process.argv.length !== 2) process.exit(1);
      const command = JSON.parse(input);
      if (command.operation === 'save') {
        if (command.credential.token !== '${credential.token}') process.exit(1);
        process.stdout.write('null');
      } else process.stdout.write('${JSON.stringify(credential)}');
    `);
    await store.save(credential);
    expect(await store.load()).toEqual(credential);
  });
  it("contains native errors and rejects oversized credential output", async () => {
    const failed = await fixture(
      "process.stderr.write('synthetic-private-token'); process.exit(1);",
    );
    await expect(failed.load()).rejects.toThrow(
      /^GUEST_CREDENTIALS_UNAVAILABLE$/,
    );
    const oversized = await fixture("process.stdout.write('x'.repeat(4097));");
    await expect(oversized.load()).rejects.toThrow(
      /^GUEST_CREDENTIALS_UNAVAILABLE$/,
    );
  });
  it("rejects trailing control characters and unexpected credential fields", () => {
    expect(validGuestCredential(credential)).toBe(true);
    expect(
      validGuestCredential({ ...credential, token: credential.token + "\n" }),
    ).toBe(false);
    expect(
      validGuestCredential({ ...credential, bearer: credential.token }),
    ).toBe(false);
    expect(validGuestCredential({ ...credential, expires_at: "invalid" })).toBe(
      false,
    );
  });
});
