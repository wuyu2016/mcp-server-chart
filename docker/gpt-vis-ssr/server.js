import express from "express";
import cors from "cors";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@antv/gpt-vis-ssr";
import OSS from "ali-oss";

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

    // Merge defaults with request params
    const merged = mergeOptions(type, rest);

    // Render chart to image buffer
    const vis = await render({ type, data, ...merged });
    const buffer = vis.toBuffer();
    vis.destroy();

    // Upload to OSS
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.png`;
    const ossPath = `${OSS_PATH_PREFIX}/${filename}`;

    const result = await ossClient.put(ossPath, buffer);

    // Build public URL
    const publicUrl = result.url;

    res.json({ success: true, resultObj: publicUrl });
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
app.listen(PORT, "0.0.0.0", () => {
  console.log(`GPT-Vis-SSR server listening on port ${PORT}`);
});