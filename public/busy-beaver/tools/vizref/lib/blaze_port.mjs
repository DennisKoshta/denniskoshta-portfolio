// Pure-JS port of the Blaze space-time compressor (CarlKCarlK/busy_beaver_blaze @ 912d3d2,
// the build bbchallenge.org ships). Written from the Rust source to check that atlas/viz-spec.md
// describes the algorithm correctly; selftest.mjs compares it with the real WASM.
// File references: src/machine.rs, tape.rs, space_by_time_machine.rs, space_by_time.rs,
// spacelines.rs, spaceline.rs, pixel.rs, lib.rs (find_x_stride, find_y_stride,
// average_with_iterators, sample_with_iterators, compress_packed_data_if_one_too_big, encode_png).

const mean = (a, b) => (a & b) + ((a ^ b) >> 1); // pixel.rs Pixel::mean_bytes = floor((a+b)/2)

// ---- machine.rs / tape.rs ------------------------------------------------------------
export function parseStandard(code) {
	const groups = code.trim().split('_');
	const states = groups.length;
	const symbols = groups[0].length / 3;
	const table = groups.map((g) => {
		const row = [];
		for (let s = 0; s < symbols; s++) {
			const t = g.slice(3 * s, 3 * s + 3);
			if (t === '---') row.push({ write: 0, dir: -1, next: 25 }); // machine.rs parse_action
			else row.push({ write: +t[0], dir: t[1] === 'L' ? -1 : 1, next: t.charCodeAt(2) - 65 });
		}
		return row;
	});
	return { states, symbols, table };
}

class Tape {
	constructor() { this.neg = []; this.nonneg = [0]; }
	read(i) { return i >= 0 ? (this.nonneg[i] ?? 0) : (this.neg[-i - 1] ?? 0); }
	write(i, v) { if (i >= 0) this.nonneg[i] = v; else this.neg[-i - 1] = v; } // never more than 1 past the end
}

class Machine {
	constructor(code) { this.p = parseStandard(code); this.tape = new Tape(); this.idx = 0; this.state = 0; }
	next() { // returns previous tape index, or null when the transition taken halts
		const a = this.p.table[this.state][this.tape.read(this.idx)];
		this.tape.write(this.idx, a.write);
		const prev = this.idx;
		this.idx += a.dir;
		this.state = a.next;
		return this.state < this.p.states ? prev : null;
	}
	nonblanks() { return [...this.tape.neg, ...this.tape.nonneg].filter((x) => x !== 0).length; }
}

// ---- lib.rs ----------------------------------------------------------------------------
const ceilDiv = (n, s) => Math.ceil(n / s);
export function findXStride(negLen, nonnegLen, xGoal) {
	if (negLen + nonnegLen < xGoal) return 1;
	for (let s = 1; ; s *= 2) {
		const len = ceilDiv(negLen, s) + ceilDiv(nonnegLen, s);
		if (xGoal <= len && len < 2 * xGoal) return s;
	}
}
export function findYStride(len, yGoal) {
	const thr = 2 * yGoal;
	const ratio = Math.floor((len + thr) / thr); // = ceil((len+1)/thr)
	let s = 1;
	while (s < ratio) s *= 2;
	return s;
}

