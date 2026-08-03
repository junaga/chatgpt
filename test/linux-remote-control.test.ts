import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const deviceKeys = require("../desktop/linux-runtime/remote-control-device-key.cjs");

function protectedStorage() {
  return {
    getSelectedStorageBackend: () => "secret_service",
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  };
}

test("Linux remote-control keys persist, sign with P-256, and delete", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chatgpt-device-key-test-"));
  const storagePath = path.join(directory, "keys.json");
  try {
    const first = deviceKeys.createDeviceKeyStore({ safeStorage: protectedStorage(), storagePath });
    const created = await first.createDeviceKey("allow_os_protected_nonextractable");
    assert.equal(created.algorithm, "ecdsa_p256_sha256");
    assert.equal(created.protectionClass, "os_protected_nonextractable");

    const second = deviceKeys.createDeviceKeyStore({ safeStorage: protectedStorage(), storagePath });
    assert.deepEqual(await second.getDeviceKeyPublic(created.keyId), created);
    const payload = Buffer.from("codex-device-key-sign-payload/v1 test", "utf8");
    const signed = await second.signDeviceKey(created.keyId, payload);
    const publicKey = crypto.createPublicKey({ key: Buffer.from(created.publicKeySpkiDerBase64, "base64"), format: "der", type: "spki" });
    assert.equal(crypto.verify("sha256", payload, publicKey, Buffer.from(signed.signatureDerBase64, "base64")), true);

    const onDisk = await readFile(storagePath, "utf8");
    assert.doesNotMatch(onDisk, /PRIVATE KEY/);
    assert.equal((await stat(storagePath)).mode & 0o777, 0o600);
    await assert.rejects(second.signDeviceKey("../not-a-key", payload), /Invalid/);
    await assert.rejects(second.signDeviceKey(created.keyId, "not bytes"), /must be bytes/);
    assert.equal(await second.deleteDeviceKey(created.keyId), true);
    await assert.rejects(second.getDeviceKeyPublic(created.keyId), /not found/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux remote control refuses Electron basic_text and hardware-only claims", async () => {
  const store = deviceKeys.createDeviceKeyStore({
    safeStorage: { ...protectedStorage(), getSelectedStorageBackend: () => "basic_text" },
    storagePath: "/unused/device-keys.json",
  });
  await assert.rejects(store.createDeviceKey("allow_os_protected_nonextractable"), /basic_text/);

  const protectedStore = deviceKeys.createDeviceKeyStore({ safeStorage: protectedStorage(), storagePath: "/unused/device-keys.json" });
  await assert.rejects(protectedStore.createDeviceKey("hardware_only"), /hardware-backed/);
});

test("Linux remote control rejects corrupt public-key metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chatgpt-device-key-corrupt-"));
  const storagePath = path.join(directory, "keys.json");
  try {
    const store = deviceKeys.createDeviceKeyStore({ safeStorage: protectedStorage(), storagePath });
    const created = await store.createDeviceKey("allow_os_protected_nonextractable");
    const contents = JSON.parse(await readFile(storagePath, "utf8"));
    contents.keys[created.keyId].algorithm = "not-the-enrollment-algorithm";
    await writeFile(storagePath, JSON.stringify(contents), { mode: 0o600 });
    await assert.rejects(store.getDeviceKeyPublic(created.keyId), /corrupt/);
    await assert.rejects(store.signDeviceKey(created.keyId, Buffer.from("payload")), /corrupt/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the pinned upstream provider is patched only at its Linux guard", () => {
  const guard = "if(process.platform!==`darwin`)throw Error(`Remote control device keys are only available on macOS`);if(this.resourcesPath==null)";
  const patched = deviceKeys.enableLinuxRemoteControlDeviceKeys(`before ${guard} after`);
  assert.match(patched, /process\.platform===`linux`/);
  assert.match(patched, /linux-runtime.*remote-control-device-key\.cjs/);
  assert.throws(() => deviceKeys.enableLinuxRemoteControlDeviceKeys("no guard"), /exactly one/);
  assert.throws(() => deviceKeys.enableLinuxRemoteControlDeviceKeys(`${guard}${guard}`), /exactly one/);
});

test("the shared main-bundle loader composes remote-control enrollment support", async () => {
  const patcher = await readFile(
    new URL("../desktop/linux-runtime/main-bundle-patches.cjs", import.meta.url),
    "utf8",
  );
  assert.match(patcher, /enableLinuxRemoteControlDeviceKeys/);
  assert.match(patcher, /enableLinuxRemoteControlDeviceKeys\(enableLinuxSystemPermissions\(source\)\)/);
});
