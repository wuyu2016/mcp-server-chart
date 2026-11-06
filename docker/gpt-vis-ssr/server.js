import express from "express";
import cors from "cors";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import OSS from "ali-oss";
import { patchCreateChart, scaleContext } from "./patch-scale.js";
import {
  applyRadarAlignDefault,
  applyRadarMaxDefault,
  parseMax,
  readRadarAlignEnv,
  readRadarMaxEnv,
  supportsScaleMax,
} from "./scale-max.js";

// Patch before the chart library loads, so its createChart binding sees the wrapper.
patchCreateChart();
const { render } = await import("@antv/gpt-vis-ssr");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(cors());

// ── Load default style config ──
const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(__dirname, "defaults.json");
let configDefaults;
try {
  configDefaults = JSON.parse(readFileSync(configPath, "utf-8"));
  console.log(`Loaded defaults from ${configPath}`);
} catch (e) {
  console.warn("Failed to load defaults.json, using empty defaults", e.message);
  configDefaults = { global: {}, perType: {} };
}

// ── OSS client ──
const ossClient = new OSS({
  region: process.env.OSS_REGION,
  bucket: process.env.OSS_BUCKET,
  accessKeyId: process.env.OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
  endpoint: process.env.OSS_ENDPOINT,
});

const OSS_PATH_PREFIX = process.env.OSS_PATH_PREFIX || "charts";

// ── Image URL mode ──
// false (default): public bucket + object path (result.url from put())
// true: OSS pre-signed URL, valid for OSS_SIGNED_URL_EXPIRES seconds
const OSS_SIGNED_URL_ENABLED =
  (process.env.OSS_SIGNED_URL_ENABLED || "false").toLowerCase() === "true";
const OSS_SIGNED_URL_EXPIRES = parseInt(
  process.env.OSS_SIGNED_URL_EXPIRES || "3600",
  10,
);

// Unset means "do not override"; the chart library then keeps align=false.
const RADAR_ALIGN_DEFAULT = readRadarAlignEnv();
// Unset means radar spokes stay on the data scale. Request and defaults.json win.
const RADAR_MAX_DEFAULT = readRadarMaxEnv();

/**
 * Merge defaults with request params.
 * Priority (low → high): global → perType → request body
 * `style` is deep-merged; other fields are overridden by key.
 */
function mergeOptions(type, body) {
  const { style: bodyStyle, ...bodyRest } = body;
  const perType = configDefaults.perType?.[type] || {};
  const { style: perTypeStyle, ...perTypeRest } = perType;
  const { style: globalStyle, ...globalRest } = configDefaults.global || {};

  return {
    ...globalRest,
    ...perTypeRest,
    ...bodyRest,
    style: {
      ...globalStyle,
      ...perTypeStyle,
      ...bodyStyle,
    },
  };
}

// ── Routes ──

app.post("/render", async (req, res) => {
  try {
    const { type, data, ...rest } = req.body;

    if (!type) {
      return res.json({ success: false, errorMessage: "Missing 'type' field" });
    }

    // Merge defaults with request params.
    // align: request > defaults.json > RADAR_ALIGN > library default (false)
    // radar max: request > defaults.json > RADAR_MAX > no fixed ceiling
    const merged = applyRadarMaxDefault(
      type,
      applyRadarAlignDefault(
        type,
        mergeOptions(type, rest),
        RADAR_ALIGN_DEFAULT,
      ),
      RADAR_MAX_DEFAULT,
    );
    const scaleMax = supportsScaleMax(type) ? parseMax(merged.max) : undefined;

    // Render chart to image buffer
    const renderChart = () => render({ type, data, ...merged });
    const vis =
      scaleMax == null
        ? await renderChart()
        : await scaleContext.run({ max: scaleMax }, renderChart);
    const buffer = vis.toBuffer();
    vis.destroy();

    // Upload to OSS
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.png`;
    const ossPath = `${OSS_PATH_PREFIX}/${filename}`;

    const result = await ossClient.put(ossPath, buffer);

    // Build the image URL returned to the user
    const imageUrl = OSS_SIGNED_URL_ENABLED
      ? ossClient.signatureUrl(ossPath, { expires: OSS_SIGNED_URL_EXPIRES })
      : result.url;

    res.json({ success: true, resultObj: imageUrl });
  } catch (e) {
    console.error("Render error:", e);
    res.json({ success: false, errorMessage: e.message || "Unknown error" });
  }
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const PORT = parseInt(process.env.PORT || "3000", 10);
function logScaleConfig() {
  if (RADAR_ALIGN_DEFAULT !== undefined) {
    console.log(`Radar align default (RADAR_ALIGN): ${RADAR_ALIGN_DEFAULT}`);
  }
  if (process.env.RADAR_MAX != null && String(process.env.RADAR_MAX).trim() !== "") {
    console.log(
      RADAR_MAX_DEFAULT == null
        ? `RADAR_MAX=${process.env.RADAR_MAX} is invalid; expected a number greater than 0`
        : `Radar scale max (RADAR_MAX): ${RADAR_MAX_DEFAULT}`,
    );
  }
  for (const [type, cfg] of Object.entries(configDefaults.perType || {})) {
    const max = parseMax(cfg?.max);
    if (max == null) continue;
    console.log(
      supportsScaleMax(type)
        ? `Scale max for ${type}: ${max}`
        : `Scale max for ${type} is set to ${max} but this chart type has no shared value axis; it will be ignored`,
    );
  }
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`GPT-Vis-SSR server listening on port ${PORT}`);
  console.log(
    OSS_SIGNED_URL_ENABLED
      ? `Image URL mode: signed (expires in ${OSS_SIGNED_URL_EXPIRES}s)`
      : "Image URL mode: public bucket URL",
  );
  logScaleConfig();
});