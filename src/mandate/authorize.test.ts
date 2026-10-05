import { describe, expect, it } from "vitest";
import { generateKeys, signCart, signMandate } from "./sign.js";
import { verifyAuthorization } from "./authorize.js";
import type { Cart, Mandate, Purchase } from "./types.js";

const mandate: Mandate = {
  id: "m1", version: 1, userId: "u1", agentId: "agent-1", description: "Buy size 10 trail runners, max $120, RunCo only",
  currency: "USD", maxAmountCents: 12000, allowedMerchantIds: ["runco"], allowedCategories: ["footwear"],
  validFrom: "2026-11-01T00:00:00Z", expiresAt: "2026-11-02T00:00:00Z", nonce: "abcdef123456",
};
const purchase: Purchase = { merchantId: "runco", amountCents: 11500, currency: "USD", category: "footwear", at: "2026-11-01T12:00:00Z" };

function world() {
  const user = generateKeys(), agent = generateKeys();
  const signedMandate = signMandate(mandate, user.privateKeyPem);
  const cart: Cart = {
    cartId: "cart-0001-abcdef", mandateId: "m1", mandateHash: signedMandate.mandateHash, agentId: "agent-1",
    merchantId: "runco", amountCents: 11500, currency: "USD", category: "footwear", createdAt: "2026-11-01T12:00:00Z",
  };
  const signedCart = signCart(cart, agent.privateKeyPem);
  const base = { signedMandate, signedCart, userPublicKeyPem: user.publicKeyPem, agentPublicKeyPem: agent.publicKeyPem, purchase };
  return { user, agent, signedMandate, cart, signedCart, base };
}

describe("verifyAuthorization", () => {
  it("accepts a user-signed mandate with a matching agent-signed cart", () => {
    const r = verifyAuthorization(world().base);
    expect(r).toMatchObject({ ok: true, mandateSignedByUser: true, cartSignedByAgent: true, cartBoundToMandate: true, cartMatchesPurchase: true });
    expect(r.problems).toEqual([]);
  });
  it("rejects a mandate the agent signed with its own key (the agent cannot issue its own mandate)", () => {
    const w = world();
    const forged = signMandate(mandate, w.agent.privateKeyPem);
    const cart = signCart({ ...w.cart, mandateHash: forged.mandateHash }, w.agent.privateKeyPem);
    const r = verifyAuthorization({ ...w.base, signedMandate: forged, signedCart: cart });
    expect(r.ok).toBe(false);
    expect(r.mandateSignedByUser).toBe(false);
    expect(r.cartSignedByAgent).toBe(true);
  });
  it("rejects a mandate whose limit was raised after the user signed it", () => {
    const w = world();
    const tampered = { ...w.signedMandate, mandate: { ...w.signedMandate.mandate, maxAmountCents: 99999 } };
    expect(verifyAuthorization({ ...w.base, signedMandate: tampered }).mandateSignedByUser).toBe(false);
  });
  it("rejects a cart signed by someone other than the registered agent", () => {
    const w = world();
    const r = verifyAuthorization({ ...w.base, signedCart: signCart(w.cart, generateKeys().privateKeyPem) });
    expect(r.ok).toBe(false);
    expect(r.cartSignedByAgent).toBe(false);
  });
  it("rejects a cart that was edited after signing", () => {
    const w = world();
    const edited = { ...w.signedCart, cart: { ...w.signedCart.cart, amountCents: 100 } };
    expect(verifyAuthorization({ ...w.base, signedCart: edited }).cartSignedByAgent).toBe(false);
  });
  it("rejects a cart signed for a different mandate", () => {
    const w = world();
    const other = signCart({ ...w.cart, mandateId: "m2" }, w.agent.privateKeyPem);
    const r = verifyAuthorization({ ...w.base, signedCart: other });
    expect(r.cartBoundToMandate).toBe(false);
    expect(r.ok).toBe(false);
  });
  it("rejects a cart whose mandate hash is not this mandate's", () => {
    const w = world();
    const other = signCart({ ...w.cart, mandateHash: "0".repeat(64) }, w.agent.privateKeyPem);
    expect(verifyAuthorization({ ...w.base, signedCart: other }).cartBoundToMandate).toBe(false);
  });
  it("rejects a purchase that differs from the signed cart", () => {
    const w = world();
    for (const p of [{ amountCents: 13500 }, { currency: "EUR" }, { category: "electronics" }, { merchantId: "other" }]) {
      expect(verifyAuthorization({ ...w.base, purchase: { ...purchase, ...p } }).cartMatchesPurchase).toBe(false);
    }
  });
  it("fails when there is no cart", () => {
    const r = verifyAuthorization({ ...world().base, signedCart: undefined });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain("No signed cart");
  });
  it("fails when the user or agent key is not registered", () => {
    const w = world();
    expect(verifyAuthorization({ ...w.base, userPublicKeyPem: undefined }).mandateSignedByUser).toBe(false);
    expect(verifyAuthorization({ ...w.base, agentPublicKeyPem: undefined }).cartSignedByAgent).toBe(false);
  });
});