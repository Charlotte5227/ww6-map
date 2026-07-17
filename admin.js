// admin.js

  const ASSET_BASE_URL = new URL("./", window.location.href);
  function assetUrl(path) {
    return new URL(path, ASSET_BASE_URL).toString();
  }

  // === 基本設定・状態 ===
  const SELECT_CLASS = "selected";
  const DEFAULT_LABEL_SIZE = 18;
  const selectedIds = new Set();
  const countries = new Map();
  const usedColors = new Set();
  let activeCountryId = "";
  const freeLabels = [];
  let activeFreeLabelId = null;

  // === 時間管理 (Time System) ===
  let timeConfig = null; 
  const TIME_FILE_PATH = "time-config.json"; 

  function calcStepLengthMs() {
    const h = parseInt(document.getElementById("stepLenHours").value) || 0;
    const m = parseInt(document.getElementById("stepLenMins").value) || 0;
    let ms = (h * 60 * 60 * 1000) + (m * 60 * 1000);
    return Math.max(ms, 60000); 
  }

  function getCurrentGameDate() {
    if (!timeConfig) return null;
    const now = Date.now();
    const elapsedMs = now - timeConfig.baseRealTime;
    
    const stepMs = timeConfig.stepLengthMs || timeConfig.dayLengthMs;
    const unit = timeConfig.stepUnit || "day";
    
    const elapsedSteps = Math.floor(elapsedMs / stepMs);
    const d = new Date(timeConfig.baseGameDate);

    if (unit === "year") {
      d.setFullYear(d.getFullYear() + Math.max(0, elapsedSteps));
    } else if (unit === "month") {
      d.setMonth(d.getMonth() + Math.max(0, elapsedSteps));
    } else {
      d.setDate(d.getDate() + Math.max(0, elapsedSteps));
    }

    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');

    return {
      dateObj: d,
      formatStr: `${y}-${m}-${day}`, 
      displayStr: `${timeConfig.calendarName} ${y}年 ${m}月 ${day}日`
    };
  }

  function updateDateDisplay() {
    const display = document.getElementById("currentDateDisplay");
    if (!display) return;
    const current = getCurrentGameDate();
    if (current) {
      display.textContent = `現在の日付: ${current.displayStr}`;
    }
  }
  setInterval(updateDateDisplay, 10000);

  // --- 地図操作系関数 ---
  function randColor() {
    const maxAttempts = 500;
    for (let i = 0; i < maxAttempts; i++) {
      const h = Math.floor(Math.random() * 360);
      const color = `hsl(${h} 70% 55%)`;
      if (!usedColors.has(color)) { usedColors.add(color); return color; }
    }
    return `hsl(${Math.floor(Math.random()*360)} 60% 50%)`;
  }

  function getProvinceBaseColor(id) {
    for (const c of countries.values()) { if (c.ids.has(id)) return c.color; }
    return "#FEF9DB";
  }

  function restoreProvinceColor(id) {
    const svg = getSvgRoot();
    const p = svg.getElementById(id);
    if (!p) return;
    p.style.fill = getProvinceBaseColor(id);
  }

  function getSvgRoot() { return document.getElementById("mapSvg"); }

  function updateStatus() {
    const status = document.getElementById("status");
    const c = activeCountryId ? countries.get(activeCountryId) : null;
    const fl = activeFreeLabelId ? freeLabels.find(f => f.labelId === activeFreeLabelId) : null;

    let modeText = "";
    if (c) modeText = ` / 編集中: ${c.name} (国)`;
    else if (fl) modeText = ` / 編集中: ${fl.type === 'provNumber' ? '数字ラベル' : '自由ラベル'}`;

    status.textContent = `選択中: ${selectedIds.size} / 国数: ${countries.size}${modeText}`;

    const ta = document.getElementById('labelText');
    const lockCb = document.getElementById('lockLabelCenter');
    const sizeInput = document.getElementById('labelSize');
    const sizeVal = document.getElementById('labelSizeVal');
    const btnResetPos = document.getElementById('resetLabelPosBtn');

    if (c) {
      ta.value = c.labelText || c.name || '';
      lockCb.checked = !!c.lockCenter; lockCb.disabled = false; btnResetPos.disabled = false;
      sizeInput.value = c.labelFontSize || DEFAULT_LABEL_SIZE; sizeVal.textContent = sizeInput.value;
    } else if (fl) {
      ta.value = fl.text || '';
      lockCb.checked = false; lockCb.disabled = true; btnResetPos.disabled = true; 
      sizeInput.value = fl.fontSize || DEFAULT_LABEL_SIZE; sizeVal.textContent = sizeInput.value;
    } else {
      ta.value = ''; lockCb.checked = false; lockCb.disabled = true; btnResetPos.disabled = true;
    }
    updateHighlight();
  }

  function updateHighlight() {
    const svg = getSvgRoot();
    svg.querySelectorAll('.label').forEach(el => el.classList.remove('selected-label'));
    let targetLabelId = null;
    if (activeCountryId && countries.has(activeCountryId)) targetLabelId = countries.get(activeCountryId).labelId;
    else if (activeFreeLabelId) targetLabelId = activeFreeLabelId;
    
    if (targetLabelId) {
      const el = svg.getElementById(targetLabelId);
      if (el) el.classList.add('selected-label');
    }
  }

  function ensureLabelsLayer() {
    const svg = getSvgRoot();
    let g = svg.querySelector("#labels-layer");
    if (!g) { g = document.createElementNS("http://www.w3.org/2000/svg", "g"); g.setAttribute("id", "labels-layer"); svg.appendChild(g); }
    return g;
  }

  function computeGroupCenter(idSet) {
    const svg = getSvgRoot();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let any = false;
    for (const id of idSet) {
      const el = svg.getElementById(id);
      if (!el) continue;
      const bb = el.getBBox();
      minX = Math.min(minX, bb.x); minY = Math.min(minY, bb.y);
      maxX = Math.max(maxX, bb.x + bb.width); maxY = Math.max(maxY, bb.y + bb.height);
      any = true;
    }
    if (!any) return { cx: 0, cy: 0 };
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }

  function setLabelTextElem(labelEl, text) {
    while (labelEl.firstChild) labelEl.removeChild(labelEl.firstChild);
    const lines = (text||'').split('\n');
    lines.forEach((ln, i) => {
      const tspan = document.createElementNS('http://www.w3.org/2000/svg','tspan');
      tspan.setAttribute('x', labelEl.getAttribute('x') || 0);
      tspan.setAttribute('dy', i===0 ? '0em' : '1.05em');
      tspan.textContent = ln;
      labelEl.appendChild(tspan);
    });
  }

  function addLabel(name, x, y, size = DEFAULT_LABEL_SIZE) {
    const layer = ensureLabelsLayer();
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    const id = `label-${Date.now()}-${Math.floor(Math.random()*1e6)}`;
    text.setAttribute("id", id); text.setAttribute("class", "label");
    text.setAttribute("x", String(x)); text.setAttribute("y", String(y));
    text.setAttribute("text-anchor", "middle"); text.setAttribute("dominant-baseline", "middle");
    text.setAttribute("pointer-events", "auto");
    text.style.fontSize = `${size}px`; text.setAttribute('data-font-size', String(size));

    setLabelTextElem(text, name); makeLabelDraggable(text); layer.appendChild(text);
    return id;
  }

  function moveLabelToCountryCenter(country) {
    const svg = getSvgRoot(); const label = svg.getElementById(country.labelId);
    if (!label) return;
    const { cx, cy } = computeGroupCenter(country.ids);
    label.setAttribute('x', String(cx)); label.setAttribute('y', String(cy));
    Array.from(label.querySelectorAll('tspan')).forEach(t => t.setAttribute('x', String(cx)));
  }

  function repaintCountry(country) {
    const svg = getSvgRoot();
    for (const id of country.ids) { const p = svg.getElementById(id); if (p) p.style.fill = country.color; }
  }

  function refreshCountrySelect() {
    const sel = document.getElementById("countrySelect");
    const current = sel.value;
    sel.innerHTML = `<option value="">（国を選択）</option>`;
    for (const [cid, c] of countries.entries()) {
      const opt = document.createElement("option");
      opt.value = cid; opt.textContent = c.name; sel.appendChild(opt);
    }
    if (current && countries.has(current)) sel.value = current;
    else if (activeCountryId && countries.has(activeCountryId)) sel.value = activeCountryId;
  }

  document.addEventListener("click", (e) => {
    if (isMapMoved) { isMapMoved = false; return; }
    const el = e.target;
    if (el && el.classList && el.classList.contains("prov")) {
      const id = el.id; if (!id) return;
      if (selectedIds.has(id)) { selectedIds.delete(id); el.classList.remove(SELECT_CLASS); restoreProvinceColor(id); }
      else { selectedIds.add(id); el.classList.add(SELECT_CLASS); }
      updateStatus(); return;
    }
    const labelNode = el.closest ? el.closest('.label') : null;
    if (labelNode) {
      const labelId = labelNode.id;
      for (const [cid, c] of countries.entries()) {
        if (c.labelId === labelId) { activeCountryId = cid; activeFreeLabelId = null; refreshCountrySelect(); document.getElementById('countrySelect').value = cid; updateStatus(); return; }
      }
      const fl = freeLabels.find(f => f.labelId === labelId);
      if (fl) { activeCountryId = ""; activeFreeLabelId = labelId; refreshCountrySelect(); document.getElementById('countrySelect').value = ""; updateStatus(); return; }
    }
  });

  document.getElementById("countrySelect").addEventListener("change", (e) => { activeCountryId = e.target.value; if (activeCountryId) activeFreeLabelId = null; updateStatus(); });
  document.getElementById("toggleLabels").addEventListener("change", (e) => { document.body.classList.toggle("labels-hidden", !e.target.checked); });

  document.getElementById("createCountryBtn").addEventListener("click", () => {
    if (selectedIds.size === 0) { alert("まずプロビを選択してください。"); return; }
    const name = document.getElementById("nameInput").value.trim();
    if (!name) { alert("国名を入力してください。"); return; }
    const cid = `c-${Date.now()}-${Math.floor(Math.random()*1e6)}`;
    const color = document.getElementById("colorInput").value;
    const ids = new Set(selectedIds);
    const { cx, cy } = computeGroupCenter(ids);
    const labelId = addLabel(name, cx, cy, DEFAULT_LABEL_SIZE);

    const country = { name, color, ids, labelId, labelText: name, labelFontSize: DEFAULT_LABEL_SIZE, lockCenter: false };
    countries.set(cid, country);

    for (const id of selectedIds) { const p = getSvgRoot().getElementById(id); if (p) { p.classList.remove("selected"); p.style.fill = country.color; } }
    document.getElementById("nameInput").value = ""; activeCountryId = cid; activeFreeLabelId = null; refreshCountrySelect();
    document.getElementById("countrySelect").value = cid; selectedIds.clear(); updateStatus();
  });

  document.getElementById("applyToCountryBtn").addEventListener("click", () => {
    if (!activeCountryId || !countries.has(activeCountryId)) { alert("まず編集する国を選択してください。"); return; }
    if (selectedIds.size === 0) { alert("追加/削除したいプロビを選択してください。"); return; }
    const country = countries.get(activeCountryId);
    for (const id of selectedIds) {
      const p = getSvgRoot().getElementById(id);
      if (country.ids.has(id)) { country.ids.delete(id); if (p) p.style.fill = "#FEF9DB"; } 
      else { country.ids.add(id); if (p) p.style.fill = country.color; }
      if (p) p.classList.remove("selected");
    }
    if (country.ids.size === 0) {
      const labelEl = getSvgRoot().getElementById(country.labelId); if (labelEl) labelEl.remove();
      countries.delete(activeCountryId); usedColors.delete(country.color); activeCountryId = ""; refreshCountrySelect();
    } else { if (!country.lockCenter) moveLabelToCountryCenter(country); }
    selectedIds.clear(); updateStatus();
  });

  function buildExportArrayFromCountries() {
    const out = [];
    
    const current = getCurrentGameDate();
    if (current) {
      out.push({ type: "metadata", date: current.displayStr });
    }

    for (const [, c] of countries.entries()) {
      const labelEl = getSvgRoot().getElementById(c.labelId);
      const lx = labelEl ? labelEl.getAttribute('x') : null; const ly = labelEl ? labelEl.getAttribute('y') : null;
      out.push({
        type: "country", name: c.name, color: c.color, provinces: Array.from(c.ids),
        labelText: c.labelText, labelFontSize: c.labelFontSize || DEFAULT_LABEL_SIZE,
        labelX: lx, labelY: ly, lockCenter: !!c.lockCenter
      });
    }
    for (const l of freeLabels) {
      const el = getSvgRoot().getElementById(l.labelId); if (!el) continue;
      out.push({ type: l.type || "freeLabel", provId: l.provId, text: l.text, fontSize: l.fontSize || DEFAULT_LABEL_SIZE, x: el.getAttribute("x"), y: el.getAttribute("y") });
    }
    return out;
  }

  document.getElementById("exportBtn").addEventListener("click", () => {
    const exportData = buildExportArrayFromCountries();
    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "map-data.json"; a.click(); URL.revokeObjectURL(url);
  });

  function resetAllToWhite() {
    const svg = getSvgRoot();
    const provs = svg.querySelectorAll(".prov");
    provs.forEach(p => { p.classList.remove("selected"); p.style.fill = "#FEF9DB"; });
    const layer = svg.querySelector("#labels-layer"); if (layer) layer.remove();
  }

  function importData(jsonArray) {
    countries.clear(); usedColors.clear(); selectedIds.clear(); 
    activeCountryId = ""; freeLabels.length = 0; activeFreeLabelId = null;
    resetAllToWhite();

    jsonArray.forEach(item => {
      if (item.type === "metadata") return; 
      if (item.type === "freeLabel" || item.type === "provNumber") {
        const fontSize = item.fontSize || (item.type === "provNumber" ? 14 : DEFAULT_LABEL_SIZE);
        const labelId = addLabel(item.text, item.x, item.y, fontSize);
        freeLabels.push({ type: item.type, provId: item.provId, text: item.text, labelId: labelId, fontSize: fontSize });
        return;
      }
      if (!item || !item.name || !item.color || !Array.isArray(item.provinces)) return;
      const cid = `c-${Date.now()}-${Math.floor(Math.random()*1e6)}`;
      const ids = new Set(item.provinces); usedColors.add(item.color);
      const { cx, cy } = computeGroupCenter(ids);
      const labelX = (typeof item.labelX !== 'undefined' && item.labelX !== null) ? Number(item.labelX) : cx;
      const labelY = (typeof item.labelY !== 'undefined' && item.labelY !== null) ? Number(item.labelY) : cy;
      const fontSize = item.labelFontSize || DEFAULT_LABEL_SIZE;

      const labelId = addLabel(item.labelText || item.name, labelX, labelY, fontSize);
      const country = { name: item.name, color: item.color, ids, labelId, labelText: item.labelText || item.name, labelFontSize: fontSize, lockCenter: !!item.lockCenter };
      countries.set(cid, country); repaintCountry(country);
    });
    refreshCountrySelect(); updateStatus();
  }

  async function readJsonFile(file) { const text = await file.text(); const data = JSON.parse(text); if (!Array.isArray(data)) throw new Error("JSONの形式が想定と違います"); return data; }
  document.getElementById("importBtn").addEventListener("click", async () => {
    const input = document.getElementById("importFile");
    if (!input.files || input.files.length === 0) { alert("map-data.json を選択してください。"); return; }
    try { const data = await readJsonFile(input.files[0]); importData(data); alert("読み込み完了！"); } catch (e) { alert("失敗： " + e.message); }
  });

  // ==========================================
  // ★追加: オートセーブ（自動保存）機能
  // ==========================================
  function performAutoSave() {
    try {
      const data = buildExportArrayFromCountries();
      // 変更がなくても状態を保存し続ける（ローカルストレージへ格納）
      localStorage.setItem("mapPainterAutoSave", JSON.stringify(data));
      
      const status = document.getElementById("autoSaveStatus");
      const timeStr = new Date().toLocaleTimeString();
      status.textContent = `✓ 自動保存済 (${timeStr})`;
      
      // 3秒後に文字を消す（チカチカさせないため）
      setTimeout(() => { 
        if (status.textContent.startsWith("✓")) status.textContent = ""; 
      }, 3000);
    } catch(e) {
      console.error("オートセーブに失敗しました:", e);
    }
  }

  // 自動保存から復元ボタンの処理
  document.getElementById("restoreAutoSaveBtn").addEventListener("click", () => {
    const savedStr = localStorage.getItem("mapPainterAutoSave");
    if (!savedStr) {
      alert("自動保存されたデータがありません。（まだ何も編集していません）");
      return;
    }
    
    if (confirm("最後に自動保存された状態を復元しますか？\n（現在の未保存の編集は失われます）")) {
      try {
        const data = JSON.parse(savedStr);
        importData(data);
        alert("自動保存から復元しました！");
      } catch(e) {
        alert("復元に失敗しました: " + e.message);
      }
    }
  });


  // --- GitHub API 通信系 ---
  const GH_OWNER = "Charlotte5227"; const GH_REPO  = "ww6-map"; const GH_PATH  = "map-data.json";
  function toBase64Utf8(str) { return btoa(unescape(encodeURIComponent(str))); }
  function fromBase64Utf8(base64) {
    const binary = atob(base64.replace(/\s/g, ""));
    const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  }
  async function getFileSha(owner, repo, path, token) {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", Accept: "application/vnd.github+json" }, cache: "no-store" });
    if (res.status === 404) return null; if (!res.ok) throw new Error("取得失敗:" + path);
    return (await res.json()).sha;
  }
  async function fetchContentsJson(owner, repo, path, token) {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", Accept: "application/vnd.github+json" }, cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`取得失敗:${path}`);
    const payload = await res.json();
    if (!payload || typeof payload.content !== "string") return null;
    return JSON.parse(fromBase64Utf8(payload.content));
  }
  async function fetchContentsRawText(owner, repo, path, token) {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3.raw" }, cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`取得失敗:${path}`);
    return await res.text();
  }
  async function putFile(owner, repo, path, token, contentText, shaOrNull) {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const body = { message: `Update ${path}`, content: toBase64Utf8(contentText), ...(shaOrNull ? { sha: shaOrNull } : {}) };
    const res = await fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", Accept: "application/vnd.github+json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error("保存失敗:" + path);
  }

  document.getElementById("publishBtn").addEventListener("click", async () => {
    const token = document.getElementById("ghToken").value.trim();
    const status = document.getElementById("publishStatus");
    if (!token) { alert("GitHub token を入力してください。"); return; }
    
    status.textContent = "最新データを公開中…";
    status.style.color = "#d97706";
    
    try {
      const data = buildExportArrayFromCountries();
      const jsonStr = JSON.stringify(data, null, 2);
      
      const sha = await getFileSha(GH_OWNER, GH_REPO, GH_PATH, token);
      await putFile(GH_OWNER, GH_REPO, GH_PATH, token, jsonStr, sha);
      
      const current = getCurrentGameDate();
      if (current) {
        status.textContent = "履歴データを保存中…";
        const histPath = `history/map-data-${current.formatStr}.json`;
        const histSha = await getFileSha(GH_OWNER, GH_REPO, histPath, token);
        await putFile(GH_OWNER, GH_REPO, histPath, token, jsonStr, histSha);
      }
      
      status.textContent = "公開＆履歴保存 完了！";
      status.style.color = "#10b981";
      setTimeout(() => status.textContent = "", 3000);
    } catch (e) { 
      status.textContent = "エラー発生"; status.style.color = "red"; alert(e.message); 
    }
  });

  document.getElementById("loadHistoryBtn").addEventListener("click", async () => {
    const token = document.getElementById("ghToken").value.trim();
    const targetDate = document.getElementById("historyDateInput").value;
    if (!token) { alert("GitHub token を入力してください。"); return; }
    if (!targetDate) { alert("読み込みたい日付を指定してください。"); return; }

    const btn = document.getElementById("loadHistoryBtn");
    btn.textContent = "検索中...";
    
    try {
      const histPath = `history/map-data-${targetDate}.json`;
      const rawText = await fetchContentsRawText(GH_OWNER, GH_REPO, histPath, token);

      if (rawText === null) {
        alert(`${targetDate} の地図データは保存されていません。`);
        btn.textContent = "読み込む";
        return;
      }

      const data = JSON.parse(rawText);
      importData(data);
      alert(`${targetDate} の地図を復元しました！`);
    } catch(e) {
      alert("読み込み失敗: " + e.message);
    }
    btn.textContent = "読み込む";
  });

  document.getElementById("saveTimeBtn").addEventListener("click", async () => {
    const token = document.getElementById("ghToken").value.trim();
    const calName = document.getElementById("calNameInput").value.trim();
    const startDate = document.getElementById("startDateInput").value;
    const stepUnit = document.getElementById("stepUnit").value;
    const stepLenMs = calcStepLengthMs();

    if (!token) { alert("GitHub token を入力してください。"); return; }
    if (!calName || !startDate) { alert("暦名と開始日を入力してください。"); return; }

    const configData = {
      calendarName: calName,
      repositoryName: "ww6-map",
      baseGameDate: startDate,
      baseRealTime: Date.now(), 
      stepLengthMs: stepLenMs,
      stepUnit: stepUnit
    };

    document.getElementById("saveTimeBtn").textContent = "保存中...";
    try {
      const sha = await getFileSha(GH_OWNER, GH_REPO, TIME_FILE_PATH, token);
      await putFile(GH_OWNER, GH_REPO, TIME_FILE_PATH, token, JSON.stringify(configData, null, 2), sha);
      timeConfig = configData;
      updateDateDisplay();
      alert("世界時計の基準点をセットしました！時間が進行し始めます。");
    } catch (e) {
      alert("時間設定の保存に失敗しました: " + e.message);
    }
    document.getElementById("saveTimeBtn").textContent = "設定して時間を動かす";
  });

  document.getElementById("loadTimeBtn").addEventListener("click", async () => {
    const token = document.getElementById("ghToken").value.trim();
    if (!token) { alert("GitHub token を入力してください。"); return; }
    
    try {
      const loadedConfig = await fetchContentsJson(GH_OWNER, GH_REPO, TIME_FILE_PATH, token);
      if (!loadedConfig) { alert("時間設定がまだ保存されていません。"); return; }

      timeConfig = loadedConfig;
      
      document.getElementById("calNameInput").value = timeConfig.calendarName;
      document.getElementById("startDateInput").value = timeConfig.baseGameDate;
      
      const stepMs = timeConfig.stepLengthMs || timeConfig.dayLengthMs || 3600000;
      const hours = Math.floor(stepMs / 3600000);
      const mins = Math.floor((stepMs % 3600000) / 60000);
      document.getElementById("stepLenHours").value = hours;
      document.getElementById("stepLenMins").value = mins;
      
      if (timeConfig.stepUnit) {
        document.getElementById("stepUnit").value = timeConfig.stepUnit;
      } else {
        document.getElementById("stepUnit").value = "day"; 
      }

      updateDateDisplay();
      alert("時間設定を取得しました。");
    } catch (e) {
      alert("設定の取得に失敗しました。");
    }
  });


  // --- 細かいUI動作 ---
  document.getElementById('applyLabelTextBtn').addEventListener('click', () => {
    const text = document.getElementById('labelText').value;
    if (activeCountryId && countries.has(activeCountryId)) {
      const c = countries.get(activeCountryId); c.labelText = text;
      const labelEl = getSvgRoot().getElementById(c.labelId); if (labelEl) setLabelTextElem(labelEl, text); return;
    }
    if (activeFreeLabelId) {
      const fl = freeLabels.find(f => f.labelId === activeFreeLabelId);
      if (fl) { fl.text = text; const labelEl = getSvgRoot().getElementById(fl.labelId); if (labelEl) setLabelTextElem(labelEl, text); }
      return;
    }
    alert('編集対象のラベルをクリックして選択してください');
  });

  document.getElementById('labelSize').addEventListener('input', (e) => { document.getElementById('labelSizeVal').textContent = e.target.value; });
  document.getElementById('applySizeBtn').addEventListener('click', () => {
    const size = document.getElementById('labelSize').value;
    if (activeCountryId && countries.has(activeCountryId)) {
      const c = countries.get(activeCountryId); c.labelFontSize = size;
      const labelEl = getSvgRoot().getElementById(c.labelId);
      if (labelEl) { labelEl.style.fontSize = `${size}px`; labelEl.setAttribute('data-font-size', size); } return;
    }
    if (activeFreeLabelId) {
      const fl = freeLabels.find(f => f.labelId === activeFreeLabelId);
      if (fl) { fl.fontSize = size; const labelEl = getSvgRoot().getElementById(fl.labelId); if (labelEl) { labelEl.style.fontSize = `${size}px`; labelEl.setAttribute('data-font-size', size); } }
      return;
    }
    alert('編集対象のラベルをクリックして選択してください');
  });

  document.getElementById('resetLabelPosBtn').addEventListener('click', () => {
    if (!activeCountryId || !countries.has(activeCountryId)) return;
    const c = countries.get(activeCountryId); const { cx, cy } = computeGroupCenter(c.ids);
    const labelEl = getSvgRoot().getElementById(c.labelId);
    if (labelEl) { labelEl.setAttribute('x', String(cx)); labelEl.setAttribute('y', String(cy)); Array.from(labelEl.querySelectorAll('tspan')).forEach(t => t.setAttribute('x', String(cx))); }
  });

  document.getElementById('lockLabelCenter').addEventListener('change', (e) => {
    if (!activeCountryId || !countries.has(activeCountryId)) return;
    const c = countries.get(activeCountryId); c.lockCenter = e.target.checked; if (c.lockCenter) moveLabelToCountryCenter(c);
  });

  function makeLabelDraggable(labelEl) {
    let dragging = false; let startX = 0, startY = 0, origX = 0, origY = 0;
    labelEl.addEventListener('pointerdown', (ev) => {
      ev.preventDefault(); labelEl.setPointerCapture(ev.pointerId); dragging = true; startX = ev.clientX; startY = ev.clientY;
      origX = Number(labelEl.getAttribute('x') || 0); origY = Number(labelEl.getAttribute('y') || 0);
    });
    labelEl.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      const ctm = getSvgRoot().getScreenCTM(); if (!ctm) return; const scale = ctm.a; 
      const dx = (ev.clientX - startX) / scale; const dy = (ev.clientY - startY) / scale;
      const newX = origX + dx; const newY = origY + dy;
      labelEl.setAttribute('x', String(newX)); labelEl.setAttribute('y', String(newY));
      Array.from(labelEl.querySelectorAll('tspan')).forEach(t => t.setAttribute('x', String(newX)));
    });
    labelEl.addEventListener('pointerup', (ev) => {
      if (!dragging) return; dragging = false; try { labelEl.releasePointerCapture(ev.pointerId); } catch (e) {}
      for (const [cid, c] of countries.entries()) {
        if (c.labelId === labelEl.id) { c.lockCenter = false; c.labelText = c.labelText || c.name; updateStatus(); break; }
      }
    });
    labelEl.addEventListener('pointercancel', () => { dragging = false; });
  }

  document.getElementById("addFreeLabelBtn").addEventListener("click", () => {
    const text = prompt("ラベルの文字を入力してください"); if (!text) return;
    const svg = getSvgRoot(); const viewBox = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : null;
    const x = viewBox && viewBox.width ? viewBox.x + viewBox.width/2 : 500;
    const y = viewBox && viewBox.height ? viewBox.y + viewBox.height/2 : 300;
    const labelId = addLabel(text, x, y, DEFAULT_LABEL_SIZE);
    freeLabels.push({ type: "freeLabel", text: text, labelId: labelId, fontSize: DEFAULT_LABEL_SIZE });
    activeFreeLabelId = labelId; activeCountryId = ""; document.getElementById("countrySelect").value = ""; updateStatus();
  });

  document.getElementById("addProvinceNumbersBtn").addEventListener("click", () => {
    if(!confirm("すべてのプロヴィンスに連番ラベルを自動生成しますか？")) return;
    const svg = getSvgRoot(); const provs = svg.querySelectorAll(".prov"); let count = 1;
    const fontSize = parseInt(document.getElementById("provLabelSize").value, 10); 
    provs.forEach(p => {
      const bb = p.getBBox(); const cx = bb.x + bb.width / 2; const cy = bb.y + bb.height / 2;
      const labelId = addLabel(String(count), cx, cy, fontSize);
      freeLabels.push({ type: "provNumber", provId: p.id, text: String(count), labelId: labelId, fontSize: fontSize });
      count++;
    });
    alert(`${count - 1} 個の連番ラベルを生成しました。`); updateStatus();
  });

  document.getElementById('provLabelSize').addEventListener('input', (e) => { document.getElementById('provLabelSizeVal').textContent = e.target.value; });
  document.getElementById('applyProvSizeBtn').addEventListener('click', () => {
    const newSize = document.getElementById('provLabelSize').value; let count = 0;
    freeLabels.forEach(fl => {
      if (fl.type === "provNumber") {
        fl.fontSize = newSize; const labelEl = getSvgRoot().getElementById(fl.labelId);
        if (labelEl) { labelEl.style.fontSize = `${newSize}px`; labelEl.setAttribute('data-font-size', newSize); }
        count++;
      }
    });
    if (activeFreeLabelId) updateStatus(); 
    if (count > 0) { alert(`${count} 個の数字ラベルのサイズを変更しました。`); } else { alert("変更する数字ラベルが見つかりません。"); }
  });

  // === マップのズームとパン ===
  var MAP_WIDTH = 5000;
  var MAP_HEIGHT = 2438;
  var isMapPanning = false;
  var isMapMoved = false;
  var startPanX = 0;
  var startPanY = 0;
  var startViewBoxX = 0;
  var startViewBoxY = 0;

  function updateZoomFromSlider() {
    const svgEl = getSvgRoot();
    const zoomSlider = document.getElementById("zoomSlider");
    const zoomVal = document.getElementById("zoomVal");
    if (!svgEl || !zoomSlider || !zoomVal) return;
    const scale = parseFloat(zoomSlider.value);
    zoomVal.textContent = scale.toFixed(1) + "x";
    const vb = svgEl.viewBox.baseVal;
    const cx = vb.x + vb.width / 2;
    const cy = vb.y + vb.height / 2;
    let newW = MAP_WIDTH / scale;
    let newH = MAP_HEIGHT / scale;
    let newX = cx - newW / 2;
    let newY = cy - newH / 2;
    if (newX < 0) newX = 0; if (newY < 0) newY = 0;
    if (newX + newW > MAP_WIDTH) newX = Math.max(0, MAP_WIDTH - newW);
    if (newY + newH > MAP_HEIGHT) newY = Math.max(0, MAP_HEIGHT - newH);
    svgEl.setAttribute("viewBox", `${newX} ${newY} ${newW} ${newH}`);
  }

