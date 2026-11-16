/**
 * The DPP Assistant's answer rules, from the accuracy benchmark's Layer B run
 * (tracepass-claude-runner evals/dpp-assistant-accuracy):
 *
 *  - acc-09: the model told the user "You must also ensure the passport is
 *    available for 10 years", against the no-"you must" rule that sat only in the
 *    tool descriptions. Every answer result now carries the rule next to the data,
 *    where the closing disclaimer already proved that models keep an instruction.
 *  - acc-08: on needs_input the model handed the user every question, including
 *    ones the user's own description settled (a rack UPS for server rooms is for
 *    industrial use). A needs_input result now says to answer those itself and call
 *    again.
 *  - acc-30: the model sent a face cream as "other" and got not_covered; consumer
 *    goods no other key names belong in fmcg, which answers them.
 */
import { describe, it, expect } from "vitest";
import {
  ANSWER_WORDING_RULE,
  COMPLIANCE_INSTRUCTIONS,
  NEEDS_INPUT_RULE,
  buildComplianceTools,
  complianceResult,
} from "../src/compliance-server.js";
import type { TracePassClient } from "../src/api-client.js";
import { named } from "./helpers.js";

const disclaimer = "Regulatory information, not legal advice. — TracePass DPP Assistant";
const texts = (r: ReturnType<typeof complianceResult>): string[] => r.content.map((c) => c.text);

describe("answer wording rule (acc-09)", () => {
  it("every answer result carries the holder-as-subject rule before the closing disclaimer", () => {
    const r = complianceResult({
      status: 200,
      ok: true,
      body: { status: "answered", answer: "x", disclaimer },
    });
    const t = texts(r);
    expect(t).toContain(ANSWER_WORDING_RULE);
    expect(t.at(-1)).toBe(`End your answer with this line, word for word:\n${disclaimer}`);
    expect(t.indexOf(ANSWER_WORDING_RULE)).toBe(t.length - 2);
  });

  it("the rule names the forbidden forms and the form to use instead", () => {
    for (const phrase of ['"you must"', '"you have to"', '"you need to"']) {
      expect(ANSWER_WORDING_RULE).toContain(phrase);
    }
    expect(ANSWER_WORDING_RULE).toMatch(/holder as the subject/);
  });

  it("the server instructions carry the same rule", () => {
    expect(COMPLIANCE_INSTRUCTIONS).toContain(ANSWER_WORDING_RULE);
  });

  it("a result with no disclaimer (a profile read) and an error carry no answer rules", () => {
    expect(texts(complianceResult({ status: 200, ok: true, body: { profile: {} } }))).toHaveLength(
      1,
    );
    const err = complianceResult({ status: 400, ok: false, body: { disclaimer } });
    expect(texts(err)).not.toContain(ANSWER_WORDING_RULE);
  });
});

describe("needs_input: settle what the user already said (acc-08)", () => {
  it("a needs_input result tells the model to answer settled questions and call again", () => {
    const r = complianceResult({
      status: 200,
      ok: true,
      body: { status: "needs_input", ask: [{ fact: "battery.use" }], disclaimer },
    });
    const t = texts(r);
    expect(t).toContain(NEEDS_INPUT_RULE);
    expect(t.at(-1)).toMatch(/^End your answer with this line/);
    expect(NEEDS_INPUT_RULE).toMatch(/call scope_check again/);
    expect(NEEDS_INPUT_RULE).toMatch(/server rooms/);
  });

  it("an answered result does not carry the needs_input rule", () => {
    const r = complianceResult({
      status: 200,
      ok: true,
      body: { status: "answered", disclaimer },
    });
    expect(texts(r)).not.toContain(NEEDS_INPUT_RULE);
  });

  it("the instructions say reading facts from the user's words is not adding facts", () => {
    expect(COMPLIANCE_INSTRUCTIONS).toMatch(/user's own description/);
  });
});

describe("scope_check category: consumer goods are fmcg (acc-30)", () => {
  const description = (): string => {
    const t = named(buildComplianceTools({} as TracePassClient), "scope_check");
    const category = t.inputSchema.category as { description?: string } | undefined;
    return category?.description ?? "";
  };

  it("names cosmetics, personal care and food as fmcg", () => {
    const d = description();
    expect(d).toMatch(/cosmetics[^.]*→ fmcg|cosmetics[^.]*are fmcg/);
    expect(d).toMatch(/personal care/);
    expect(d).toMatch(/food/);
  });

  it('keeps "other" for a product no key covers, and says what it returns', () => {
    expect(description()).toMatch(/"other" only[^.]*not_covered/);
  });
});
