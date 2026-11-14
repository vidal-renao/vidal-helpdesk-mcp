import { describe, expect, it } from "vitest";

import {
  formatZurichDateTime,
  formatZurichLongDate,
  formatZurichShortDate,
  formatZurichTime,
  zurichZoneAbbreviation,
} from "../src/lib/zurich-time.js";

describe("zurich-time", () => {
  it("switches from CET to CEST at the spring DST boundary (2026-03-29 01:00 UTC)", () => {
    expect(formatZurichDateTime("2026-03-29T00:59:00.000Z")).toBe("2026-03-29 01:59 CET");
    expect(formatZurichDateTime("2026-03-29T01:00:00.000Z")).toBe("2026-03-29 03:00 CEST");
  });

  it("switches back from CEST to CET at the autumn DST boundary (2026-10-25 01:00 UTC)", () => {
    expect(formatZurichDateTime("2026-10-25T00:30:00.000Z")).toBe("2026-10-25 02:30 CEST");
    expect(formatZurichDateTime("2026-10-25T01:30:00.000Z")).toBe("2026-10-25 02:30 CET");
    expect(zurichZoneAbbreviation(new Date("2026-10-25T00:59:59.000Z"))).toBe("CEST");
    expect(zurichZoneAbbreviation(new Date("2026-10-25T01:00:00.000Z"))).toBe("CET");
  });

  it("formats time-of-day and calendar dates in Zurich, which can differ from the UTC date", () => {
    expect(formatZurichTime("2026-11-14T05:17:00.000Z")).toBe("06:17 CET");
    // 23:30 UTC on the 13th is already the 14th in Zurich.
    expect(formatZurichShortDate("2026-11-13T23:30:00.000Z")).toBe("14 Nov");
    expect(formatZurichLongDate("2026-11-13T23:30:00.000Z")).toBe("Saturday 14 November 2026");
  });

  it("returns an empty string for invalid input instead of throwing", () => {
    expect(formatZurichDateTime("not-a-date")).toBe("");
    expect(formatZurichTime("")).toBe("");
  });
});
