/* UTrack Workbench — client-side run designer + result viewer.
 * Grid convention (matches the model): 721 x 1440 at 0.25°,
 * row i: lat = 90 - 0.25*i, col j: lon = 0.25*j (0..359.75, wraps).
 * The map is displayed shifted by 180° so Greenwich sits in the middle. */
"use strict";

const H = 721, W = 1440, SHIFT = W / 2;
const $ = (id) => document.getElementById(id);

/* ---------- theme ---------- */
const rootEl = document.documentElement;
function setTheme(mode) {
  rootEl.dataset.theme = mode;
  localStorage.setItem("utrack-theme", mode);
  onThemeChange();
}
$("themeBtn").addEventListener("click", () =>
  setTheme(rootEl.dataset.theme === "dark" ? "light" : "dark"));
rootEl.dataset.theme = localStorage.getItem("utrack-theme") ||
  (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

const css = (name) => getComputedStyle(rootEl).getPropertyValue(name).trim();

/* ---------- tabs ---------- */
document.querySelectorAll("nav button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tab").forEach((t) =>
      t.classList.toggle("active", t.id === "tab-" + b.dataset.tab));
    designMap.fit(); viewMap.fit(); simMap.fit();
  }));

/* ---------- sequential ramp (validated reference palette) ---------- */
const RAMP = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7",
              "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"];
const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function rampColor(t) { // t in [0,1]; dark theme uses the ramp reversed so high values pop light
  const steps = rootEl.dataset.theme === "dark" ? [...RAMP].reverse() : RAMP;
  const x = Math.min(0.99999, Math.max(0, t)) * (steps.length - 1);
  const i = Math.floor(x), f = x - i;
  const a = hex2rgb(steps[i]), b = hex2rgb(steps[i + 1]);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/* ---------- land base layer ---------- */
let landMask = null; // Uint8Array H*W, 1 = land (model grid indexing)
const landReady = new Promise((resolve) => {
  const img = new Image();
  img.onload = () => {
    const c = new OffscreenCanvas(W, H).getContext("2d");
    c.drawImage(img, 0, 0);
    const d = c.getImageData(0, 0, W, H).data;
    landMask = new Uint8Array(H * W);
    for (let k = 0; k < H * W; k++) landMask[k] = d[k * 4] > 127 ? 1 : 0;
    resolve();
  };
  img.src = "assets/land.png";
});

function buildBaseLayer() { // theme-colored ocean+land, display-shifted
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const ocean = hex2rgb(css("--ocean")), land = hex2rgb(css("--land"));
  const img = ctx.createImageData(W, H);
  for (let i = 0; i < H; i++)
    for (let dx = 0; dx < W; dx++) {
      const j = (dx + SHIFT) % W;
      const p = (i * W + dx) * 4, c = landMask[i * W + j] ? land : ocean;
      img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2]; img.data[p + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/* ---------- interactive map ---------- */
class MapView {
  constructor(canvas, tip) {
    this.canvas = canvas; this.tip = tip;
    this.ctx = canvas.getContext("2d");
    this.overlay = new OffscreenCanvas(W, H);
    this.octx = this.overlay.getContext("2d");
    this.base = null;
    this.s = 1; this.ox = 0; this.oy = 0; this.fitted = false;
    this.onPaint = null;   // (i, j, phase) for designer strokes
    this.onHover = null;   // (i, j) -> tooltip string or null
    this.decor = null;     // (ctx) extra drawing in grid space
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.bind();
  }
  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    this.canvas.width = Math.max(1, r.width * dpr);
    this.canvas.height = Math.max(1, r.height * dpr);
    if (!this.fitted) this.fit(); else this.render();
  }
  fit() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    if (r.width < 5) return;
    this.s = Math.min(r.width / W, r.height / H);
    this.ox = (r.width - W * this.s) / 2;
    this.oy = (r.height - H * this.s) / 2;
    this.fitted = true;
    this.render();
  }
  toGrid(e) {
    const r = this.canvas.getBoundingClientRect();
    const gx = (e.clientX - r.left - this.ox) / this.s;
    const gy = (e.clientY - r.top - this.oy) / this.s;
    if (gx < 0 || gx >= W || gy < 0 || gy >= H) return null;
    return { i: Math.floor(gy), j: (Math.floor(gx) + SHIFT) % W, gx, gy };
  }
  bind() {
    const c = this.canvas;
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const f = Math.exp(-e.deltaY * 0.0015);
      const ns = Math.min(60, Math.max(Math.min(r.width / W, r.height / H) * 0.9, this.s * f));
      this.ox = mx - (mx - this.ox) * (ns / this.s);
      this.oy = my - (my - this.oy) * (ns / this.s);
      this.s = ns;
      this.render();
    }, { passive: false });
    let panning = false, painting = false, last = null;
    c.addEventListener("pointerdown", (e) => {
      const pan = e.button === 2 || e.button === 1 || e.shiftKey || !this.onPaint;
      if (pan) { panning = true; last = [e.clientX, e.clientY]; }
      else if (e.button === 0 && this.onPaint) {
        const g = this.toGrid(e);
        if (g) { painting = true; this.onPaint(g, "start"); }
      }
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", (e) => {
      if (panning) {
        this.ox += e.clientX - last[0]; this.oy += e.clientY - last[1];
        last = [e.clientX, e.clientY];
        this.render();
        return;
      }
      const g = this.toGrid(e);
      if (painting && g) this.onPaint(g, "move");
      if (this.onHover) {
        const txt = g ? this.onHover(g) : null;
        if (txt) {
          this.tip.style.display = "block";
          const r = this.canvas.parentElement.getBoundingClientRect();
          this.tip.style.left = (e.clientX - r.left) + "px";
          this.tip.style.top = (e.clientY - r.top) + "px";
          this.tip.innerHTML = txt;
        } else this.tip.style.display = "none";
      }
    });
    const up = (e) => {
      if (painting) { const g = this.toGrid(e); this.onPaint(g, "end"); }
      panning = painting = false;
    };
    c.addEventListener("pointerup", up);
    c.addEventListener("pointerleave", (e) => { this.tip.style.display = "none"; if (!panning) up(e); });
  }
  render() {
    const ctx = this.ctx, dpr = devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.s * dpr, 0, 0, this.s * dpr, this.ox * dpr, this.oy * dpr);
    ctx.imageSmoothingEnabled = this.s * dpr < 1;
    if (this.base) ctx.drawImage(this.base, 0, 0);
    ctx.drawImage(this.overlay, 0, 0);
    if (this.decor) this.decor(ctx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}