// ---- spaceline.rs ------------------------------------------------------------------------
function layerPixels(part, select, xs, binning) {
	const out = [];
	for (let start = 0; start < part.length; start += xs) {
		if (binning) {
			let n = 0;
			for (let i = start; i < Math.min(part.length, start + xs); i++) n += part[i] === select ? 1 : 0;
			out.push(Math.floor((n * 255) / xs)); // divide by the full stride, also for the last partial chunk
		} else out.push(part[start] === select ? 255 : 0); // first cell of the chunk
	}
	return out;
}
function newLine(select, tape, xGoal, time, binning) {
	const xs = findXStride(tape.neg.length, tape.nonneg.length, xGoal);
	return { xs, neg: layerPixels(tape.neg, select, xs, binning), nonneg: layerPixels(tape.nonneg, select, xs, binning), time };
}
const cloneLine = (l) => ({ xs: l.xs, neg: l.neg.slice(), nonneg: l.nonneg.slice(), time: l.time });
function compressX(px, binning) {
	const out = [];
	for (let i = 0; i + 1 < px.length; i += 2) out.push(binning ? mean(px[i], px[i + 1]) : px[i]);
	if (px.length % 2) out.push(binning ? px[px.length - 1] >> 1 : px[px.length - 1]); // odd tail: mean with white / kept
	return out;
}
function compressXTo(l, xs, binning) {
	while (l.xs < xs) { l.nonneg = compressX(l.nonneg, binning); l.neg = compressX(l.neg, binning); l.xs *= 2; }
}
function mergeLines(a, b, binning) { // a earlier, b later; Spaceline::merge_simd (binning only)
	compressXTo(a, b.xs, binning);
	for (const k of ['neg', 'nonneg']) {
		while (a[k].length < b[k].length) a[k].push(0);
		for (let i = 0; i < a[k].length; i++) a[k][i] = mean(a[k][i], b[k][i]);
	}
}

// ---- spacelines.rs / space_by_time.rs ----------------------------------------------------
class Layer {
	constructor(select, tape, xGoal, yGoal, binning) {
		Object.assign(this, { select, xGoal, yGoal, binning, vis: 0, ys: 1, prev: null });
		this.main = [newLine(select, tape, xGoal, 0, binning)];
		this.buf = [];
	}
	pushInternal(buf, line, w) {
		while (buf.length) {
			const [, lw] = buf[buf.length - 1];
			if (w < lw) { buf.push([line, w]); return; }
			const [last, lw2] = buf.pop();
			if (this.binning) mergeLines(last, line, true);
			line = last; // sampling keeps the earlier line
			w = 2 * lw2;
			if (!buf.length) { buf.push([line, w]); return; }
		}
		buf.push([line, w]);
	}
	flush() {
		if (this.buf.length) this.main.push(this.buf.pop()[0]);
		const s = findYStride(this.vis, this.yGoal);
		if (s !== this.ys) {
			this.ys = s;
			if (this.binning) {
				const m = [];
				for (let i = 0; i < this.main.length; i += 2) { mergeLines(this.main[i], this.main[i + 1], true); m.push(this.main[i]); }
				this.main = m;
			} else this.main = this.main.filter((l) => l.time % s === 0);
		}
	}
	snapshot(m, prevIdx) {
		this.vis += 1;
		const inside = this.vis % this.ys;
		if (this.binning) {
			if (inside === 0) this.flush();
			let line = null;
			if (this.prev) { // Spaceline::redo_pixel: same x-stride => only the written cell's pixel changes
				const xs = findXStride(m.tape.neg.length, m.tape.nonneg.length, this.xGoal);
				if (xs === this.prev.xs) {
					line = this.prev;
					line.time = this.vis;
					const [part, px, pi] = prevIdx < 0 ? [m.tape.neg, line.neg, -prevIdx - 1] : [m.tape.nonneg, line.nonneg, prevIdx];
					const j = Math.floor(pi / xs);
					if (j === px.length) px.push(0);
					let n = 0;
					for (let i = j * xs; i < Math.min(part.length, j * xs + xs); i++) n += part[i] === this.select ? 1 : 0;
					px[j] = Math.floor((n * 255) / xs);
				}
			}
			if (!line) line = newLine(this.select, m.tape, this.xGoal, this.vis, true);
			this.prev = cloneLine(line);
			this.pushInternal(this.buf, line, 1);
		} else {
			if (inside !== 0) return;
			this.flush();
			this.pushInternal(this.buf, newLine(this.select, m.tape, this.xGoal, this.vis, false), this.ys);
		}
	}
	lastLine() {
		if (!this.buf.length) return cloneLine(this.main[this.main.length - 1]);
		if (!this.binning) return cloneLine(this.buf[0][0]);
		const buf = this.buf.map(([l, w]) => [cloneLine(l), w]);
		for (;;) {
			const [l, w] = buf.pop();
			if (!buf.length && w === this.ys) return l;
			l.neg = l.neg.map((v) => v >> 1); // merge_with_white: missing time counts as blank
			l.nonneg = l.nonneg.map((v) => v >> 1);
			this.pushInternal(buf, l, 2 * w);
		}
	}
	packed(negLen, nonnegLen, goalW, goalH) { // SpaceByTime::to_packed_data
		const xs = findXStride(negLen, nonnegLen, goalW);
		const x0 = ceilDiv(negLen, xs), W = x0 + ceilDiv(nonnegLen, xs);
		const rows = this.main.length + (this.buf.length ? 1 : 0);
		for (const [l] of this.buf) compressXTo(l, xs, this.binning); // in place, as in Rust
		for (const l of this.main) compressXTo(l, xs, this.binning);
		const last = this.lastLine();
		let data = new Uint8Array(W * rows);
		for (let y = 0; y < rows; y++) {
			const l = y === rows - 1 ? last : this.main[y];
			l.neg.forEach((v, i) => { if (v) data[y * W + x0 - i - 1] = v; });
			l.nonneg.forEach((v, i) => { if (v) data[y * W + x0 + i] = v; });
		}
		let H = rows;
		if (rows >= 2 * goalH) { // compress_packed_data_if_one_too_big
			const d2 = new Uint8Array(W * goalH);
			for (let y = 0; y < goalH; y++) for (let x = 0; x < W; x++) {
				const a = data[2 * y * W + x], b = data[(2 * y + 1) * W + x];
				d2[y * W + x] = this.binning ? mean(a, b) : a;
			}
			data = d2;
			H = goalH;
		}
		return { W, H, data };
	}
}

