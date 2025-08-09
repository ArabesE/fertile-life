/// <reference lib="WebWorker" />
// Fertile Life simulation worker: keeps UI smooth

type InitMsg = { type: "init"; width: number; height: number };
type StepMsg = { type: "step" };
type RenderMsg = { type: "render" };
type SetCellMsg = { type: "setCell"; x: number; y: number; v: 0 | 1 };
type ClearMsg = { type: "clear" };
type InMsg = InitMsg | StepMsg | RenderMsg | SetCellMsg | ClearMsg;
type FrameSource = "init" | "step" | "render" | "clear";

// Initialization flag
let initialized = false;

// Grid
let W = 0,
  H = 0,
  N = 0;
let A: Uint8Array = new Uint8Array(0); // alive 0/1
let F: Float32Array = new Float32Array(0); // fertility
let A2: Uint8Array = new Uint8Array(0); // next alive (double buffer)
let gen = 0;
// Reused neighbor buffers (perf)
let Fsum: Float32Array = new Float32Array(0);
let Nsum: Uint8Array = new Uint8Array(0);

// Tunable parameters (good defaults)
const alpha = 1.2; // soil from death
const tau = 0.55; // birth fertility threshold
const sigma = 0.08; // survival soil floor
const beta = 0.6; // birth cost
const kappa = 0.04; // survival maintenance
const d = 0.3; // diffusion
const delta = 0.008; // decay
const w0 = 0.6,
  w1 = 0.4; // effective soil mix

// Visualization
const F_VIS_CAP = 1.5; // clamp fertility for color
const DEAD_SOIL_TINT: [number, number, number] = [30, 26, 18]; // soil base tint (brownish)
const SOIL_TINT_SCALE = [0.0, 0.75, 0.2]; // add a hint of green
const LIVE_COLOR: [number, number, number] = [230, 255, 230];

function idx(x: number, y: number) {
  return y * W + x;
}

function ensureArrays(width: number, height: number) {
  W = width;
  H = height;
  N = W * H;
  A = new Uint8Array(N);
  F = new Float32Array(N);
  A2 = new Uint8Array(N);
  // allocate reusable neighbor buffers
  Fsum = new Float32Array(N);
  Nsum = new Uint8Array(N);
  gen = 0;
  initialized = true;
}

function step() {
  const Wm1 = W - 1,
    Hm1 = H - 1;

  // reuse preallocated buffers for neighbor count and neighbor F sum
  // For speed, compute in one pass

  // Vertical row indices w/ wrap
  for (let y = 0; y < H; y++) {
    const yu = y === 0 ? Hm1 : y - 1;
    const yd = y === Hm1 ? 0 : y + 1;

    for (let x = 0; x < W; x++) {
      const xl = x === 0 ? Wm1 : x - 1;
      const xr = x === Wm1 ? 0 : x + 1;

      // neighbors coords
      const p0 = idx(xl, yu),
        p1 = idx(x, yu),
        p2 = idx(xr, yu);
      const p3 = idx(xl, y),
        p5 = idx(xr, y);
      const p6 = idx(xl, yd),
        p7 = idx(x, yd),
        p8 = idx(xr, yd);

      const i = idx(x, y);

      const n = A[p0] + A[p1] + A[p2] + A[p3] + A[p5] + A[p6] + A[p7] + A[p8];

      Nsum[i] = n;

      const fs = F[p0] + F[p1] + F[p2] + F[p3] + F[p5] + F[p6] + F[p7] + F[p8];

      Fsum[i] = fs;
    }
  }

  // Decide transitions using effective fertility
  let aliveNext = 0;
  for (let i = 0; i < N; i++) {
    const n = Nsum[i];
    const favg = Fsum[i] * (1 / 8);
    const E = w0 * F[i] + w1 * favg;

    const a = A[i];
    const birth = a === 0 && n === 3 && E >= tau;
    const survive = a === 1 && (n === 2 || n === 3) && E >= sigma;
    const aNext = birth || survive ? 1 : 0;

    A2[i] = aNext;
    if (aNext) aliveNext++;

    // Soil bookkeeping: death->soil, costs for birth/survival
    if (a === 1 && aNext === 0) {
      F[i] += alpha;
    }
    if (a === 0 && aNext === 1) {
      F[i] = Math.max(0, F[i] - beta);
    }
    if (a === 1 && aNext === 1) {
      F[i] = Math.max(0, F[i] - kappa);
    }
  }

  // Diffuse & decay
  for (let i = 0; i < N; i++) {
    const favg = Fsum[i] * (1 / 8);
    F[i] = Math.max(0, (F[i] + d * (favg - F[i])) * (1 - delta));
  }

  // Swap buffers
  const tmp = A;
  A = A2;
  A2 = tmp;

  gen++;
  return aliveNext;
}

function renderFrame() {
  // Build RGBA pixels for current A & F
  const out = new Uint8ClampedArray(N * 4);

  for (let i = 0; i < N; i++) {
    let r = 0,
      g = 0,
      b = 0;
    // Soil underlay
    const t = Math.min(F[i] / F_VIS_CAP, 1);
    // quick gamma for contrast
    const c = Math.sqrt(t);
    r = DEAD_SOIL_TINT[0] + Math.round(SOIL_TINT_SCALE[0] * 255 * c);
    g = DEAD_SOIL_TINT[1] + Math.round(SOIL_TINT_SCALE[1] * 255 * c);
    b = DEAD_SOIL_TINT[2] + Math.round(SOIL_TINT_SCALE[2] * 255 * c);

    if (A[i] === 1) {
      // alive overlay
      r = LIVE_COLOR[0];
      g = LIVE_COLOR[1];
      b = LIVE_COLOR[2];
    }

    const j = i * 4;
    out[j + 0] = r;
    out[j + 1] = g;
    out[j + 2] = b;
    out[j + 3] = 255;
  }
  return out;
}

function postFrame(aliveCount: number, source: FrameSource) {
  const pixels = renderFrame();
  // Transfer the buffer for speed
  self.postMessage(
    {
      type: "frame",
      source,
      width: W,
      height: H,
      generation: gen,
      alive: aliveCount,
      buffer: pixels.buffer,
    },
    [pixels.buffer]
  );
}

self.onmessage = (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  switch (msg.type) {
    case "init": {
      ensureArrays(msg.width, msg.height);
      postFrame(0, "init");
      break;
    }
    case "step": {
      if (!initialized) break;
      const alive = step();
      postFrame(alive, "step");
      break;
    }
    case "render": {
      if (!initialized) break;
      postFrame(
        A.reduce((s, v) => s + v, 0),
        "render"
      );
      break;
    }
    case "setCell": {
      if (!initialized) break;
      const { x, y, v } = msg;
      if (x >= 0 && y >= 0 && x < W && y < H) {
        A[idx(x, y)] = v;
      }
      break;
    }
    case "clear": {
      if (!initialized) break;
      A.fill(0);
      F.fill(0);
      gen = 0;
      postFrame(0, "clear");
      break;
    }
  }
};
