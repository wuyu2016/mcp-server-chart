import { describe, expect, it } from "vitest";
import {
  applyRadarAlignDefault,
  applyRadarMaxDefault,
  applyScaleMax,
  parseMax,
  readRadarAlignEnv,
  readRadarMaxEnv,
  supportsScaleMax,
} from "../../docker/gpt-vis-ssr/scale-max.js";

describe("parseMax", () => {
  it("accepts a positive number", () => {
    expect(parseMax(100)).toBe(100);
    expect(parseMax("80")).toBe(80);
  });

  it("rejects empty, non-positive, and non-numeric values", () => {
    expect(parseMax(undefined)).toBeUndefined();
    expect(parseMax(0)).toBeUndefined();
    expect(parseMax(-5)).toBeUndefined();
    expect(parseMax("")).toBeUndefined();
    expect(parseMax("abc")).toBeUndefined();
  });
});

describe("readRadarAlignEnv", () => {
  it("is unset when the variable is missing or blank", () => {
    expect(readRadarAlignEnv({})).toBeUndefined();
    expect(readRadarAlignEnv({ RADAR_ALIGN: "  " })).toBeUndefined();
  });

  it("accepts only true as aligned", () => {
    expect(readRadarAlignEnv({ RADAR_ALIGN: "true" })).toBe(true);
    expect(readRadarAlignEnv({ RADAR_ALIGN: "TRUE" })).toBe(true);
    expect(readRadarAlignEnv({ RADAR_ALIGN: "false" })).toBe(false);
    expect(readRadarAlignEnv({ RADAR_ALIGN: "1" })).toBe(false);
  });
});

describe("readRadarMaxEnv", () => {
  it("is unset when the variable is missing or blank", () => {
    expect(readRadarMaxEnv({})).toBeUndefined();
    expect(readRadarMaxEnv({ RADAR_MAX: "  " })).toBeUndefined();
  });

  it("reads a positive number and rejects anything else", () => {
    expect(readRadarMaxEnv({ RADAR_MAX: "100" })).toBe(100);
    expect(readRadarMaxEnv({ RADAR_MAX: "0" })).toBeUndefined();
    expect(readRadarMaxEnv({ RADAR_MAX: "abc" })).toBeUndefined();
  });
});

describe("applyRadarMaxDefault", () => {
  it("fills radar max from the environment when the request omitted it", () => {
    expect(applyRadarMaxDefault("radar", { title: "t" }, 100)).toEqual({
      title: "t",
      max: 100,
    });
  });

  it("keeps an explicit max from the request or defaults file", () => {
    expect(applyRadarMaxDefault("radar", { max: 80 }, 100)).toEqual({
      max: 80,
    });
  });

  it("does not change other chart types", () => {
    expect(applyRadarMaxDefault("column", { title: "t" }, 100)).toEqual({
      title: "t",
    });
  });
});

describe("applyRadarAlignDefault", () => {
  it("fills radar align from the environment when the request omitted it", () => {
    expect(applyRadarAlignDefault("radar", { title: "t" }, true)).toEqual({
      title: "t",
      align: true,
    });
  });

  it("keeps an explicit align from the request", () => {
    expect(
      applyRadarAlignDefault("radar", { align: false }, true),
    ).toEqual({ align: false });
  });

  it("does not change other chart types", () => {
    expect(applyRadarAlignDefault("line", { title: "t" }, true)).toEqual({
      title: "t",
    });
  });
});

describe("applyScaleMax", () => {
  it("caps every radar spoke at the configured max", () => {
    const spec = applyScaleMax(
      {
        coordinate: { type: "radar" },
        scale: {
          position: { domainMin: 0, nice: true },
          position1: { domainMin: 0, nice: true, domainMax: 20 },
          color: { range: ["#1783FF"] },
        },
      },
      100,
    );

    expect(spec.scale.position).toEqual({
      domainMin: 0,
      domainMax: 100,
      nice: false,
    });
    expect(spec.scale.position1).toEqual({
      domainMin: 0,
      domainMax: 100,
      nice: false,
    });
    expect(spec.scale.color).toEqual({ range: ["#1783FF"] });
  });

  it("caps the y axis and keeps start-at-zero", () => {
    const spec = applyScaleMax(
      {
        scale: { y: { nice: true, zero: false } },
      },
      100,
    );

    expect(spec.scale.y).toEqual({
      nice: false,
      zero: false,
      domainMax: 100,
    });
  });

  it("caps nested child scales", () => {
    const spec = applyScaleMax(
      {
        scale: { y: { nice: true } },
        children: [{ scale: { y: { nice: true } } }],
      },
      50,
    );

    expect(spec.children[0].scale.y.domainMax).toBe(50);
    expect(spec.children[0].scale.y.nice).toBe(false);
  });

  it("leaves a spec without a value scale unchanged", () => {
    const spec = { type: "interval", scale: { color: { range: ["#f00"] } } };
    expect(applyScaleMax(spec, 100).scale).toEqual(spec.scale);
  });
});

describe("supportsScaleMax", () => {
  it("includes radar and column, and skips dual-axes", () => {
    expect(supportsScaleMax("radar")).toBe(true);
    expect(supportsScaleMax("column")).toBe(true);
    expect(supportsScaleMax("dual-axes")).toBe(false);
    expect(supportsScaleMax("pie")).toBe(false);
  });
});
