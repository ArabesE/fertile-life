<template>
  <div>
    <div class="toolbar">
      <div class="seg">
        <button @click="togglePlay">{{ playing ? "Pause" : "Play" }}</button>
        <button @click="stepOnce" :disabled="playing">Step</button>
        <button @click="resetAll">Reset</button>
      </div>

      <!-- Speed group (no extra wrapper) -->
      <span class="label" style="margin-left: 0.6rem">Speed</span>
      <input
        type="range"
        min="1"
        max="60"
        v-model.number="speed"
        @input="applySpeed"
      />
      <span class="stat">{{ speed }} steps/s</span>

      <!-- Zoom group (no extra wrapper) -->
      <span class="label" style="margin-left: 1rem">Zoom</span>
      <div class="seg">
        <button @click="zoomOut">−</button>
        <button @click="zoomIn">+</button>
      </div>
      <span class="stat">{{ cellSize.toFixed(1) }} px/cell</span>

      <!-- Params trigger (no extra wrapper) -->
      <details class="params-menu" style="margin-left: 1rem">
        <summary class="btn">Params</summary>
        <div class="params-panel">
          <div class="params-grid">
            <label class="label">f0 (initial fertility)</label>
            <input type="number" step="0.01" v-model.number="params.f0" />

            <label class="label">alpha (death→soil)</label>
            <input type="number" step="0.01" v-model.number="params.alpha" />

            <label class="label">tau (birth threshold)</label>
            <input type="number" step="0.001" v-model.number="params.tau" />

            <label class="label">sigma (survival floor)</label>
            <input type="number" step="0.001" v-model.number="params.sigma" />

            <label class="label">beta (birth cost)</label>
            <input type="number" step="0.01" v-model.number="params.beta" />

            <label class="label">kappa (maintenance)</label>
            <input type="number" step="0.001" v-model.number="params.kappa" />

            <label class="label">d (diffusion)</label>
            <input type="number" step="0.001" v-model.number="params.d" />

            <label class="label">delta (decay)</label>
            <input type="number" step="0.001" v-model.number="params.delta" />

            <label class="label">w0 (self weight)</label>
            <div class="seg">
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                v-model.number="params.w0"
              />
              <span class="stat" style="min-width: 3ch; text-align: right">{{
                params.w0.toFixed(2)
              }}</span>
            </div>

            <label class="label">w1 (neighbor weight)</label>
            <input type="number" :value="w1Display" disabled />
          </div>
        </div>
      </details>

      <!-- Right stats (no extra wrapper) -->
      <span style="margin-left: auto">Generation: {{ generation }}</span>
      <span>Alive: {{ aliveCount }}</span>
    </div>

    <div class="wrap">
      <canvas
        ref="canvas"
        @contextmenu.prevent
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointerleave="onPointerUp"
        @wheel.passive="onWheel"
      ></canvas>
      <div class="hint">
        Left-drag: draw • Alt/Right-drag: erase • Space/Middle: pan • Wheel:
        zoom
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/* Copyright (c) 2025 Loren Bian
  Licensed under the MIT License. See LICENSE file in the project root. */
import {
  onMounted,
  onBeforeUnmount,
  ref,
  reactive,
  watch,
  computed,
} from "vue";

// --- constants
const WIDTH = 200;
const HEIGHT = 200;

// Simulation tunables (UI) with defaults matching worker
const params = reactive({
  f0: 0.7,
  tau: 0.5,
  sigma: 0.1,
  alpha: 1.0,
  beta: 0.4,
  kappa: 0.03,
  d: 0.3,
  delta: 0.008,
  w0: 0.6,
});
const w1Display = computed(() => (1 - params.w0).toFixed(2));

// Keep handler refs to remove later
function onKeyDown(e: KeyboardEvent) {
  if (e.code === "Space") {
    spaceHeld = true;
    e.preventDefault();
    updateCursor();
  }
}
function onKeyUp(e: KeyboardEvent) {
  if (e.code === "Space") {
    spaceHeld = false;
    updateCursor();
  }
}
let onResize = () => {};

const canvas = ref<HTMLCanvasElement | null>(null);
const playing = ref(false);
const speed = ref(20); // steps per second
const generation = ref(0);
const aliveCount = ref(0);

// viewport
const cellSizeMin = 2;
const cellSizeMax = 24;
const cellSize = ref(4); // px per cell
const offsetX = ref(0);
const offsetY = ref(0);

// pan/draw state
let isPanning = false;
let isDrawing = false;
let drawValue: 0 | 1 = 1;
let lastPaintedKey = -1; // avoid repeated setCell for same cell
let spaceHeld = false;