const fmtLat = (i) => { const v = 90 - 0.25 * i; return Math.abs(v).toFixed(2) + "°" + (v >= 0 ? "N" : "S"); };
const fmtLon = (j) => { let v = 0.25 * j; if (v > 180) v -= 360; return Math.abs(v).toFixed(2) + "°" + (v >= 0 ? "E" : "W"); };
const fmtNum = (v) => {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-3) return v.toExponential(2);
  if (a >= 100) return v.toFixed(0);
  if (a >= 1) return v.toFixed(2);
  return v.toPrecision(3);
};
const fmtBytes = (b) => b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(0) + " MB" : (b / 1e3).toFixed(0) + " KB";

const designMap = new MapView($("designCanvas"), $("designTip"));
const viewMap = new MapView($("viewCanvas"), $("viewTip"));

/* ================= DESIGNER ================= */
const mask = new Uint8Array(H * W);
const undoStack = [];
let tool = "paint";
const cellAreaRow = new Float32Array(H);
for (let i = 0; i < H; i++) cellAreaRow[i] = 27.83 * 27.83 * Math.cos((90 - 0.25 * i) * Math.PI / 180);

const SIM_TYPES = [
  ["7", "7 — Eulerian 3-D (reference)"],
  ["4", "4 — Lagrangian, 6 h mixing (reference)"],
  ["6", "6 — Eulerian 2-D (vertically integrated)"],
  ["8", "8 — Lagrangian, 1 h mixing"],
  ["9", "9 — Lagrangian, 24 h mixing"],
  ["10", "10 — Lagrangian, 120 h mixing"],
  ["11", "11 — Lagrangian variant, 1 h mixing"],
  ["12", "12 — Lagrangian variant, 6 h mixing"],
  ["13", "13 — Lagrangian variant, 24 h mixing"],
  ["14", "14 — Lagrangian variant, 120 h mixing"],
  ["0", "0 — Lagrangian trajectory expt. 0"],
  ["1", "1 — Lagrangian trajectory expt. 1"],
  ["2", "2 — Lagrangian trajectory expt. 2"],
  ["3", "3 — Lagrangian, isentropic levels"],
];
SIM_TYPES.forEach(([v, label]) => $("simType").append(new Option(label, v)));

function setTool(t) {
  tool = t;
  ["Paint", "Erase", "Rect"].forEach((n) =>
    $("tool" + n).classList.toggle("active", n.toLowerCase() === t));
}
["paint", "erase", "rect"].forEach((t) =>
  $("tool" + t[0].toUpperCase() + t.slice(1)).addEventListener("click", () => setTool(t)));

const brushRadius = () => +$("brushSize").value;
$("brushSize").addEventListener("input", () =>
  $("brushLabel").textContent = (2 * brushRadius() + 1) + " px");
$("brushLabel").textContent = (2 * brushRadius() + 1) + " px";

