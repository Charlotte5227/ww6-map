import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const BASE_URL = process.env.MAP_RENDER_BASE_URL || "http://127.0.0.1:4173/index.html";
const OUT_PATH = process.env.MAP_RENDER_OUT || "generated/map-latest.png";
const WAIT_TIMEOUT_MS = Number(process.env.MAP_RENDER_WAIT_MS || 60000);
const EXPORT_MODE = String(process.env.MAP_RENDER_EXPORT_MODE || "full").trim().toLowerCase();

const VALID_EXPORT_MODES = new Set(["full", "base", "labels-country", "labels-number", "labels-both"]);
if (!VALID_EXPORT_MODES.has(EXPORT_MODE)) {
  throw new Error(`Unsupported MAP_RENDER_EXPORT_MODE: ${EXPORT_MODE}`);
}

function normalizeMode(value, fallback = "keep") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "show" || normalized === "on" || normalized === "true") return "show";
  if (normalized === "hide" || normalized === "off" || normalized === "false") return "hide";
  return fallback;
}

function parseOpacity(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

const RENDER_OPTIONS = {
  labels: normalizeMode(process.env.MAP_RENDER_LABELS, "keep"),
  numbers: normalizeMode(process.env.MAP_RENDER_NUMBERS, "keep"),
  backgrounds: {
    topo: {
      mode: normalizeMode(process.env.MAP_RENDER_BG_TOPO, "keep"),
      opacity: parseOpacity(process.env.MAP_RENDER_BG_TOPO_OPACITY, 0.5)
    },
    climate: {
      mode: normalizeMode(process.env.MAP_RENDER_BG_CLIMATE, "keep"),
      opacity: parseOpacity(process.env.MAP_RENDER_BG_CLIMATE_OPACITY, 0.5)
    },
    region: {
      mode: normalizeMode(process.env.MAP_RENDER_BG_REGION, "keep"),
      opacity: parseOpacity(process.env.MAP_RENDER_BG_REGION_OPACITY, 0.5)
    },
    continent: {
      mode: normalizeMode(process.env.MAP_RENDER_BG_CONTINENT, "keep"),
      opacity: parseOpacity(process.env.MAP_RENDER_BG_CONTINENT_OPACITY, 0.5)
    }
  }
};

function applyModeToRenderOptions(mode) {
  const options = JSON.parse(JSON.stringify(RENDER_OPTIONS));

  // 事前生成アセットは背景なしで作る
  for (const key of Object.keys(options.backgrounds)) {
    options.backgrounds[key].mode = "hide";
  }

  if (mode === "base") {
    options.labels = "hide";
    options.numbers = "hide";
  } else if (mode === "labels-country") {
    options.labels = "show";
    options.numbers = "hide";
  } else if (mode === "labels-number") {
    options.labels = "hide";
    options.numbers = "show";
  } else if (mode === "labels-both") {
    options.labels = "show";
    options.numbers = "show";
  }

  return options;
}

const EFFECTIVE_RENDER_OPTIONS = applyModeToRenderOptions(EXPORT_MODE);

async function renderMapImage() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage"]
  });

  const page = await browser.newPage({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1
  });

  try {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: WAIT_TIMEOUT_MS });

    await page.waitForSelector("#mapSvg", { timeout: WAIT_TIMEOUT_MS });

    await page.waitForFunction(() => {
      const statusText = document.getElementById("statusIndicator")?.textContent || "";
      if (statusText.includes("同期エラー")) return false;

      const svg = document.getElementById("mapSvg");
      if (!svg) return false;

      const provinceCount = svg.querySelectorAll(".prov").length;
      const hasRenderedState = statusText.includes("最終更新");

      return provinceCount > 0 && hasRenderedState;
    }, { timeout: WAIT_TIMEOUT_MS });

    const activeBgTypes = await page.evaluate((options) => {
      const setBodyToggle = (mode, hiddenClass, toggleFnName) => {
        if (mode === "keep") return;
        const shouldShow = mode === "show";
        const currentlyShown = !document.body.classList.contains(hiddenClass);
        if (shouldShow !== currentlyShown) {
          const fn = globalThis[toggleFnName];
          if (typeof fn === "function") fn();
        }
      };

      setBodyToggle(options.labels, "labels-hidden", "toggleLabels");
      setBodyToggle(options.numbers, "numbers-hidden", "toggleNumbers");

      const getBgShown = (type) => {
        const img = document.getElementById(`bg-img-${type}`);
        if (!img) return false;
        const display = img.style.display;
        return display !== "none";
      };

      for (const [type, cfg] of Object.entries(options.backgrounds || {})) {
        if (!cfg || cfg.mode === "keep") continue;
        const shouldShow = cfg.mode === "show";
        const currentlyShown = getBgShown(type);
        if (shouldShow !== currentlyShown) {
          const fn = globalThis.toggleBgMap;
          if (typeof fn === "function") fn(type);
        }
      }

      for (const [type, cfg] of Object.entries(options.backgrounds || {})) {
        if (!cfg) continue;
        const slider = document.getElementById(`op-${type}`);
        if (slider) slider.value = String(cfg.opacity);
        const updateFn = globalThis.updateBgOpacity;
        if (typeof updateFn === "function") updateFn(type, String(cfg.opacity));
      }

      const active = [];
      for (const [type, cfg] of Object.entries(options.backgrounds || {})) {
        if (!cfg || cfg.mode !== "show") continue;
        active.push(type);
      }
      return active;
    }, EFFECTIVE_RENDER_OPTIONS);

    await page.waitForLoadState("networkidle", { timeout: WAIT_TIMEOUT_MS });
    await page.waitForFunction((types) => {
      for (const type of types) {
        const img = document.getElementById(`bg-img-${type}`);
        if (!img) return false;
        const href = img.getAttribute("href") || img.getAttribute("xlink:href") || "";
        if (!href) return false;
      }
      return true;
    }, activeBgTypes, { timeout: WAIT_TIMEOUT_MS });

    const size = await page.evaluate((mode) => {
      const svg = document.getElementById("mapSvg");
      if (!svg) throw new Error("mapSvg が見つかりません");

      const vb = (svg.getAttribute("viewBox") || "").trim().split(/\s+/).map(Number);
        const width = Number.isFinite(vb[2]) ? Math.round(vb[2]) : 5000;
        const height = Number.isFinite(vb[3]) ? Math.round(vb[3]) : 2438;

      const hideIds = ["topbar", "bgMapControls", "sliderContainer", "statusIndicator"];
      hideIds.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.style.display = "none";
      });

      document.body.style.margin = "0";
      document.body.style.padding = "0";
      document.body.style.display = "block";
      const isLabelOnly = mode === "labels-country" || mode === "labels-number" || mode === "labels-both";
      document.body.style.background = isLabelOnly ? "transparent" : "#ffffff";
      document.body.style.overflow = "visible";
      document.body.style.width = `${width}px`;
      document.body.style.height = `${height}px`;

      const mapContainer = document.getElementById("mapContainer");
      if (!mapContainer) throw new Error("mapContainer が見つかりません");
      mapContainer.style.position = "relative";
      mapContainer.style.width = `${width}px`;
      mapContainer.style.height = `${height}px`;
      mapContainer.style.overflow = "hidden";
      mapContainer.style.background = isLabelOnly ? "transparent" : "#ffffff";

      svg.style.width = `${width}px`;
      svg.style.height = `${height}px`;

      if (isLabelOnly) {
        // ラベル専用モードでは、座標済みのラベル層以外を明示的に隠して透過PNGを作る
        svg.querySelectorAll(".prov").forEach((p) => {
          p.style.display = "none";
          p.style.fill = "transparent";
          p.style.stroke = "transparent";
          p.style.opacity = "0";
        });

        const topBg = svg.querySelector("#bg-layer-top");
        if (topBg) topBg.style.display = "none";
        const bottomBg = svg.querySelector("#bg-layer-bottom");
        if (bottomBg) bottomBg.style.display = "none";
        const dateLayer = svg.querySelector("#date-layer");
        if (dateLayer) dateLayer.style.display = "none";

        svg.querySelectorAll("path,polygon,polyline,rect,circle,ellipse,line,image,use").forEach((el) => {
          if (el.closest("#labels-layer, #numbers-layer")) return;
          el.style.display = "none";
        });

        svg.querySelectorAll("text").forEach((textEl) => {
          if (textEl.closest("#labels-layer, #numbers-layer")) return;
          textEl.style.display = "none";
        });
      }

      return { width, height };
    }, EXPORT_MODE);

    await page.setViewportSize({ width: size.width + 20, height: size.height + 20 });

    const outDir = path.dirname(OUT_PATH);
    await mkdir(outDir, { recursive: true });

    const isLabelOnly = EXPORT_MODE === "labels-country" || EXPORT_MODE === "labels-number" || EXPORT_MODE === "labels-both";
    const mapSvg = page.locator("#mapSvg");

    if (isLabelOnly) {
      const box = await mapSvg.boundingBox();
      if (!box) throw new Error("mapSvg の描画領域取得に失敗しました");

      await page.screenshot({
        path: OUT_PATH,
        type: "png",
        omitBackground: true,
        clip: {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height
        }
      });
    } else {
      await mapSvg.screenshot({ path: OUT_PATH, type: "png" });
    }

    console.log(`Map image generated: ${OUT_PATH} (${size.width}x${size.height}) [mode=${EXPORT_MODE}]`);
  } finally {
    await browser.close();
  }
}

renderMapImage().catch((error) => {
  console.error("Map render failed:", error);
  process.exit(1);
});
