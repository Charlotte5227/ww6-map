// image-exporter.js
// viewer.js から画像出力関連だけを切り出したユーティリティ
(function (global) {
  "use strict";

  const MAP_NATIVE_WIDTH = 5000;
  const MAP_NATIVE_HEIGHT = 2438;

  function getLabelPresetKey(labelsVisible, numbersVisible) {
    if (labelsVisible && numbersVisible) return "both";
    if (labelsVisible) return "labelsCountry";
    if (numbersVisible) return "labelsNumber";
    return "none";
  }

  function getMapSizeFromSvg(svg) {
    let width = 5000;
    let height = 2438;
    const vb = (svg.getAttribute("viewBox") || "").trim().split(/\s+/).map(Number);
    if (vb.length === 4 && Number.isFinite(vb[2]) && Number.isFinite(vb[3])) {
      width = Math.max(1, Math.round(vb[2]));
      height = Math.max(1, Math.round(vb[3]));
    }
    return { width, height };
  }

  function getCurrentViewBox(svg) {
    const vb = (svg.getAttribute("viewBox") || "").trim().split(/\s+/).map(Number);
    if (vb.length === 4 && vb.every(Number.isFinite)) {
      return { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
    }
    return { x: 0, y: 0, w: 5000, h: 2438 };
    let height = 2438;
  }

  function closeCanvasSource(source) {
    if (source && typeof source.close === "function") {
      source.close();
    }
  }

  function getSourceWidth(source) {
    return Number(source && source.width) || Number(source && source.naturalWidth) || 0;
  }

  function getSourceHeight(source) {
    return Number(source && source.height) || Number(source && source.naturalHeight) || 0;
  }

  async function loadImageForCanvas(url) {
    const res = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`画像読み込み失敗: ${url} (${res.status})`);

    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (!bytes || bytes.length === 0) throw new Error(`画像が空です: ${url}`);

    const lowerUrl = String(url).toLowerCase();
    if (lowerUrl.endsWith(".png")) {
      const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      const isPng = pngSignature.every((v, i) => bytes[i] === v);
      if (!isPng) throw new Error(`PNG形式ではありません: ${url}`);
    }

    const blob = new Blob([buffer], { type: "image/png" });

    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(blob);
      } catch (e) {
        console.warn("createImageBitmapのデコードに失敗。Imageで再試行します:", e);
      }
    }

    const imgUrl = URL.createObjectURL(blob);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("画像読み込みタイムアウト")), 30000);
        img.onload = () => {
          clearTimeout(timeout);
          resolve();
        };
        img.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("画像読み込みエラー"));
        };
        img.src = imgUrl;
      });
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(imgUrl), 2000);
    }
  }

  function getSourceCropRect(sourceViewBox, srcW, srcH) {
    if (!sourceViewBox) return null;

    const scaleX = srcW / MAP_NATIVE_WIDTH;
    const scaleY = srcH / MAP_NATIVE_HEIGHT;

    const sxRaw = sourceViewBox.x * scaleX;
    const syRaw = sourceViewBox.y * scaleY;
    const swRaw = sourceViewBox.w * scaleX;
    const shRaw = sourceViewBox.h * scaleY;

    const sx = Math.max(0, Math.min(sxRaw, srcW));
    const sy = Math.max(0, Math.min(syRaw, srcH));
    const sw = Math.max(1, Math.min(swRaw, srcW - sx));
    const sh = Math.max(1, Math.min(shRaw, srcH - sy));

    return { sx, sy, sw, sh };
  }

  async function drawLayer(ctx, url, width, height, opacity, sourceViewBox) {
    const source = await loadImageForCanvas(url);
    try {
      ctx.save();
      ctx.globalAlpha = opacity;

      if (sourceViewBox) {
        const srcW = getSourceWidth(source);
        const srcH = getSourceHeight(source);
        if (srcW <= 0 || srcH <= 0) {
          throw new Error(`画像サイズ取得失敗: ${url}`);
        }
        const crop = getSourceCropRect(sourceViewBox, srcW, srcH);
        if (!crop) {
          ctx.drawImage(source, 0, 0, width, height);
        } else {
          ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);
        }
      } else {
        ctx.drawImage(source, 0, 0, width, height);
      }

      ctx.restore();
    } finally {
      closeCanvasSource(source);
    }
  }

  function hasOpaqueWhiteCorners(source) {
    const w = getSourceWidth(source);
    const h = getSourceHeight(source);
    if (w <= 0 || h <= 0) return false;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;

    ctx.drawImage(source, 0, 0, w, h);
    const points = [
      [0, 0],
      [w - 1, 0],
      [0, h - 1],
      [w - 1, h - 1]
    ];

    let whiteOpaqueCount = 0;
    for (const [x, y] of points) {
      const pixel = ctx.getImageData(x, y, 1, 1).data;
      const isOpaque = pixel[3] >= 250;
      const isNearWhite = pixel[0] >= 245 && pixel[1] >= 245 && pixel[2] >= 245;
      if (isOpaque && isNearWhite) whiteOpaqueCount += 1;
    }

    return whiteOpaqueCount >= 3;
  }

  async function drawLabelLayerWithFallbackUrls(ctx, urls, width, height, opacity, sourceViewBox) {
    let lastError = null;

    for (const url of urls) {
      const source = await loadImageForCanvas(url).catch((e) => {
        lastError = e;
        return null;
      });
      if (!source) continue;

      try {
        if (hasOpaqueWhiteCorners(source)) {
          throw new Error(`ラベル画像の背景が不透明です: ${url}`);
        }

        ctx.save();
        ctx.globalAlpha = opacity;

        if (sourceViewBox) {
          const srcW = getSourceWidth(source);
          const srcH = getSourceHeight(source);
          if (srcW <= 0 || srcH <= 0) {
            throw new Error(`画像サイズ取得失敗: ${url}`);
          }
          const crop = getSourceCropRect(sourceViewBox, srcW, srcH);
          if (!crop) {
            ctx.drawImage(source, 0, 0, width, height);
          } else {
            ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);
          }
        } else {
          ctx.drawImage(source, 0, 0, width, height);
        }

        ctx.restore();
        return url;
      } catch (e) {
        lastError = e;
      } finally {
        closeCanvasSource(source);
      }
    }

    throw lastError || new Error("ラベル画像の読み込みに失敗しました");
  }

  async function drawLayerWithFallbackUrls(ctx, urls, width, height, opacity, sourceViewBox) {
    let lastError = null;
    for (const url of urls) {
      try {
        await drawLayer(ctx, url, width, height, opacity, sourceViewBox);
        return url;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError || new Error("画像読み込みに失敗しました");
  }

  function isMissingPreRenderedAssetError(error) {
    const msg = String((error && error.message) || "");
    return msg.includes("generated/map-base.png") || msg.includes("generated/Base.png");
  }

  function cloneBaseOnlySvg(svg) {
    const svgNS = "http://www.w3.org/2000/svg";
    const clone = svg.cloneNode(true);

    const removeSelectors = [
      "#labels-layer",
      "#numbers-layer",
      "#bg-layer-top",
      "#bg-layer-bottom",
      "#date-layer",
      "image",
      "text"
    ];
    for (const selector of removeSelectors) {
      clone.querySelectorAll(selector).forEach((node) => node.remove());
    }

    clone.querySelectorAll(".prov").forEach((prov) => {
      prov.style.opacity = "1";
      prov.style.fillOpacity = "1";
      prov.style.strokeOpacity = "1";
    });

    if (!clone.getAttribute("xmlns")) {
      clone.setAttribute("xmlns", svgNS);
    }

    return clone;
  }

  async function renderBaseOnlyFromSvg(ctx, svg, width, height, sourceViewBox) {
    const svgNS = "http://www.w3.org/2000/svg";
    const clone = cloneBaseOnlySvg(svg);
    clone.setAttribute("viewBox", `${sourceViewBox.x} ${sourceViewBox.y} ${sourceViewBox.w} ${sourceViewBox.h}`);
    clone.setAttribute("width", String(width));
    clone.setAttribute("height", String(height));
    clone.setAttribute("preserveAspectRatio", "none");

    const serialized = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);

    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Base SVG読み込みタイムアウト")), 45000);
        img.onload = () => {
          clearTimeout(timeout);
          resolve();
        };
        img.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("Base SVG読み込みエラー"));
        };
        img.src = objectUrl;
      });

      ctx.save();
      ctx.globalAlpha = 1;
      ctx.drawImage(img, 0, 0, width, height);
      ctx.restore();
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function downloadBlob(blob, fileName) {
    const link = document.createElement("a");
    const blobUrl = URL.createObjectURL(blob);
    link.href = blobUrl;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
  }

  async function drawTextOnlyLayersFromSvg(ctx, svg, width, height, sourceViewBox, options) {
    const { drawCountry, drawNumber } = options;
    if (!drawCountry && !drawNumber) return;

    const svgNS = "http://www.w3.org/2000/svg";
    const tempSvg = document.createElementNS(svgNS, "svg");
    tempSvg.setAttribute("xmlns", svgNS);
    tempSvg.setAttribute("viewBox", `${sourceViewBox.x} ${sourceViewBox.y} ${sourceViewBox.w} ${sourceViewBox.h}`);
    tempSvg.setAttribute("width", String(width));
    tempSvg.setAttribute("height", String(height));

    if (drawCountry) {
      const labelsLayer = svg.querySelector("#labels-layer");
      if (labelsLayer) tempSvg.appendChild(labelsLayer.cloneNode(true));
    }
    if (drawNumber) {
      const numbersLayer = svg.querySelector("#numbers-layer");
      if (numbersLayer) tempSvg.appendChild(numbersLayer.cloneNode(true));
    }

    if (!tempSvg.children.length) return;

    const serialized = new XMLSerializer().serializeToString(tempSvg);
    const blob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);

    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("テキストSVG読み込みタイムアウト")), 30000);
        img.onload = () => {
          clearTimeout(timeout);
          resolve();
        };
        img.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("テキストSVG読み込みエラー"));
        };
        img.src = objectUrl;
      });

      ctx.save();
      ctx.globalAlpha = 1;
      ctx.drawImage(img, 0, 0, width, height);
      ctx.restore();
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function createImageExporter(config) {
    const {
      assetUrl,
      BG_MAPS,
      PREGENERATED_MAP_ASSETS,
      getSvg,
      getStatusIndicator,
      getLabelsVisible,
      getNumbersVisible,
      getActiveBgMaps,
      getBgOpacity
    } = config;

    async function downloadGeneratedLatestImage() {
      const generatedUrl = `${assetUrl("generated/map-latest.png")}?t=${Date.now()}`;
      const res = await fetch(generatedUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`生成済み画像が未作成です (${res.status})`);

      const imageBuffer = await res.arrayBuffer();
      const signature = new Uint8Array(imageBuffer.slice(0, 8));
      const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      const isPng = pngSignature.every((v, i) => signature[i] === v);
      if (!isPng) throw new Error("生成済み画像がPNG形式ではありません");

      const imageBlob = new Blob([imageBuffer], { type: "image/png" });
      if (!imageBlob || imageBlob.size === 0) throw new Error("生成済み画像が空です");

      downloadBlob(imageBlob, `map-latest-${new Date().toISOString().slice(0, 10)}.png`);
    }

    async function downloadMapImageFromPreRendered() {
      const svg = getSvg();
      if (!svg) throw new Error("地図が見つかりません");

      const { width, height } = getMapSizeFromSvg(svg);
      const sourceViewBox = getCurrentViewBox(svg);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("Canvasコンテキスト取得失敗");

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);

      // Base(色付き地図) -> 背景画像群 -> ラベルPNG群
      try {
        await drawLayerWithFallbackUrls(
          ctx,
          [
            PREGENERATED_MAP_ASSETS.base,
            assetUrl("generated/map-base.png"),
            assetUrl("generated/Base.png")
          ],
          width,
          height,
          1,
          sourceViewBox
        );
      } catch (e) {
        if (!isMissingPreRenderedAssetError(e)) {
          throw e;
        }
        console.warn("Baseの事前生成画像が未配備のため、SVGからBaseのみを生成します。", e);
        const svg = getSvg();
        if (!svg) throw e;
        await renderBaseOnlyFromSvg(ctx, svg, width, height, sourceViewBox);
      }

      const activeBgMaps = getActiveBgMaps();
      for (const type of ["topo", "climate", "region", "continent"]) {
        if (!activeBgMaps[type]) continue;
        await drawLayer(ctx, BG_MAPS[type].url, width, height, getBgOpacity(type), sourceViewBox);
      }

      const labelPreset = getLabelPresetKey(getLabelsVisible(), getNumbersVisible());
      const shouldDrawCountry = labelPreset === "labelsCountry" || labelPreset === "both";
      const shouldDrawNumber = labelPreset === "labelsNumber" || labelPreset === "both";

      // ラベルは事前生成PNGを優先し、背景不正や欠落時はラベル層だけの軽量SVG描画で代替する
      try {
        if (labelPreset === "both" && PREGENERATED_MAP_ASSETS.labelsBoth) {
          await drawLabelLayerWithFallbackUrls(
            ctx,
            [
              PREGENERATED_MAP_ASSETS.labelsBoth,
              assetUrl("generated/map-labels-both.png")
            ],
            width,
            height,
            1,
            sourceViewBox
          );
        } else {
          if (shouldDrawCountry) {
            await drawLabelLayerWithFallbackUrls(
              ctx,
              [
                PREGENERATED_MAP_ASSETS.labelsCountry,
                assetUrl("generated/map-labels-country.png"),
                assetUrl("generated/Country_Name.png")
              ],
              width,
              height,
              1,
              sourceViewBox
            );
          }
          if (shouldDrawNumber) {
            await drawLabelLayerWithFallbackUrls(
              ctx,
              [
                PREGENERATED_MAP_ASSETS.labelsNumber,
                assetUrl("generated/map-labels-number.png"),
                assetUrl("generated/Num.png")
              ],
              width,
              height,
              1,
              sourceViewBox
            );
          }
        }
      } catch (e) {
        console.warn("ラベルPNG合成に失敗。ラベル層SVGで代替します:", e);
        const svgForLabelFallback = getSvg();
        if (!svgForLabelFallback) throw e;
        await drawTextOnlyLayersFromSvg(ctx, svgForLabelFallback, width, height, sourceViewBox, {
          drawCountry: shouldDrawCountry,
          drawNumber: shouldDrawNumber
        });
      }

      const pngBlob = await new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error("PNG生成失敗"));
            return;
          }
          resolve(blob);
        }, "image/png");
      });

      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
      downloadBlob(pngBlob, `map-composited-${timestamp}.png`);
    }

    async function downloadMapImageLegacy() {
      const svg = getSvg();
      if (!svg) throw new Error("地図が見つかりません");

      let width = 5000;
      let height = 2438;
      const viewBox = svg.getAttribute("viewBox");
      if (viewBox) {
        const parts = viewBox.split(" ");
        width = parseFloat(parts[2]);
        height = parseFloat(parts[3]);
      }

      const svgString = new XMLSerializer().serializeToString(svg);
      const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
      const svgUrl = URL.createObjectURL(svgBlob);

      try {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) throw new Error("Canvasコンテキスト取得失敗");

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);

        const img = new Image();
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("SVG読み込みタイムアウト")), 45000);
          img.onload = () => {
            clearTimeout(timeout);
            resolve();
          };
          img.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("SVG読み込みエラー"));
          };
          img.src = svgUrl;
        });

        ctx.drawImage(img, 0, 0);
        const pngBlob = await new Promise((resolve, reject) => {
          canvas.toBlob((blob) => {
            if (!blob) {
              reject(new Error("PNG生成失敗"));
              return;
            }
            resolve(blob);
          }, "image/png");
        });

        const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
        downloadBlob(pngBlob, `map-local-${timestamp}.png`);
      } finally {
        URL.revokeObjectURL(svgUrl);
      }
    }

    async function downloadMapImage() {
      const statusIndicator = getStatusIndicator();
      statusIndicator.textContent = "事前生成画像を合成中...";

      try {
        await downloadMapImageFromPreRendered();
        statusIndicator.textContent = "最終更新: " + new Date().toLocaleTimeString();
        console.log("事前生成PNGの合成画像を保存しました");
        return;
      } catch (e) {
        if (isMissingPreRenderedAssetError(e)) {
          console.warn("事前生成アセット(Base)が未配備です。generated/map-latest.png へフォールバックします。");
        } else {
          console.warn("事前生成PNG合成に失敗。次のフォールバックへ:", e);
        }
      }

      statusIndicator.textContent = "生成済み画像を確認中...";
      try {
        await downloadGeneratedLatestImage();
        statusIndicator.textContent = "最終更新: " + new Date().toLocaleTimeString();
        alert("事前生成アセットが未配備のため、生成済み画像を保存しました。\n表示状態（背景/ラベル）とは一致しない場合があります。");
        return;
      } catch (e) {
        console.warn("生成済み画像の取得にも失敗。従来方式へ:", e);
      }

      statusIndicator.textContent = "従来方式で保存中...";
      try {
        await downloadMapImageLegacy();
        statusIndicator.textContent = "最終更新: " + new Date().toLocaleTimeString();
        alert("事前生成PNGでの合成保存に失敗したため、従来方式で保存しました。");
        return;
      } catch (e) {
        console.warn("従来方式の保存にも失敗:", e);
      }

      alert("画像保存に失敗しました。しばらく待って再試行してください。\n画像生成ワークフローが成功しているかも確認してください。");
      statusIndicator.textContent = "データ同期中...";
    }

    return {
      downloadMapImage,
      downloadMapImageFromPreRendered,
      downloadGeneratedLatestImage,
      downloadMapImageLegacy
    };
  }

  global.createImageExporter = createImageExporter;
})(window);