function attachAdminEvents() {
  const svgEl = document.getElementById("mapSvg");
  if (!svgEl) return;

  if (!svgEl.getAttribute("viewBox")) {
    svgEl.setAttribute("viewBox", `0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`);
  }

  const zoomSlider = document.getElementById("zoomSlider");
  if (zoomSlider) {
    zoomSlider.addEventListener("input", updateZoomFromSlider);
    updateZoomFromSlider();
  }

  svgEl.addEventListener("wheel", (e) => {
    e.preventDefault();
    const zoomSlider = document.getElementById("zoomSlider");
    if (!zoomSlider) return;
    let currentScale = parseFloat(zoomSlider.value);
    const zoomStep = 0.1;
    if (e.deltaY > 0) currentScale -= zoomStep * 2;
    else currentScale += zoomStep * 2;
    const minScale = parseFloat(zoomSlider.min);
    const maxScale = parseFloat(zoomSlider.max);
    if (currentScale < minScale) currentScale = minScale;
    if (currentScale > maxScale) currentScale = maxScale;
    zoomSlider.value = currentScale;
    updateZoomFromSlider();
  }, { passive: false });

  svgEl.addEventListener("pointerdown", (e) => {
    if (e.target.closest('.label')) return;
    isMapPanning = true;
    isMapMoved = false;
    startPanX = e.clientX;
    startPanY = e.clientY;
    const vb = svgEl.viewBox.baseVal;
    startViewBoxX = vb.x;
    startViewBoxY = vb.y;
  });

  svgEl.addEventListener("pointermove", (e) => {
    if (!isMapPanning) return;
    const dx = e.clientX - startPanX;
    const dy = e.clientY - startPanY;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) isMapMoved = true;
    const ctm = svgEl.getScreenCTM();
    if (!ctm) return;
    const scale = ctm.a;
    const vb = svgEl.viewBox.baseVal;
    let newX = startViewBoxX - (dx / scale);
    let newY = startViewBoxY - (dy / scale);
    if (newX < 0) newX = 0;
    if (newY < 0) newY = 0;
    if (newX + vb.width > MAP_WIDTH) newX = MAP_WIDTH - vb.width;
    if (newY + vb.height > MAP_HEIGHT) newY = MAP_HEIGHT - vb.height;
    svgEl.setAttribute("viewBox", `${newX} ${newY} ${vb.width} ${vb.height}`);
  });

  svgEl.addEventListener("pointerup", () => { isMapPanning = false; });
  svgEl.addEventListener("pointercancel", () => { isMapPanning = false; });
}

