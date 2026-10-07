import { describe, expect, it } from "vitest";
import { buildZapierEvent } from "./zapier.js";

describe("buildZapierEvent", () => {
  it("is a plain proposal_ready event when nothing is missing", () => {
    const e = buildZapierEvent({ disputeId: 4, message: "New proposal: contest", data: { action: "contest", missing: [] } }, "https://warrant.example.com/");
    expect(e.type).toBe("proposal_ready");
    expect(e.evidenceRequest).toBeUndefined();
    expect(e.links.review).toBe("https://warrant.example.com/admin");
  });
  it("asks the Zap for the missing evidence and says exactly where to send it", () => {
    const e = buildZapierEvent({ disputeId: 4, message: "m", data: { action: "escalate_to_human", missing: ["delivery proof"] } }, "https://warrant.example.com");
    expect(e.type).toBe("evidence_requested");
    expect(e.evidenceRequest?.needed).toEqual(["delivery proof"]);
    expect(e.evidenceRequest?.callbackUrl).toBe("https://warrant.example.com/api/disputes/4/evidence");
    expect(e.evidenceRequest?.authHeader).toBe("x-warrant-evidence-secret");
  });
  it("marks a refreshed proposal as updated, even when something is still missing", () => {
    expect(buildZapierEvent({ disputeId: 1, message: "m", data: { updated: true, missing: [] } }, "http://x").type).toBe("proposal_updated");
    expect(buildZapierEvent({ disputeId: 1, message: "m", data: { updated: true, missing: ["delivery proof"] } }, "http://x").type).toBe("proposal_updated");
  });
  it("ignores malformed data instead of throwing", () => {
    expect(buildZapierEvent({ disputeId: 1, message: "m", data: null }, "http://x").type).toBe("proposal_ready");
    expect(buildZapierEvent({ disputeId: 1, message: "m", data: { missing: "nope" } }, "http://x").type).toBe("proposal_ready");
  });
});
