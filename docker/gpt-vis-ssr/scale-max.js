/**
 * Charts whose value axis can share one configured ceiling.
 * Pie, maps, diagrams, liquid, and dual-axes are omitted:
 * dual-axes uses two different units on purpose.
 */
export const SCALE_MAX_TYPES = new Set([
  "radar",
  "line",
  "area",
  "column",
  "bar",
  "scatter",
  "histogram",
  "boxplot",
  "violin",
  "waterfall",
]);

const POSITION_SCALE = /^position\d*$/;

export function supportsScaleMax(type) {
  return SCALE_MAX_TYPES.has(type);
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
export function parseMax(value) {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return numeric;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean | undefined} undefined when the variable is unset
 */
export function readRadarAlignEnv(env = process.env) {
  const raw = env.RADAR_ALIGN;
  if (raw == null || String(raw).trim() === "") return undefined;
  return String(raw).trim().toLowerCase() === "true";
}

/**
 * Request `align` wins. Otherwise RADAR_ALIGN fills the radar default.
 * @param {string} type
 * @param {Record<string, any>} merged
 * @param {boolean | undefined} envAlign
 */
export function applyRadarAlignDefault(type, merged, envAlign) {
  if (type !== "radar") return merged;
  if (typeof merged.align === "boolean") return merged;
  if (typeof envAlign !== "boolean") return merged;
  return { ...merged, align: envAlign };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number | undefined} undefined when unset, blank, or not a number > 0
 */
export function readRadarMaxEnv(env = process.env) {
  const raw = env.RADAR_MAX;
  if (raw == null || String(raw).trim() === "") return undefined;
  return parseMax(raw);
}

/**
 * Request or defaults.json `max` wins. Otherwise RADAR_MAX fills the radar ceiling.
 * Other chart types are unchanged.
 * @param {string} type
 * @param {Record<string, any>} merged
 * @param {number | undefined} envMax
 */
export function applyRadarMaxDefault(type, merged, envMax) {
  if (type !== "radar") return merged;
  if (parseMax(merged.max) != null) return merged;
  if (envMax == null) return merged;
  return { ...merged, max: envMax };
}

function isRadarSpec(spec) {
  if (spec?.coordinate?.type === "radar") return true;
  const scale = spec?.scale;
  if (!scale || typeof scale !== "object") return false;
  return Object.keys(scale).some((key) => POSITION_SCALE.test(key));
}

function capScale(scale, max) {
  if (!scale || typeof scale !== "object") return scale;
  return {
    ...scale,
    domainMax: max,
    nice: false,
  };
}

/**
 * Force the value axis (or every radar spoke) to end at `max`.
 * `nice` is turned off so the configured ceiling is not rounded upward.
 * Scatter applies the ceiling to y only.
 * @param {Record<string, any>} spec
 * @param {number} max
 */
export function applyScaleMax(spec, max) {
  if (!spec || typeof spec !== "object" || !Number.isFinite(max)) return spec;

  const next = { ...spec };
  const radar = isRadarSpec(next);

  if (next.scale && typeof next.scale === "object") {
    const scale = { ...next.scale };
    if (radar) {
      for (const key of Object.keys(scale)) {
        if (!POSITION_SCALE.test(key)) continue;
        const axisScale = scale[key];
        if (!axisScale || typeof axisScale !== "object") continue;
        scale[key] = {
          ...capScale(axisScale, max),
          domainMin: 0,
        };
      }
    } else if (scale.y && typeof scale.y === "object") {
      scale.y = capScale(scale.y, max);
    }
    next.scale = scale;
  }

  if (Array.isArray(next.children)) {
    next.children = next.children.map((child) => applyScaleMax(child, max));
  }

  return next;
}