const accent = () => css("--accent");
function paintCellOverlay(i, j, on) {
  const dx = (j + SHIFT) % W;
  if (on) { designMap.octx.fillStyle = accent(); designMap.octx.fillRect(dx, i, 1, 1); }
  else designMap.octx.clearRect(dx, i, 1, 1);
}
function stampBrush(gi, gj, on) {
  const r = brushRadius();
  for (let di = -r; di <= r; di++)
    for (let dj = -r; dj <= r; dj++) {
      if (di * di + dj * dj > r * r + 0.01) continue;
      const i = gi + di;
      if (i < 0 || i >= H) continue;
      const j = ((gj + dj) % W + W) % W;
      if (mask[i * W + j] !== on) { mask[i * W + j] = on; paintCellOverlay(i, j, on); }
    }
}
function rebuildDesignOverlay() {
  designMap.octx.clearRect(0, 0, W, H);
  designMap.octx.fillStyle = accent();
  for (let i = 0; i < H; i++)
    for (let j = 0; j < W; j++)
      if (mask[i * W + j]) designMap.octx.fillRect((j + SHIFT) % W, i, 1, 1);
  designMap.render();
}
function pushUndo() {
  undoStack.push(mask.slice());
  if (undoStack.length > 30) undoStack.shift();
}
$("undoBtn").addEventListener("click", () => {
  const prev = undoStack.pop();
  if (prev) { mask.set(prev); rebuildDesignOverlay(); updateFootprint(); }
});
$("clearBtn").addEventListener("click", () => {
  pushUndo(); mask.fill(0); rebuildDesignOverlay(); updateFootprint();
});

let rectStart = null, rectCur = null, lastCell = null;
designMap.onPaint = (g, phase) => {
  if (phase === "start") {
    pushUndo();
    if (tool === "rect") { rectStart = rectCur = g; designMap.render(); return; }
    lastCell = g; stampBrush(g.i, g.j, tool === "erase" ? 0 : 1);
    designMap.render(); updateFootprint();
  } else if (phase === "move") {
    if (tool === "rect") { rectCur = g; designMap.render(); return; }
    if (!g) return;
    // interpolate stroke so fast drags leave no gaps
    const steps = Math.max(Math.abs(g.i - lastCell.i), Math.abs(g.gx - lastCell.gx), 1);
    for (let s = 1; s <= steps; s++) {
      const i = Math.round(lastCell.i + (g.i - lastCell.i) * s / steps);
      const j = Math.round(lastCell.j + (g.j - lastCell.j) * s / steps);
      stampBrush(i, ((j % W) + W) % W, tool === "erase" ? 0 : 1);
    }
    lastCell = g;
    designMap.render(); updateFootprint();
  } else if (phase === "end") {
    if (tool === "rect" && rectStart && (g || rectCur)) {
      const e = g || rectCur;
      const i0 = Math.min(rectStart.i, e.i), i1 = Math.max(rectStart.i, e.i);
      let x0 = Math.min(rectStart.gx, e.gx), x1 = Math.max(rectStart.gx, e.gx);
      for (let i = i0; i <= i1; i++)
        for (let dx = Math.floor(x0); dx <= Math.floor(x1); dx++) {
          const j = ((Math.floor(dx) + SHIFT) % W + W) % W;
          if (!mask[i * W + j]) { mask[i * W + j] = 1; paintCellOverlay(i, j, 1); }
        }
      rectStart = rectCur = null;
      designMap.render(); updateFootprint();
    }
    rectStart = rectCur = null; designMap.render();
  }
};
designMap.decor = (ctx) => {
  if (rectStart && rectCur) {
    ctx.strokeStyle = accent();
    ctx.lineWidth = 1.5 / designMap.s;
    const x0 = Math.min(rectStart.gx, rectCur.gx), x1 = Math.max(rectStart.gx, rectCur.gx);
    const y0 = Math.min(rectStart.gy, rectCur.gy), y1 = Math.max(rectStart.gy, rectCur.gy);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }
};
designMap.onHover = (g) => {
  const on = mask[g.i * W + g.j];
  return `${fmtLat(g.i)}, ${fmtLon(g.j)}${on ? " · <b>source</b>" : ""}`;
};

/* examples */
let regions = {};
fetch("assets/regions.json").then((r) => r.json()).then((r) => {
  regions = r;
  Object.keys(r).forEach((name) => $("exampleSel").append(new Option(name, name)));
});
$("exampleSel").addEventListener("change", () => {
  const name = $("exampleSel").value;
  if (!name) return;
  pushUndo();
  for (const [start, len] of regions[name])
    for (let k = 0; k < len; k++) {
      const i = Math.floor((start + k) / W), j = (start + k) % W;
      // grow the single-cell examples into a small visible blob
      for (let di = -2; di <= 2; di++)
        for (let dj = -2; dj <= 2; dj++) {
          if (di * di + dj * dj > 5) continue;
          const ii = i + di, jj = ((j + dj) % W + W) % W;
          if (ii >= 0 && ii < H) mask[ii * W + jj] = 1;
        }
    }
  $("runName").value = name.toLowerCase();
  rebuildDesignOverlay(); updateFootprint();
  $("exampleSel").value = "";
});

/* import */
$("importBtn").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async () => {
  const f = $("importFile").files[0];
  if (!f) return;
  try {
    const nc = NC.parse(await f.arrayBuffer());
    const v = nc.vars.release;
    if (!v || v.shape.reduce((a, b) => a * b, 1) !== H * W) throw new Error("No 721×1440 'release' variable found.");
    const data = v.read();
    pushUndo();
    for (let k = 0; k < H * W; k++) mask[k] = data[k] === 1 ? 1 : 0;
    $("runName").value = f.name.replace(/\.nc$/, "");
    rebuildDesignOverlay(); updateFootprint();
  } catch (err) { alert("Could not import mask: " + err.message); }
  $("importFile").value = "";
});

