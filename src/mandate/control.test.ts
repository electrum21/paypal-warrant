import { describe, expect, it } from "vitest";
import { CONTROL_MAX_AGE_MS, controlIsFresh, signControl, verifyControl, type ControlRequest } from "./control.js";
import { generateKeys, signMandate } from "./sign.js";

const req: ControlRequest = { action: "pause_agent", userId: "u1", subjectId: "u1", reason: "lost my phone", issuedAt: "2026-11-01T12:00:00.000Z", nonce: "nonce-12345678" };

describe("signed user controls", () => {
  it("verifies a request signed by the user's key", () => {
    const k = generateKeys();
    expect(verifyControl(signControl(req, k.privateKeyPem), k.publicKeyPem)).toBe(true);
  });
  it("rejects a different key", () => {
    expect(verifyControl(signControl(req, generateKeys().privateKeyPem), generateKeys().publicKeyPem)).toBe(false);
  });
  it("rejects any change to the request after signing", () => {
    const k = generateKeys();
    const sc = signControl(req, k.privateKeyPem);
    expect(verifyControl({ ...sc, request: { ...sc.request, action: "resume_agent" } }, k.publicKeyPem)).toBe(false);
    expect(verifyControl({ ...sc, request: { ...sc.request, subjectId: "u2" } }, k.publicKeyPem)).toBe(false);
  });
  it("returns false (not an exception) for garbage input", () => {
    expect(verifyControl({ request: req, signature: "!!!" }, "not a pem")).toBe(false);
  });
  it("is not interchangeable with a mandate signature", () => {
    const k = generateKeys();
    const sm = signMandate({ id: "m1", version: 1, userId: "u1", agentId: "a", description: "d", currency: "USD", maxAmountCents: 1,
      allowedMerchantIds: ["x"], validFrom: "a", expiresAt: "b", nonce: "12345678" }, k.privateKeyPem);
    expect(verifyControl({ request: req, signature: sm.signature }, k.publicKeyPem)).toBe(false);
  });
  it("accepts only requests near the server clock", () => {
    const now = new Date("2026-11-01T12:00:00.000Z");
    expect(controlIsFresh(req, now)).toBe(true);
    expect(controlIsFresh(req, new Date(now.getTime() + CONTROL_MAX_AGE_MS + 1000))).toBe(false);
    expect(controlIsFresh(req, new Date(now.getTime() - CONTROL_MAX_AGE_MS - 1000))).toBe(false);
    expect(controlIsFresh({ ...req, issuedAt: "garbage" }, now)).toBe(false);
  });
});
