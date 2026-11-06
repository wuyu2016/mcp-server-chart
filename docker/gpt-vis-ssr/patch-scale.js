import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { applyScaleMax } from "./scale-max.js";

const require = createRequire(import.meta.url);

/** Per-request scale ceiling. Isolated across concurrent renders. */
export const scaleContext = new AsyncLocalStorage();

let patched = false;

/**
 * `@antv/gpt-vis-ssr` drops unknown fields before drawing, so a configured
 * `max` never reaches the scale. Wrap `createChart` and apply it to the
 * spec that the library actually renders.
 *
 * Must run before `@antv/gpt-vis-ssr` is imported.
 */
export function patchCreateChart() {
  if (patched) return;
  const g2 = require("@antv/g2-ssr");
  const original = g2.createChart;
  if (typeof original !== "function") {
    throw new Error("@antv/g2-ssr createChart is not a function");
  }

  g2.createChart = function createChartWithScaleMax(options) {
    const max = scaleContext.getStore()?.max;
    const next = max == null ? options : applyScaleMax(options, max);
    return original(next);
  };
  patched = true;
}
