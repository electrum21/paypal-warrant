import { describe, expect, it } from "vitest";
import { draftNarrative, validateLlmOutput } from "./draft.js";

const facts = { action: "contest", purchase: { amount: "115.00 USD" }, mandate: { limit: "120.00 USD", validFrom: "2026-11-01T00:00:00Z" } };
const template = { explanation: "TEMPLATE-EXPLAIN", evidenceNote: "TEMPLATE-NOTE" };
const good = JSON.stringify({ explanation: "We propose contesting. The 115.00 USD purchase was under the 120.00 USD limit.", evidenceNote: "Purchase of 115.00 USD, limit 120.00 USD, valid from 2026-11-01." });

describe("draftNarrative", () => {
  it("uses the template when no LLM is configured", async () => {
    const n = await draftNarrative({ facts, template });
    expect(n.source).toBe("template");
    expect(n.evidenceNote).toBe("TEMPLATE-NOTE");
  });
  it("accepts valid LLM output, including fenced JSON", async () => {
    const n = await draftNarrative({ facts, template }, async () => "```json\n" + good + "\n```");
    expect(n.source).toBe("llm");
    expect(n.explanation).toContain("115.00 USD");
  });
  it("rejects output that invents a number", async () => {
    const bad = JSON.stringify({ explanation: "Refund 99.00 USD.", evidenceNote: "x" });
    const n = await draftNarrative({ facts, template }, async () => bad);
    expect(n.source).toBe("template");
    expect(n.fallbackReason).toContain("number not in the facts");
  });
  it("falls back on invalid JSON and on errors", async () => {
    expect((await draftNarrative({ facts, template }, async () => "sure!")).source).toBe("template");
    const n = await draftNarrative({ facts, template }, async () => { throw new Error("boom"); });
    expect(n.source).toBe("template");
    expect(n.fallbackReason).toContain("boom");
  });
  it("rejects overlong output", () => {
    expect(typeof validateLlmOutput(JSON.stringify({ explanation: "a".repeat(900), evidenceNote: "b" }), facts)).toBe("string");
  });
});