// device pixel ratio & 2D contexts
let dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
let ctx: CanvasRenderingContext2D | null = null;
let backCtx: CanvasRenderingContext2D | null = null;
let backCanvas: HTMLCanvasElement | null = null;

// worker
let worker: Worker | null = null;
let stepTimer: number | null = null;
let stepInFlight = false;

// latest frame from worker
let lastFrame: ImageData | null = null;

// utils
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

function sendParams() {
  if (!worker) return;
  const p = {
    f0: params.f0,
    tau: params.tau,
    sigma: params.sigma,
    alpha: params.alpha,
    beta: params.beta,
    kappa: params.kappa,
    d: params.d,
    delta: params.delta,
    w0: clamp(params.w0, 0, 1),
  };
  worker.postMessage({ type: "setParams", params: p });
}

// push updates whenever UI params change
watch(
  params,
  () => {
    sendParams();
  },
  { deep: true }
);

// --------------------------------------------------- Worker wiring
function initWorker() {
  worker = new Worker(new URL("./simWorker.ts", import.meta.url), {
    type: "module",
  });

  worker.onmessage = (ev: MessageEvent) => {
    const msg = ev.data;
    if (msg.type === "frame") {
      const {
        width,
        height,
        buffer,
        generation: gen,
        alive,
        source, // "init" | "step" | "render" | "reset"
      } = msg as {
        type: "frame";
        width: number;
        height: number;
        buffer: ArrayBuffer;
        generation: number;
        alive: number;
        source: "init" | "step" | "render" | "reset";
      };
      const pixels = new Uint8ClampedArray(buffer);
      lastFrame = new ImageData(pixels, width, height);
      generation.value = gen;
      aliveCount.value = alive;
      if (source === "step") {
        stepInFlight = false;
      }
      requestDraw();
    }
  };

  // Push initial params BEFORE init so the very first frame uses UI defaults
  sendParams();
  worker.postMessage({ type: "init", width: WIDTH, height: HEIGHT });
}

function requestStep() {
  if (!worker || stepInFlight) return;
  stepInFlight = true;
  worker.postMessage({ type: "step" });
}

function requestRender() {
  if (!worker) return;
  worker.postMessage({ type: "render" });
}

function setCell(x: number, y: number, v: 0 | 1) {
  if (!worker) return;
  worker.postMessage({ type: "setCell", x, y, v });
}

function resetAll() {
  pause();
  generation.value = 0;
  aliveCount.value = 0;
  worker?.postMessage({ type: "reset" });
}

// --------------------------------------------------- Play/pause/step
function play() {
  if (playing.value) return;
  playing.value = true;
  applySpeed();
}

function pause() {
  playing.value = false;
  if (stepTimer !== null) {
    clearInterval(stepTimer);
    stepTimer = null;
  }
}

function togglePlay() {
  if (playing.value) pause();
  else play();
}

function stepOnce() {
  if (playing.value) return;
  requestStep();
}

function applySpeed() {
  if (!playing.value) return;
  if (stepTimer !== null) clearInterval(stepTimer);
  const ms = Math.max(1, Math.round(1000 / clamp(speed.value, 1, 60)));
  stepTimer = window.setInterval(() => {
    requestStep();
  }, ms);
}

// --------------------------------------------------- Canvas & drawing
function setupCanvas() {
  if (!canvas.value) return;
  ctx = canvas.value.getContext("2d");
  if (!ctx) return;

  // Back buffer canvas where we drop raw pixels (200x200)
  backCanvas = document.createElement("canvas");
  backCanvas.width = WIDTH;
  backCanvas.height = HEIGHT;
  backCtx = backCanvas.getContext("2d")!;

  onResize = () => {
    if (!canvas.value || !ctx) return;
    const rect = canvas.value.getBoundingClientRect();
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.value.width = Math.floor(rect.width * dpr);
    canvas.value.height = Math.floor(rect.height * dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    draw(); // redraw
  };
  window.addEventListener("resize", onResize, { passive: true });
  onResize();

  // Start centered-ish
  const rect = canvas.value.getBoundingClientRect();
  offsetX.value = Math.floor((rect.width - WIDTH * cellSize.value) / 2);
  offsetY.value = Math.floor((rect.height - HEIGHT * cellSize.value) / 2);

  // Initial render
  requestRender();

  // Key handling for Space-to-pan
  window.addEventListener("keydown", onKeyDown, { passive: false });
  window.addEventListener("keyup", onKeyUp);
}

function updateCursor() {
  if (!canvas.value) return;
  canvas.value.style.cursor = isPanning || spaceHeld ? "grab" : "crosshair";
}

function draw() {
  if (!canvas.value || !ctx) return;
  const w = canvas.value.clientWidth;
  const h = canvas.value.clientHeight;

  // Reset
  ctx.fillStyle = "#0b0d10";
  ctx.fillRect(0, 0, w, h);

  if (!lastFrame || !backCtx || !backCanvas) return;

  // Drop the latest frame into back buffer at native grid size
  backCtx.putImageData(lastFrame, 0, 0);

  // Blit scaled with pan and no smoothing
  ctx.imageSmoothingEnabled = false;
  const scale = cellSize.value;
  ctx.drawImage(
    backCanvas,
    0,
    0,
    WIDTH,
    HEIGHT,
    offsetX.value,
    offsetY.value,
    WIDTH * scale,
    HEIGHT * scale
  );
}

let drawPending = false;
function requestDraw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => {
    drawPending = false;
    draw();
  });
}

