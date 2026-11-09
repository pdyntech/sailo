import { describe, expect, it } from "vitest";
import { TOTAL_TICKS, isBerthed, makeTick } from "./telemetry.js";

const voyage = Array.from({ length: TOTAL_TICKS }, (_, k) => makeTick(k));

describe("berthing rule (PRD §8.2)", () => {
  it("detects the berth at the end of the scripted Manila to Cebu route", () => {
    expect(isBerthed(voyage)).toBe(true);
    expect(voyage.slice(0, -3).some((_, k) => isBerthed(voyage.slice(0, k + 1)))).toBe(false); // not before the last 3
  });

  it("does not count a ship anchored offshore: stopped, but outside the 800 m geofence", () => {
    const anchored = voyage.map((t, k) => (k >= TOTAL_TICKS - 3 ? { ...t, inGeofence: false, sog: 0 } : t));
    expect(isBerthed(anchored)).toBe(false);
  });

  it("does not count a ship still moving inside the geofence", () => {
    const moving = voyage.map((t, k) => (k === TOTAL_TICKS - 1 ? { ...t, sog: 0.6 } : t));
    expect(isBerthed(moving)).toBe(false);
  });
});
