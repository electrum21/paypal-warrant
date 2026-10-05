import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify,
} from "node:crypto";
import type { Cart, Mandate, SignedCart, SignedMandate } from "./types.js";

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

const hashOf = (v: unknown) => createHash("sha256").update(canonicalize(v)).digest("hex");
const signOf = (v: unknown, privateKeyPem: string) =>
  sign(null, Buffer.from(canonicalize(v)), createPrivateKey(privateKeyPem)).toString("base64");
/** True only if the hash matches the content AND the signature verifies against the public key. */
function checkSigned(content: unknown, hash: string, signature: string, publicKeyPem: string): boolean {
  try {
    if (hashOf(content) !== hash) return false;
    return verify(null, Buffer.from(canonicalize(content)), createPublicKey(publicKeyPem), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export function hashMandate(m: Mandate): string {
  return hashOf(m);
}

/** Sign with the USER's private key. The agent never holds this key. */
export function signMandate(mandate: Mandate, userPrivateKeyPem: string): SignedMandate {
  return { mandate, mandateHash: hashMandate(mandate), signature: signOf(mandate, userPrivateKeyPem) };
}

/** Verify against the USER's public key. */
export function verifyMandate(sm: SignedMandate, userPublicKeyPem: string): boolean {
  return checkSigned(sm.mandate, sm.mandateHash, sm.signature, userPublicKeyPem);
}

export function hashCart(c: Cart): string {
  return hashOf(c);
}

/** Sign with the AGENT's private key. */
export function signCart(cart: Cart, agentPrivateKeyPem: string): SignedCart {
  return { cart, cartHash: hashCart(cart), signature: signOf(cart, agentPrivateKeyPem) };
}

/** Verify against the AGENT's public key. */
export function verifyCart(sc: SignedCart, agentPublicKeyPem: string): boolean {
  return checkSigned(sc.cart, sc.cartHash, sc.signature, agentPublicKeyPem);
}
/** True only for a well-formed Ed25519 public key in PEM form. Junk keys would make every signature fail for that user. */
export function isEd25519PublicKeyPem(pem: string): boolean {
  try {
    return createPublicKey(pem).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}
