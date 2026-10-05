import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { controlIsFresh, verifyControl } from "../mandate/control.js";
import { verifyMandate } from "../mandate/sign.js";

const html = readFileSync(new URL("./userPage.html", import.meta.url), "utf8");

// Runs the page's real signing code (the block between the crypto markers), so this tests what the browser runs.
const page = new Function(`${html.split("//--crypto-start")[1].split("//--crypto-end")[0]}; return { newKey, signMandate, signControl };`)() as {
  newKey(): Promise<{ jwk: JsonWebKey; pem: string }>;
  signMandate(jwk: JsonWebKey, m: any): Promise<any>;
  signControl(jwk: JsonWebKey, r: any): Promise<any>;
};

const mandate = {
  id: "mandate-abcd1234", version: 1, userId: "demo-user", agentId: "demo-buyer-agent", description: "Buy trail shoes, max $120",
  currency: "USD", maxAmountCents: 12000, maxTotalAmountCents: undefined, maxPurchases: 1,
  allowedMerchantIds: ["warrant-demo-merchant"], allowedCategories: ["footwear"],
  validFrom: "2026-11-01T00:00:00.000Z", expiresAt: "2026-11-02T00:00:00.000Z", nonce: "0f0e0d0c-aaaa-bbbb",
};
const control = { action: "pause_agent", userId: "demo-user", subjectId: "demo-user", reason: undefined, issuedAt: new Date().toISOString(), nonce: "n-12345678" };

describe("the user page's browser signing matches the server's verification", () => {
  it("signs a spending rule that the server accepts", async () => {
    const k = await page.newKey();
    expect(verifyMandate(await page.signMandate(k.jwk, mandate), k.pem)).toBe(true);
  });
  it("survives a JSON round trip, as when the rule is copied to the agent", async () => {
    const k = await page.newKey();
    expect(verifyMandate(JSON.parse(JSON.stringify(await page.signMandate(k.jwk, mandate))), k.pem)).toBe(true);
  });
  it("is rejected if the rule is changed after signing, or checked against another key", async () => {
    const k = await page.newKey();
    const sm = await page.signMandate(k.jwk, mandate);
    expect(verifyMandate({ ...sm, mandate: { ...sm.mandate, maxAmountCents: 99999 } }, k.pem)).toBe(false);
    expect(verifyMandate(sm, (await page.newKey()).pem)).toBe(false);
  });
  it("signs a stop request that the server accepts, including after a JSON round trip", async () => {
    const k = await page.newKey();
    const sc = await page.signControl(k.jwk, control);
    expect(verifyControl(sc, k.pem)).toBe(true);
    expect(verifyControl(JSON.parse(JSON.stringify(sc)), k.pem)).toBe(true);
    expect(controlIsFresh(sc.request)).toBe(true);
  });
  it("loads no outside scripts, so nothing but this page can reach the key", () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
  });
});
