import { describe, expect, it } from "vitest";
import { generatePassword, type ResolvedPasswordPolicy } from "./passwordPolicy";

const policy = (overrides: Partial<ResolvedPasswordPolicy> = {}): ResolvedPasswordPolicy => ({
  minLength: 12,
  maxLength: 100,
  requiresComplexity: true,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSymbol: false,
  requirementsText: "",
  validationMessage: "",
  ...overrides,
});

describe("generatePassword", () => {
  it("satisfies every required character class", () => {
    for (let i = 0; i < 50; i += 1) {
      const generated = generatePassword(policy({ requireSymbol: true }));

      expect(generated).toMatch(/[a-z]/);
      expect(generated).toMatch(/[A-Z]/);
      expect(generated).toMatch(/[0-9]/);
      expect(generated).toMatch(/[!@#$%^&*\-_=+]/);
    }
  });

  it("omits symbols when the policy does not ask for them", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generatePassword(policy())).not.toMatch(/[!@#$%^&*\-_=+]/);
    }
  });

  it("respects the length bounds", () => {
    expect(generatePassword(policy()).length).toBeGreaterThanOrEqual(12);
    expect(generatePassword(policy({ minLength: 40 })).length).toBe(40);
    expect(generatePassword(policy({ maxLength: 14 })).length).toBeLessThanOrEqual(14);
  });

  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 100 }, () => generatePassword(policy())));

    expect(seen.size).toBe(100);
  });

  it("does not park the required characters at the front", () => {
    // Without shuffling, the first characters would always be the same classes.
    const firsts = new Set(Array.from({ length: 60 }, () => generatePassword(policy())[0]));

    expect(firsts.size).toBeGreaterThan(3);
  });
});
