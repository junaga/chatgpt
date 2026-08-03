const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const ALGORITHM = "ecdsa_p256_sha256";
const PROTECTION_CLASS = "os_protected_nonextractable";
const LINUX_DEVICE_KEY_GUARD =
  "if(process.platform!==`darwin`)throw Error(`Remote control device keys are only available on macOS`);if(this.resourcesPath==null)";
const LINUX_DEVICE_KEY_REPLACEMENT =
  "if(process.platform===`linux`){if(this.resourcesPath==null)throw Error(`Remote control device keys require resourcesPath`);return this.addon??=Nhe((0,p.join)(this.resourcesPath,`linux-runtime`,`remote-control-device-key.cjs`)),this.addon}if(process.platform!==`darwin`)throw Error(`Remote control device keys are only available on macOS`);if(this.resourcesPath==null)";

function enableLinuxRemoteControlDeviceKeys(source) {
  const first = source.indexOf(LINUX_DEVICE_KEY_GUARD);
  if (first === -1 || source.indexOf(LINUX_DEVICE_KEY_GUARD, first + 1) !== -1) {
    throw new Error("Expected exactly one upstream remote-control device-key guard");
  }
  return source.replace(LINUX_DEVICE_KEY_GUARD, LINUX_DEVICE_KEY_REPLACEMENT);
}

function assertKeyId(keyId) {
  if (typeof keyId !== "string" || !/^[a-f0-9]{32}$/u.test(keyId)) {
    throw new Error("Invalid remote-control device key ID");
  }
}

function decodeBase64(value, label) {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error(`Remote-control device key store has invalid ${label}`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`Remote-control device key store has invalid ${label}`);
  }
  return decoded;
}

function publicRecord(keyId, record) {
  if (
    typeof record !== "object" ||
    record == null ||
    record.algorithm !== ALGORITHM ||
    record.protectionClass !== PROTECTION_CLASS
  ) {
    throw new Error("Remote-control device key store is corrupt");
  }
  const publicKey = crypto.createPublicKey({
    key: decodeBase64(record.publicKeySpkiDerBase64, "public key"),
    format: "der",
    type: "spki",
  });
  if (
    publicKey.asymmetricKeyType !== "ec" ||
    publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new Error("Remote-control device key store does not contain a P-256 public key");
  }
  return {
    keyId,
    publicKeySpkiDerBase64: record.publicKeySpkiDerBase64,
    algorithm: ALGORITHM,
    protectionClass: PROTECTION_CLASS,
  };
}

