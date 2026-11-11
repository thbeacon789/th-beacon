import { describe, it, expect } from "vitest";
import { describeLabel } from "@/web/queries";
import { EMPTY_LABEL } from "@/core/types";

describe("describeLabel", () => {
  it("EMPTY_LABEL → 兩項皆「尚未標記」", () => {
    expect(describeLabel(EMPTY_LABEL)).toEqual({
      severity: "尚未標記",
      category: "尚未標記",
    });
  });

  it("severity wrong P0、category correct → 「判錯，應為 P0」「判對」", () => {
    expect(
      describeLabel({
        severityVerdict: "wrong",
        severityCorrect: "P0",
        categoryVerdict: "correct",
        categoryCorrect: null,
      }),
    ).toEqual({ severity: "判錯，應為 P0", category: "判對" });
  });

  it("category wrong app → 「判錯，應為 app 問題」", () => {
    expect(
      describeLabel({
        ...EMPTY_LABEL,
        categoryVerdict: "wrong",
        categoryCorrect: "app",
      }).category,
    ).toBe("判錯，應為 app 問題");
  });
});