/* footprint + job preview */
function jobParams() {
  const d = new Date($("startDate").value + "T00:00:00Z");
  return {
    sim: $("simType").value,
    interp: $("interpType").value,
    ppmm: Math.max(1, +$("parcelsPerMM").value || 1),
    days: Math.max(1, +$("releaseDays").value || 1),
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, dday: d.getUTCDate(),
    name: ($("runName").value || "region").replace(/[^\w-]/g, "_"),
  };
}
function updateFootprint() {
  let cells = 0, area = 0;
  for (let i = 0; i < H; i++) {
    let rowc = 0;
    for (let j = 0; j < W; j++) rowc += mask[i * W + j];
    cells += rowc; area += rowc * cellAreaRow[i];
  }
  const p = jobParams();
  const parcels = cells * p.days * 24 * p.ppmm;
  $("stCells").textContent = cells.toLocaleString();
  $("stArea").textContent = area >= 1e6 ? (area / 1e6).toFixed(2) + "M" : Math.round(area).toLocaleString();
  $("stParcels").textContent = parcels >= 1e6 ? (parcels / 1e6).toFixed(1) + "M" : parcels.toLocaleString();
  $("stMem").textContent = fmtBytes(parcels * 7 * 4);
  $("stDays").textContent = p.days + 24;
  $("stGB").textContent = "~" + Math.round((p.days + 24) * 5.8) + " GB";
  $("jobPreview").textContent =
    `${p.sim} ${p.interp} ${p.ppmm} ./input/${p.name}.nc ./output/out_${p.name}_${p.sim}.nc\n` +
    `./run_recycling ${p.y} ${p.m} ${p.dday} ${p.days}`;
}
["simType", "interpType", "parcelsPerMM", "startDate", "releaseDays", "runName"]
  .forEach((id) => $(id).addEventListener("input", updateFootprint));

$("exportMask").addEventListener("click", () => {
  const p = jobParams();
  const bytes = NC.writeMask(mask, H, W);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes], { type: "application/x-netcdf" }));
  a.download = p.name + ".nc";
  a.click();
  URL.revokeObjectURL(a.href);
});
$("copyList").addEventListener("click", () => {
  const p = jobParams();
  navigator.clipboard.writeText(
    `${p.sim} ${p.interp} ${p.ppmm} ./input/${p.name}.nc ./output/out_${p.name}_${p.sim}.nc`);
});
$("copyCmd").addEventListener("click", () => {
  const p = jobParams();
  navigator.clipboard.writeText(
`# local
./run_recycling ${p.y} ${p.m} ${p.dday} ${p.days}

# AWS (containerized; see README-DEPLOY.md)
docker run --rm \\
  -e START_YEAR=${p.y} -e START_MONTH=${p.m} -e START_DAY=${p.dday} -e RELEASE_DAYS=${p.days} \\
  -e FORCING_S3=s3://<bucket>/forcing/<period> \\
  -e INPUT_S3=s3://<bucket>/input \\
  -e LIST_S3=s3://<bucket>/jobs/list.txt \\
  -e OUTPUT_S3=s3://<bucket>/output/${p.name} \\
  <acct>.dkr.ecr.<region>.amazonaws.com/utrack:latest`);
});

/* ================= LIVE SIMULATOR =================
 * Browser port of UTrack's 2-D scheme: parcels move with the
 * moisture-flux-weighted wind (viwve/tcw) and rain out at the column
 * rainout rate (tp/tcw), using 1°-hourly ERA5 fields for 2012-07-01,
 * looped daily. Units: user emits acre-feet/min; budgets in acre-feet. */
const simMap = new MapView($("simCanvas"), $("simTip"));
const SG_W = 360, SG_H = 181, SG_T = 24;
const SIM_DT = 300;                 // physics step, sim-seconds
let simU = null, simV = null, simR = null, simSU = null, simSV = null;
let simRunning = false, simClockS = 0, simSpeed = 14400, lastFrame = 0, stepCarry = 0;
const emitters = [];                // {gy, gx (1° coords), rate ac-ft/min}
let parcels = [];                   // {gy, gx, vol}
const PARCEL_CAP = 30000;
let emittedTotal = 0, rainedTotal = 0;
const depGrid = new Float32Array(SG_H * SG_W);       // rained-out ac-ft per 1° cell
const depCanvas = new OffscreenCanvas(SG_W, SG_H);

/* Monthly wind data: 15th of each month of 2025 (sim_forcing_MM.bin.gz),
 * lazily fetched and cached. */
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const simCache = {};
let simMonthNum = new Date().getMonth() + 1;   // default: current month
MONTH_NAMES.forEach((nm, i) =>
  $("simMonth").append(new Option(`${nm} 2025`, i + 1, false, i + 1 === simMonthNum)));

