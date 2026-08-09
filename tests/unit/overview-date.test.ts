import { describe, expect, it } from "vitest";

import {
  dateKey,
  overviewEventDayLabel,
  overviewEventDayMarker,
} from "../../src/views/pages/overview-date";

describe("Overview recent-work dates", () => {
  it("does not label today's event group", () => {
    expect(overviewEventDayLabel("2026-08-06", "2026-08-06")).toBeNull();
  });

  it("labels only the previous calendar day as yesterday", () => {
    expect(overviewEventDayLabel("2026-08-05", "2026-08-06")).toBe("昨天");
    expect(overviewEventDayLabel("2026-07-31", "2026-08-01")).toBe("昨天");
  });

  it("uses an actual date from the day before yesterday onward", () => {
    expect(overviewEventDayLabel("2026-08-04", "2026-08-06")).toBe("8月4日");
    expect(overviewEventDayLabel("2025-12-30", "2026-01-01")).toBe("2025年12月30日");
  });

  it("derives event days in the Vault timezone", () => {
    expect(dateKey("2026-08-05T16:30:00Z", "Asia/Shanghai")).toBe("2026-08-06");
    expect(dateKey("2026-08-05T16:30:00Z", "America/Los_Angeles")).toBe("2026-08-05");
  });

  it("creates a marker only for the first event in each reverse-chronological day", () => {
    const first = overviewEventDayMarker(
      "2026-08-05T12:00:00+08:00",
      null,
      "2026-08-06",
      "Asia/Shanghai",
    );
    expect(first).toEqual({ day: "2026-08-05", label: "昨天" });
    expect(
      overviewEventDayMarker(
        "2026-08-05T09:00:00+08:00",
        first?.day ?? null,
        "2026-08-06",
        "Asia/Shanghai",
      ),
    ).toBeNull();
  });
});
