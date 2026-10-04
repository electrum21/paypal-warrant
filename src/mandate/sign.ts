import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify,
} from "node:crypto";
import type { Mandate, SignedMandate } from "./types.js";

/** Stable JSON: object keys sorted recursively, so signatures don't depend on key order. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function generateKeys(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

export function hashMandate(m: Mandate): string {
  return createHash("sha256").update(canonicalize(m)).digest("hex");
}

export function signMandate(mandate: Mandate, privateKeyPem: string): SignedMandate {
  const payload = Buffer.from(canonicalize(mandate));
  const signature = sign(null, payload, createPrivateKey(privateKeyPem)).toString("base64");
  return { mandate, mandateHash: hashMandate(mandate), signature };
}

/** True only if the hash matches the content AND the signature verifies against the public key. */
export function verifyMandate(sm: SignedMandate, publicKeyPem: string): boolean {
  try {
    if (hashMandate(sm.mandate) !== sm.mandateHash) return false;
    return verify(
      null,
      Buffer.from(canonicalize(sm.mandate)),
      createPublicKey(publicKeyPem),
      Buffer.from(sm.signature, "base64"),
    );
  } catch {
    return false;
  }
}