async function loadSimMonth(m) {
  if (!simCache[m]) {
    simCache[m] = (async () => {
      const mm = String(m).padStart(2, "0");
      const resp = await fetch(`assets/sim_forcing_${mm}.bin.gz`);
      if (!resp.ok) throw new Error(`no wind data for month ${mm}`);
      const buf = await new Response(resp.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
      return buf;
    })();
  }
  const buf = await simCache[m];
  const n = SG_T * SG_H * SG_W;
  simU = new Int8Array(buf, 0, n);
  simV = new Int8Array(buf, n, n);
  simR = new Uint8Array(buf, 2 * n, n);
  // 5-field layout carries ERA5-derived shear dispersion; 3-field is legacy
  const hasShear = buf.byteLength >= 5 * n;
  simSU = hasShear ? new Uint8Array(buf, 3 * n, n) : null;
  simSV = hasShear ? new Uint8Array(buf, 4 * n, n) : null;
  simMonthNum = m;
  $("simDataLabel").textContent = `15 ${MONTH_NAMES[m - 1]} 2025`;
}
let simReady = loadSimMonth(simMonthNum);
$("simMonth").addEventListener("change", () => {
  simReady = loadSimMonth(+$("simMonth").value)
    .catch((e) => { $("simDataLabel").textContent = e.message; });
});

function sampleField(f, gy, gx, tHour) {
  // bilinear in space, linear in (looped) time; f is int8/uint8 raw
  const t0 = Math.floor(tHour) % SG_T, t1 = (t0 + 1) % SG_T, tf = tHour - Math.floor(tHour);
  const y0 = Math.max(0, Math.min(SG_H - 2, Math.floor(gy))), yf = gy - y0;
  const x0 = Math.floor(gx) % SG_W, x1 = (x0 + 1) % SG_W, xf = gx - Math.floor(gx);
  const at = (t, y, x) => f[t * SG_H * SG_W + y * SG_W + x];
  const bil = (t) =>
    (at(t, y0, x0) * (1 - xf) + at(t, y0, x1) * xf) * (1 - yf) +
    (at(t, y0 + 1, x0) * (1 - xf) + at(t, y0 + 1, x1) * xf) * yf;
  return bil(t0) * (1 - tf) + bil(t1) * tf;
}

/* Dispersion: each parcel carries a stochastic velocity perturbation
 * (Ornstein-Uhlenbeck / Langevin) that decorrelates over TAU = 6 h — the
 * model's reference vertical-mixing timescale. Its amplitude is the
 * ERA5-derived humidity-weighted std-dev of wind across the column's 25
 * pressure levels (simSU/simSV), i.e. the vertical-shear spread that the
 * 2-D column collapse removes: parcels mixed to different heights ride
 * different winds, so a plume fans out where the column is sheared. */
const DISP_TAU = 21600;            // s
const DISP_FALLBACK_SIGMA = 2.8;   // m/s rms, only for legacy assets without shear fields
let dispFactor = 1.0;
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function simStep() {
  if (!simU) return;
  const tHour = (simClockS / 3600) % SG_T;
  const sigU = (gy, gx) => dispFactor *
    (simSU ? sampleField(simSU, gy, gx, tHour) * 0.1 : DISP_FALLBACK_SIGMA);
  const sigV = (gy, gx) => dispFactor *
    (simSV ? sampleField(simSV, gy, gx, tHour) * 0.1 : DISP_FALLBACK_SIGMA);
  // emit
  for (const e of emitters) {
    const vol = e.rate * (SIM_DT / 60);
    if (parcels.length < PARCEL_CAP) {
      parcels.push({
        gy: e.gy + (Math.random() - 0.5) * 0.6, gx: e.gx + (Math.random() - 0.5) * 0.6,
        vol, pu: sigU(e.gy, e.gx) * gauss(), pv: sigV(e.gy, e.gx) * gauss(),
      });
      emittedTotal += vol;
    }
  }
  // advect + rain out
  const ouDecay = 1 - SIM_DT / DISP_TAU;
  const ouNoise = Math.sqrt(2 * SIM_DT / DISP_TAU);
  const alive = [];
  for (const p of parcels) {
    p.pu = p.pu * ouDecay + sigU(p.gy, p.gx) * ouNoise * gauss();
    p.pv = p.pv * ouDecay + sigV(p.gy, p.gx) * ouNoise * gauss();
    const u = sampleField(simU, p.gy, p.gx, tHour) * 0.5 + p.pu;   // m/s
    const v = sampleField(simV, p.gy, p.gx, tHour) * 0.5 + p.pv;
    const lat = 90 - p.gy;
    const coslat = Math.max(0.05, Math.cos(lat * Math.PI / 180));
    p.gx = (p.gx + (u * SIM_DT) / (111320 * coslat) + SG_W) % SG_W;
    p.gy = Math.min(SG_H - 1.01, Math.max(0.01, p.gy - (v * SIM_DT) / 111320));
    const rf = sampleField(simR, p.gy, p.gx, tHour) / 500 * (SIM_DT / 3600);
    const dep = p.vol * Math.min(0.9, rf);
    if (dep > 0) {
      p.vol -= dep;
      rainedTotal += dep;
      depGrid[Math.round(p.gy) * SG_W + (Math.round(p.gx) % SG_W)] += dep;
    }
    if (p.vol > 1e-4) alive.push(p);
  }
  parcels = alive;
  simClockS += SIM_DT;
}

function renderDeposition() {
  const ctx = depCanvas.getContext("2d");
  const img = ctx.createImageData(SG_W, SG_H);
  let max = 0;
  for (let k = 0; k < depGrid.length; k++) if (depGrid[k] > max) max = depGrid[k];
  if (max > 0) {
    const lo = Math.log(max * 1e-4), span = Math.log(max) - lo || 1;
    for (let y = 0; y < SG_H; y++)
      for (let x = 0; x < SG_W; x++) {
        const v = depGrid[y * SG_W + x];
        if (!(v > 0)) continue;
        const t = Math.max(0, (Math.log(v) - lo) / span);
        const c = rampColor(t);
        const p = (y * SG_W + (x + 180) % SG_W) * 4;
        img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2];
        img.data[p + 3] = 60 + 180 * t;
      }
  }
  ctx.putImageData(img, 0, 0);
  simMap.octx.clearRect(0, 0, W, H);
  simMap.octx.imageSmoothingEnabled = true;
  simMap.octx.drawImage(depCanvas, 0, -2, W, H + 4); // 181 rows -> 721, tiny stretch
}

