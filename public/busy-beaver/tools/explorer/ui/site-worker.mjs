// bbchallenge.org's own drawing code (tools/vizref/lib, verified against the site) in a module worker.
// Job: {id, mode:'default'|'explore'|'blaze', tm, tape, steps, theme, quality, stretch, noHead, width, ox}
// Reply: {id, rgba (transferred), w, h, status, rows}
import { machineCodeToTM, tmToMachineCode, traceImageData, exploreFillRects, defaultPaletteBytes } from '../../vizref/lib/bbchallenge_tm.mjs';
import { newCanvas, fillRect, drawImageBilinear, drawImageNearest, flattenOver } from '../../vizref/lib/canvas.mjs';
import { blazePort } from '../../vizref/lib/blaze_port.mjs';

const SLATE_800 = [0x1e, 0x29, 0x3b];
const fmt = (n) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function run(job) {
  const code = job.tm.trim().toUpperCase();
  const machine = machineCodeToTM(code);
  if (job.mode === 'default') {
    const height = Math.min(99999, Math.max(1, job.steps | 0));
    const img = traceImageData(machine, job.tape || '0', job.width || 400, height, job.ox ?? 0.5, !job.noHead);
    const cv = newCanvas(400, 500, [0, 0, 0, 255]);
    drawImageBilinear(cv, img, 0, 0, 400, 500);
    const last = img.history_length - 1;
    return { rgba: cv.data, w: 400, h: 500, status: `Steps: ${fmt(height)} • ${last < height ? 'Halted' : 'Not Halted'}`, rows: height, trace: { w: img.width, h: img.height } };
  }
  if (job.mode === 'explore') {
    const height = Math.min(99999, Math.max(1, job.steps | 0));
    const { rects, history_length } = exploreFillRects(machine, job.tape || '0', height, 800, 500, 10, 400, 0);
    let cv = newCanvas(800, 500, [0, 0, 0, 0]);
    for (const r of rects) fillRect(cv, 400 + 10 * r.col, 10 * r.row, 400 + 10 * (r.col + 1), 10 * (r.row + 1), r.rgb);
    cv = flattenOver(cv, SLATE_800);
    return { rgba: cv.data, w: 800, h: 500, status: `Steps: ${fmt(height)} (rows 0–49 visible)`, rows: history_length };
  }
  const dark = job.theme === 'dark';
  const r = blazePort(tmToMachineCode(machine), { stepCount: Math.max(2, job.steps | 0), canvasW: 800, canvasH: 500, binning: job.quality !== false, colors: defaultPaletteBytes(dark) });
  const src = { width: r.width, height: r.height, data: new Uint8ClampedArray(r.width * r.height * 4) };
  for (let i = 0; i < r.width * r.height; i++) { src.data[4 * i] = r.rgb[3 * i]; src.data[4 * i + 1] = r.rgb[3 * i + 1]; src.data[4 * i + 2] = r.rgb[3 * i + 2]; src.data[4 * i + 3] = 255; }
  const cv = newCanvas(800, 500, dark ? [0, 0, 0, 255] : [255, 255, 255, 255]);
  if (job.stretch !== false || (r.width >= 800 && r.height >= 500)) drawImageNearest(cv, src, 0, 0, 800, 500);
  else { const sc = Math.min(500 / r.height, 800 / r.width); drawImageNearest(cv, src, (800 - r.width * sc) / 2, (500 - r.height * sc) / 2, r.width * sc, r.height * sc); }
  return { rgba: cv.data, w: 800, h: 500, status: `Steps: ${fmt(r.steps)} • Nonzeros: ${fmt(r.nonzeros)} • ${r.halted ? 'Halted' : 'Not Halted'}`, rows: r.steps, raw: { w: r.width, h: r.height } };
}

self.onmessage = (e) => {
  const job = e.data;
  try {
    const out = run(job);
    self.postMessage({ id: job.id, ...out }, [out.rgba.buffer]);
  } catch (err) {
    self.postMessage({ id: job.id, error: String(err && err.message || err) });
  }
};