async function loadInitialMapData() {
  try {
    const res = await fetch(`${assetUrl("map-data.json")}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) {
      throw new Error("map-data.json の取得に失敗");
    }

    const data = await res.json();
    if (!Array.isArray(data)) {
      throw new Error("map-data.json の形式が不正です");
    }

    importData(data);
  } catch (e) {
    console.warn("初期データ読み込みに失敗しました。", e);
  }
}

// 3. ★重要：起動処理
async function initAdmin() {
  try {
    // SVGを読み込んで挿入
    const res = await fetch(assetUrl("map.svg"));
    const svgText = await res.text();
    document.getElementById("mapContainer").innerHTML = svgText;

    // イベントの紐付け
    attachAdminEvents();

    // 既存のGitHub自動読み込みやローカル保存からの復元処理
    loadInitialMapData();
    setInterval(performAutoSave, 10000);

  } catch (e) {
    console.error("SVGのロードエラー:", e);
  }
}

// 起動
initAdmin();

// ========================================================
// GitHub Pages で配信パスが変わる場合の対策（必要時のみ使用）
// ========================================================
// const GH_PAGES_BASE_PATH = "/ww6-map";
//
// function withBasePath(relativePath) {
//   const clean = relativePath.replace(/^\/+/, "");
//   return `${GH_PAGES_BASE_PATH}/${clean}`;
// }
//
// 使用例:
// fetch(withBasePath("map.svg"));
// fetch(withBasePath("map-data.json"));