// --------------------------------------------------- Interaction helpers
function screenToCell(ev: PointerEvent) {
  const rect = canvas.value!.getBoundingClientRect();
  const x = (ev.clientX - rect.left - offsetX.value) / cellSize.value;
  const y = (ev.clientY - rect.top - offsetY.value) / cellSize.value;
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (cx < 0 || cy < 0 || cx >= WIDTH || cy >= HEIGHT) return null;
  return { cx, cy };
}

let panAnchor = { x: 0, y: 0 };
let panOffsetStart = { x: 0, y: 0 };

function onPointerDown(ev: PointerEvent) {
  if (!canvas.value) return;
  (ev.target as HTMLElement).setPointerCapture(ev.pointerId);

  // Pan with middle button or while Space is held (not right button)
  const panBtn = ev.button === 1 || spaceHeld;
  if (panBtn) {
    isPanning = true;
    panAnchor = { x: ev.clientX, y: ev.clientY };
    panOffsetStart = { x: offsetX.value, y: offsetY.value };
    updateCursor();
    return;
  }

  // Draw mode
  isDrawing = true;
  drawValue = ev.button === 2 || ev.altKey ? 0 : 1;
  const hit = screenToCell(ev);
  if (hit) {
    lastPaintedKey = hit.cy * WIDTH + hit.cx;
    setCell(hit.cx, hit.cy, drawValue);
    requestRender();
  }
}

function onPointerMove(ev: PointerEvent) {
  if (isPanning) {
    offsetX.value = panOffsetStart.x + (ev.clientX - panAnchor.x);
    offsetY.value = panOffsetStart.y + (ev.clientY - panAnchor.y);
    requestDraw();
    return;
  }
  if (!isDrawing) return;
  const hit = screenToCell(ev);
  if (hit) {
    const key = hit.cy * WIDTH + hit.cx;
    if (key !== lastPaintedKey) {
      lastPaintedKey = key;
      setCell(hit.cx, hit.cy, drawValue);
      requestRender();
    }
  }
}

function onPointerUp(ev: PointerEvent) {
  if (!canvas.value) return;
  (ev.target as HTMLElement).releasePointerCapture?.(ev.pointerId);
  isPanning = false;
  isDrawing = false;
  lastPaintedKey = -1;
  updateCursor();
}

function onWheel(ev: WheelEvent) {
  const rect = canvas.value!.getBoundingClientRect();
  const mouseX = ev.clientX - rect.left;
  const mouseY = ev.clientY - rect.top;

  // world position before zoom
  const worldX = (mouseX - offsetX.value) / cellSize.value;
  const worldY = (mouseY - offsetY.value) / cellSize.value;

  const delta = Math.sign(ev.deltaY);
  const step = 0.25;
  const newSize = clamp(
    cellSize.value + (delta < 0 ? step : -step),
    cellSizeMin,
    cellSizeMax
  );
  if (newSize === cellSize.value) return;

  cellSize.value = newSize;

  // keep cursor position stable
  offsetX.value = mouseX - worldX * cellSize.value;
  offsetY.value = mouseY - worldY * cellSize.value;

  requestDraw();
}

function zoomIn() {
  cellSize.value = clamp(cellSize.value + 0.5, cellSizeMin, cellSizeMax);
  requestDraw();
}
function zoomOut() {
  cellSize.value = clamp(cellSize.value - 0.5, cellSizeMin, cellSizeMax);
  requestDraw();
}

// --------------------------------------------------- lifecycle
onMounted(() => {
  initWorker();
  setupCanvas();
});

onBeforeUnmount(() => {
  pause();
  worker?.terminate();
  worker = null;
  window.removeEventListener("resize", onResize);
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("keyup", onKeyUp);
});
</script>