simMap.decor = (ctx) => {
  const px = Math.max(1.5, 2 / simMap.s);
  ctx.fillStyle = accent();
  for (const p of parcels) {
    const dx = (p.gx * 4 + SHIFT) % W, dy = p.gy * 4;
    ctx.globalAlpha = 0.35 + 0.6 * Math.min(1, p.vol / (emitters[0]?.rate * 5 / 60 || 1));
    ctx.fillRect(dx - px / 2, dy - px / 2, px, px);
  }
  ctx.globalAlpha = 1;
  for (const e of emitters) {
    const dx = (e.gx * 4 + SHIFT) % W, dy = e.gy * 4;
    ctx.strokeStyle = css("--danger");
    ctx.lineWidth = 2.5 / simMap.s;
    ctx.beginPath();
    ctx.arc(dx, dy, 6 / simMap.s + 2, 0, 7);
    ctx.stroke();
  }
};

simMap.onPaint = (g, phase) => {
  if (phase !== "start") return;
  emitters.push({ gy: g.i / 4, gx: g.j / 4, rate: Math.max(0.1, +$("emitRate").value || 5) });
  $("emitterCount").textContent = emitters.length + " emitter" + (emitters.length === 1 ? "" : "s");
  simMap.render();
};
simMap.onHover = (g) => {
  const d = depGrid[Math.min(SG_H - 1, Math.round(g.i / 4)) * SG_W + (Math.round(g.j / 4) % SG_W)];
  return `${fmtLat(g.i)}, ${fmtLon(g.j)}${d > 0 ? `<br>rained out: <b>${fmtNum(d)}</b> ac-ft` : ""}`;
};

function simBudgetUI() {
  let airborne = 0;
  for (const p of parcels) airborne += p.vol;
  $("wbEmitted").textContent = fmtNum(emittedTotal);
  $("wbAirborne").textContent = fmtNum(airborne);
  $("wbRained").textContent = fmtNum(rainedTotal);
  $("wbParcels").textContent = parcels.length.toLocaleString();
  const day = Math.floor(simClockS / 86400), hm = simClockS % 86400;
  $("simClock").textContent =
    `day ${day} · ${String(Math.floor(hm / 3600)).padStart(2, "0")}:${String(Math.floor(hm % 3600 / 60)).padStart(2, "0")}`;
}

function simFrame(ts) {
  if (!simRunning) return;
  const dtReal = Math.min(0.1, (ts - lastFrame) / 1000 || 0.016);
  lastFrame = ts;
  stepCarry += dtReal * simSpeed / SIM_DT;
  let steps = Math.min(40, Math.floor(stepCarry));
  stepCarry -= steps;
  while (steps--) simStep();
  renderDeposition();
  simMap.render();
  simBudgetUI();
  requestAnimationFrame(simFrame);
}

$("simRunBtn").addEventListener("click", async () => {
  await simReady;
  if (!simRunning && emitters.length === 0) {
    $("simClock").textContent = "place an emitter first";
    return;
  }
  simRunning = !simRunning;
  $("simRunBtn").textContent = simRunning ? "❚❚ Pause" : "▶ Run";
  if (simRunning) { lastFrame = performance.now(); requestAnimationFrame(simFrame); }
});
$("simResetBtn").addEventListener("click", () => {
  simRunning = false;
  $("simRunBtn").textContent = "▶ Run";
  parcels = []; depGrid.fill(0); emittedTotal = rainedTotal = 0; simClockS = 0; stepCarry = 0;
  simMap.octx.clearRect(0, 0, W, H);
  simMap.render();
  simBudgetUI();
});
$("clearEmitters").addEventListener("click", () => {
  emitters.length = 0;
  $("emitterCount").textContent = "0 emitters";
  simMap.render();
});
$("simDisp").addEventListener("change", () => { dispFactor = +$("simDisp").value; });
document.querySelectorAll("[data-speed]").forEach((b) =>
  b.addEventListener("click", () => {
    simSpeed = +b.dataset.speed;
    document.querySelectorAll("[data-speed]").forEach((x) => x.classList.toggle("active", x === b));
  }));