function createDeviceKeyStore({ safeStorage, storagePath }) {
  let transaction = Promise.resolve();

  function requireProtectedStorage() {
    const backend = safeStorage.getSelectedStorageBackend?.();
    if (!safeStorage.isEncryptionAvailable?.() || backend === "basic_text") {
      throw new Error("Remote control needs an unlocked Linux Secret Service or KWallet; Electron basic_text storage is refused");
    }
  }

  async function readStore() {
    try {
      const parsed = JSON.parse(await fs.readFile(storagePath, "utf8"));
      if (parsed?.version !== 1 || typeof parsed.keys !== "object" || parsed.keys == null || Array.isArray(parsed.keys)) {
        throw new Error("Remote-control device key store is corrupt");
      }
      return parsed;
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 1, keys: {} };
      throw error;
    }
  }

  async function writeStore(store) {
    const directory = path.dirname(storagePath);
    const temporary = path.join(directory, `.${path.basename(storagePath)}.${crypto.randomUUID()}.tmp`);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(temporary, `${JSON.stringify(store)}\n`, { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, storagePath);
      await fs.chmod(storagePath, 0o600);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  function exclusive(operation) {
    const result = transaction.then(operation);
    transaction = result.then(() => undefined, () => undefined);
    return result;
  }

  async function privateKey(keyId) {
    requireProtectedStorage();
    assertKeyId(keyId);
    const record = (await readStore()).keys[keyId];
    if (!record) throw new Error("Remote-control device key was not found");
    publicRecord(keyId, record);
    let privateKeyPkcs8Der;
    try {
      const encryptedPrivateKey = decodeBase64(record.encryptedPrivateKeyBase64, "encrypted private key");
      privateKeyPkcs8Der = Buffer.from(safeStorage.decryptString(encryptedPrivateKey), "base64");
      return crypto.createPrivateKey({ key: privateKeyPkcs8Der, format: "der", type: "pkcs8" });
    } catch (error) {
      throw new Error("Remote-control device key could not be unlocked", { cause: error });
    } finally {
      privateKeyPkcs8Der?.fill(0);
    }
  }

  return Object.freeze({
    async createDeviceKey(policy = "hardware_only") {
      requireProtectedStorage();
      if (policy !== "allow_os_protected_nonextractable") {
        throw new Error("Linux does not have a configured hardware-backed remote-control key provider");
      }
      return await exclusive(async () => {
        const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
        const keyId = crypto.randomBytes(16).toString("hex");
        const publicKeySpkiDer = publicKey.export({ format: "der", type: "spki" });
        const privateKeyPkcs8Der = privateKey.export({ format: "der", type: "pkcs8" });
        let encryptedPrivateKey;
        try {
          encryptedPrivateKey = safeStorage.encryptString(privateKeyPkcs8Der.toString("base64"));
        } finally {
          privateKeyPkcs8Der.fill(0);
        }
        const store = await readStore();
        store.keys[keyId] = {
          algorithm: ALGORITHM,
          protectionClass: PROTECTION_CLASS,
          publicKeySpkiDerBase64: publicKeySpkiDer.toString("base64"),
          encryptedPrivateKeyBase64: encryptedPrivateKey.toString("base64"),
        };
        await writeStore(store);
        return {
          keyId,
          publicKeySpkiDerBase64: publicKeySpkiDer.toString("base64"),
          algorithm: ALGORITHM,
          protectionClass: PROTECTION_CLASS,
        };
      });
    },

    async deleteDeviceKey(keyId) {
      assertKeyId(keyId);
      return await exclusive(async () => {
        const store = await readStore();
        if (!store.keys[keyId]) return false;
        delete store.keys[keyId];
        await writeStore(store);
        return true;
      });
    },

    async getDeviceKeyPublic(keyId) {
      requireProtectedStorage();
      assertKeyId(keyId);
      const record = (await readStore()).keys[keyId];
      if (!record) throw new Error("Remote-control device key was not found");
      return publicRecord(keyId, record);
    },

    async signDeviceKey(keyId, payload) {
      if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)) {
        throw new Error("Remote-control signing payload must be bytes");
      }
      const signature = crypto.sign("sha256", Buffer.from(payload), {
        key: await privateKey(keyId),
        dsaEncoding: "der",
      });
      return { signatureDerBase64: signature.toString("base64"), algorithm: ALGORITHM };
    },
  });
}

let defaultStore;
function getDefaultStore() {
  if (!defaultStore) {
    const { app, safeStorage } = require("electron");
    defaultStore = createDeviceKeyStore({
      safeStorage,
      storagePath: path.join(app.getPath("userData"), "remote-control-device-keys.json"),
    });
  }
  return defaultStore;
}

module.exports = {
  ALGORITHM,
  PROTECTION_CLASS,
  createDeviceKey: (...args) => getDefaultStore().createDeviceKey(...args),
  createDeviceKeyStore,
  deleteDeviceKey: (...args) => getDefaultStore().deleteDeviceKey(...args),
  enableLinuxRemoteControlDeviceKeys,
  getDeviceKeyPublic: (...args) => getDefaultStore().getDeviceKeyPublic(...args),
  signDeviceKey: (...args) => getDefaultStore().signDeviceKey(...args),
};