/** Returns {width, height, rgb (Uint8Array), steps, nonzeros, halted} like SpaceByTimeMachine + to_png. */
export function blazePort(code, { stepCount = 10000, canvasW = 800, canvasH = 500, binning = true, colors }) {
	const m = new Machine(code);
	const layers = [];
	for (let sel = 1; sel < m.p.symbols; sel++) layers.push(new Layer(sel, m.tape, canvasW, canvasH, binning));
	let halted = false;
	let stepIndex = 0; // step_count() = stepIndex + 1; the run stops when step_count reaches stepCount
	while (stepIndex + 1 < stepCount) {
		const prev = m.next();
		if (prev === null) { halted = true; break; }
		stepIndex++;
		for (const L of layers) L.snapshot(m, prev);
	}
	const packs = layers.map((L) => L.packed(m.tape.neg.length, m.tape.nonneg.length, canvasW, canvasH));
	const { W, H } = packs[0];
	// encode_png colour mixing; palette: colour 0, then colours[1..] cycled, length = symbol count
	const pal = [];
	for (let i = 0; i < colors.length / 3; i++) pal.push([colors[3 * i], colors[3 * i + 1], colors[3 * i + 2]]);
	const cols = [pal[0]];
	for (let k = 0; cols.length < m.p.symbols; k++) cols.push(pal[1 + (k % (pal.length - 1))]);
	const rgb = new Uint8Array(W * H * 3);
	for (let p = 0; p < W * H; p++) {
		const ch = [0, 0, 0];
		let w0 = 255;
		packs.forEach((pk, li) => {
			const w = pk.data[p];
			w0 = Math.max(0, w0 - w);
			for (let c = 0; c < 3; c++) ch[c] += cols[li + 1][c] * w;
		});
		for (let c = 0; c < 3; c++) rgb[3 * p + c] = Math.min(255, Math.floor((ch[c] + cols[0][c] * w0) / 255));
	}
	return { width: W, height: H, rgb, steps: stepIndex + 1, nonzeros: m.nonblanks(), halted };
}