function rateEquivUI() {
  const r = Math.max(0.1, +$("emitRate").value || 5);   // ac-ft/min
  const m3s = r * 1233.48 / 60;
  const mmday = r * 1233.48 * 1440 / (27830 * 27830 * 0.7) * 1000; // over one ~0.25° mid-lat cell
  $("rateEquiv").textContent = `≈ ${m3s.toFixed(0)} m³/s · ≈ ${mmday.toFixed(1)} mm/day over one grid cell`;
}
$("emitRate").addEventListener("input", rateEquivUI);
rateEquivUI();

/* ================= VIEWER ================= */
let fields = {};      // name -> Float32/64Array (H*W)
let curField = null;
let logScale = true;
let sourceInfo = "";

function pickResultVars(nc) {
  const out = {};
  for (const v of Object.values(nc.vars)) {
    if ((v.type === 5 || v.type === 6) && v.shape.length >= 2) {
      const n = v.shape.reduce((a, b) => a * b, 1);
      if (v.shape[v.shape.length - 2] === H && v.shape[v.shape.length - 1] === W && n === H * W)
        out[v.name] = v.read();
    }
  }
  return out;
}
async function loadResult(buf, label) {
  const nc = NC.parse(buf);
  const f = pickResultVars(nc);
  if (!Object.keys(f).length) throw new Error("No 721×1440 float fields found in this file.");
  fields = f;
  sourceInfo = label;
  $("fileInfo").innerHTML = label;
  buildVarChips();
  selectField(fields.allocated ? "allocated" : Object.keys(fields)[0]);
}
function buildVarChips() {
  const box = $("varChips");
  box.innerHTML = "";
  Object.keys(fields).forEach((name) => {
    const b = document.createElement("button");
    b.textContent = name;
    b.addEventListener("click", () => selectField(name));
    box.append(b);
  });
  $("varCard").hidden = false;
  $("statCard").hidden = false;
}
function selectField(name) {
  curField = name;
  document.querySelectorAll("#varChips button").forEach((b) =>
    b.classList.toggle("active", b.textContent === name));
  renderField();
}
function fieldRange(data) {
  let max = 0, minPos = Infinity, sum = 0, count = 0, maxIdx = 0;
  for (let k = 0; k < H * W; k++) {
    const v = data[k];
    if (!(v > 0)) continue;
    sum += v; count++;
    if (v > max) { max = v; maxIdx = k; }
    if (v < minPos) minPos = v;
  }
  return { max, minPos, sum, count, maxIdx };
}
function renderField() {
  if (!curField) return;
  const data = fields[curField];
  const r = fieldRange(data);
  const img = viewMap.octx.createImageData(W, H);
  if (r.max > 0) {
    const lo = Math.max(r.minPos, r.max * 1e-7);
    const llo = Math.log(lo), lspan = Math.log(r.max) - llo || 1;
    for (let i = 0; i < H; i++)
      for (let j = 0; j < W; j++) {
        const v = data[i * W + j];
        if (!(v > 0)) continue;
        const t = logScale ? Math.max(0, (Math.log(v) - llo) / lspan) : v / r.max;
        const c = rampColor(t);
        const p = (i * W + (j + SHIFT) % W) * 4;
        img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2];
        img.data[p + 3] = 235;
      }
  }
  viewMap.octx.clearRect(0, 0, W, H);
  viewMap.octx.putImageData(img, 0, 0);
  viewMap.render();
  // legend
  const lc = $("legendCanvas").getContext("2d");
  for (let x = 0; x < 280; x++) {
    const c = rampColor(x / 279);
    lc.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
    lc.fillRect(x, 0, 1, 12);
  }
  const lo = Math.max(r.minPos, r.max * 1e-7);
  $("legMin").textContent = logScale ? fmtNum(lo) + " (log)" : "0";
  $("legMax").textContent = fmtNum(r.max) + " mm";
  // stats
  $("vSum").textContent = fmtNum(r.sum);
  $("vMax").textContent = fmtNum(r.max);
  $("vCells").textContent = r.count.toLocaleString();
  $("vMaxLoc").textContent = r.count ? fmtLat(Math.floor(r.maxIdx / W)) + " " + fmtLon(r.maxIdx % W) : "–";
}
viewMap.onHover = (g) => {
  if (!curField) return `${fmtLat(g.i)}, ${fmtLon(g.j)}`;
  const v = fields[curField][g.i * W + g.j];
  return `${fmtLat(g.i)}, ${fmtLon(g.j)}<br><b>${curField}</b>: ${fmtNum(v)} mm`;
};

