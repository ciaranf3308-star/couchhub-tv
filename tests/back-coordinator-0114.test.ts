/**
 * @vitest-environment jsdom
 */
// 0.11.14 W1 (§5) — Back coordinator re-entrancy: one press resolves
// exactly one layer, even when a layer's handler resolves Back
// again synchronously.

import { describe, it, expect } from "vitest";
import {
  BACK_PRIORITY,
  registerBackLayer,
  resolveBack,
} from "@/scripts/lib/back-handler";

describe("resolveBack re-entrancy guard (§5)", () => {
  it("a nested resolveBack inside a layer handler consumes nothing", () => {
    const calls: string[] = [];
    let nestedResult: boolean | null = null;
    const unregisters = [
      registerBackLayer({
        id: "test:drawer-0114",
        priority: BACK_PRIORITY.DRAWER,
        isActive: () => true,
        handle: () => {
          calls.push("drawer");
          nestedResult = resolveBack();
          return true;
        },
      }),
      registerBackLayer({
        id: "test:route-0114",
        priority: BACK_PRIORITY.ROUTE,
        isActive: () => true,
        handle: () => {
          calls.push("route");
          return true;
        },
      }),
    ];
    try {
      expect(resolveBack()).toBe(true);
    } finally {
      for (const fn of unregisters) fn();
    }
    expect(calls).toEqual(["drawer"]);
    expect(nestedResult).toBe(false);
  });

  it("sequential presses still resolve normally after a guarded one", () => {
    let count = 0;
    const unregister = registerBackLayer({
      id: "test:page-0114",
      priority: BACK_PRIORITY.PAGE_STATE,
      isActive: () => true,
      handle: () => {
        count++;
        return true;
      },
    });
    try {
      expect(resolveBack()).toBe(true);
      expect(resolveBack()).toBe(true);
    } finally {
      unregister();
    }
    expect(count).toBe(2);
  });
});
