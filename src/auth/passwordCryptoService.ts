import { constants, createHash, generateKeyPairSync, privateDecrypt } from "node:crypto";

const PASSWORD_ENCRYPTION_ENABLED =
  (process.env.AUTH_PASSWORD_ENCRYPTION_ENABLED ?? "true").trim().toLowerCase() !== "false";

const keyPair = PASSWORD_ENCRYPTION_ENABLED
  ? generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
  : null;

const publicKeyDer =
  PASSWORD_ENCRYPTION_ENABLED && keyPair
    ? (keyPair.publicKey.export({ type: "spki", format: "der" }) as Buffer)
    : Buffer.alloc(0);

const publicKeyPem =
  PASSWORD_ENCRYPTION_ENABLED && keyPair
    ? (keyPair.publicKey.export({ type: "spki", format: "pem" }) as string)
    : "";

const publicKeyId =
  PASSWORD_ENCRYPTION_ENABLED && publicKeyDer.length > 0
    ? createHash("sha256").update(publicKeyDer).digest("hex").slice(0, 16)
    : "";

export interface PasswordPublicKeyPayload {
  enabled: boolean;
  algorithm: "RSA-OAEP-256";
  keyId: string;
  spkiBase64: string;
  publicKeyPem: string;
}

export function getPasswordPublicKeyPayload(): PasswordPublicKeyPayload {
  return {
    enabled: PASSWORD_ENCRYPTION_ENABLED,
    algorithm: "RSA-OAEP-256",
    keyId: publicKeyId,
    spkiBase64: publicKeyDer.toString("base64"),
    publicKeyPem,
  };
}

export function resolveSubmittedPassword(input: {
  password?: unknown;
  passwordEncrypted?: unknown;
  passwordKeyId?: unknown;
}): string {
  const encrypted = typeof input.passwordEncrypted === "string" ? input.passwordEncrypted.trim() : "";
  if (encrypted) {
    if (!PASSWORD_ENCRYPTION_ENABLED || !keyPair) {
      throw new Error("PASSWORD_ENCRYPTION_DISABLED");
    }

    const submittedKeyId = typeof input.passwordKeyId === "string" ? input.passwordKeyId.trim() : "";
    if (submittedKeyId && submittedKeyId !== publicKeyId) {
      throw new Error("PASSWORD_KEY_ID_MISMATCH");
    }

    try {
      const decrypted = privateDecrypt(
        {
          key: keyPair.privateKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from(encrypted, "base64"),
      );
      return decrypted.toString("utf8");
    } catch {
      throw new Error("PASSWORD_DECRYPT_FAILED");
    }
  }

  return typeof input.password === "string" ? input.password : "";
}