$("scaleLog").addEventListener("click", () => { logScale = true; segScale(); renderField(); });
$("scaleLin").addEventListener("click", () => { logScale = false; segScale(); renderField(); });
function segScale() {
  $("scaleLog").classList.toggle("active", logScale);
  $("scaleLin").classList.toggle("active", !logScale);
}

/* file loading */
const dz = $("dropzone");
dz.addEventListener("click", () => $("resultFile").click());
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
dz.addEventListener("drop", async (e) => {
  e.preventDefault(); dz.classList.remove("drag");
  const f = e.dataTransfer.files[0];
  if (f) await tryLoad(f);
});
$("resultFile").addEventListener("change", async () => {
  const f = $("resultFile").files[0];
  if (f) await tryLoad(f);
  $("resultFile").value = "";
});
async function tryLoad(f) {
  try { await loadResult(await f.arrayBuffer(), `<b>${f.name}</b> · ${fmtBytes(f.size)} · stays in your browser`); }
  catch (err) { $("fileInfo").innerHTML = `<span class="warn">${err.message}</span>`; }
}

/* bundled real model output: Utrecht source, scheme 4, 2012-07-01 forcing */
$("sampleBtn").addEventListener("click", async () => {
  try {
    $("fileInfo").textContent = "Loading sample…";
    const resp = await fetch("assets/sample_utrecht_4.nc.gz");
    const buf = await new Response(
      resp.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    await loadResult(buf,
      "<b>real model output</b> · Utrecht source, scheme 4 (Lagrangian, 6 h mixing), " +
      "released 2012-07-01 · validation run on one day of ERA5 forcing");
  } catch (err) { $("fileInfo").innerHTML = `<span class="warn">${err.message}</span>`; }
});

/* synthetic demo: a plausible-looking plume, clearly labeled */
$("demoBtn").addEventListener("click", async () => {
  await landReady;
  const alloc = new Float32Array(H * W);
  const released = new Float32Array(H * W);
  // source: Utrecht area
  const si = Math.round((90 - 52.1) / 0.25), sj = Math.round(5.1 / 0.25);
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let p = 0; p < 4000; p++) {
    let i = si + (rnd() - 0.5) * 4, j = sj + (rnd() - 0.5) * 4;
    released[Math.round(si) * W + Math.round(sj)] += 1;
    let load = 1.0;
    const drift = 1.2 + rnd() * 1.6;
    for (let s = 0; s < 260 && load > 0.005; s++) {
      j += drift * (0.7 + 0.6 * Math.sin(s / 30 + p)) + (rnd() - 0.5) * 2.4;
      i += (rnd() - 0.5) * 2.2 + 0.25 * Math.sin(s / 18 + p * 2);
      if (i < 2) i = 2; if (i > H - 3) i = H - 3;
      const ii = Math.round(i), jj = ((Math.round(j) % W) + W) % W;
      const rain = load * (0.02 + 0.05 * rnd()) * (landMask[ii * W + jj] ? 1.4 : 0.8);
      alloc[ii * W + jj] += rain;
      load -= rain;
    }
  }
  fields = { allocated: alloc, released };
  sourceInfo = `<span class="badge">SYNTHETIC DEMO</span> procedurally generated — not model output`;
  $("fileInfo").innerHTML = sourceInfo;
  buildVarChips();
  selectField("allocated");
});

/* PNG export */
$("pngBtn").addEventListener("click", () => {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.drawImage(viewMap.base, 0, 0);
  ctx.drawImage(viewMap.overlay, 0, 0);
  c.toBlob((b) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = `utrack_${curField || "map"}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
});

/* ---------- theme rebuild ---------- */
function onThemeChange() {
  if (!landMask) return;
  const base = buildBaseLayer();
  designMap.base = base; viewMap.base = base; simMap.base = base;
  rebuildDesignOverlay();
  if (curField) renderField(); else viewMap.render();
  renderDeposition(); simMap.render();
}

/* ---------- boot ---------- */
landReady.then(() => {
  const base = buildBaseLayer();
  designMap.base = base; viewMap.base = base; simMap.base = base;
  designMap.fit(); viewMap.fit(); simMap.fit();
  updateFootprint();
  if (location.hash.includes("sim"))
    document.querySelector('[data-tab="sim"]').click();
  if (location.hash.includes("simtest")) {  // synchronous smoke test for CI/screenshots
    simReady.then(() => {
      emitters.push({ gy: 51, gx: 261.5, rate: 5 });  // Kansas
      $("emitterCount").textContent = "1 emitter";
      for (let s = 0; s < 3 * 288; s++) simStep();     // 3 sim-days
      renderDeposition(); simMap.render(); simBudgetUI();
    });
  }
  // deep links: #view opens the results tab, #demo also loads the synthetic demo, #light/#dark force theme
  if (location.hash.includes("light")) setTheme("light");
  if (location.hash.includes("dark")) setTheme("dark");
  if (/view|demo|sample/.test(location.hash))
    document.querySelector('[data-tab="view"]').click();
  if (location.hash.includes("demo")) $("demoBtn").click();
  if (location.hash.includes("sample")) $("sampleBtn").click();
});
