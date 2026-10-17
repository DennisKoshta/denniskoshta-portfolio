// Tiny software stand-in for the few HTML-canvas operations bbchallenge.org uses.
// All buffers are RGBA Uint8ClampedArray, non-premultiplied (like ImageData).
//
// Fidelity notes (see atlas/viz-spec.md "Browser-dependent steps"):
//  - drawImageBilinear models Chrome/Skia's default canvas smoothing (imageSmoothingQuality
//    'low' = plain 2x2 bilinear, no mipmaps, pixel-centre mapping, clamp at edges). This is
//    what Default mode's 400xN -> 400x500 squeeze goes through. Channel values may differ by 1
//    from a real browser because of rounding.
//  - drawImageNearest models imageSmoothingEnabled=false (Blaze): source pixel =
//    floor((d + 0.5) * src/dst) relative to the destination rectangle.

export function newCanvas(w, h, rgba = [0, 0, 0, 0]) {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let i = 0; i < w * h; i++) data.set(rgba, 4 * i);
	return { width: w, height: h, data };
}

// Source-over composite of one non-premultiplied pixel with coverage `cov` in [0,1].
function blendPixel(dst, i, r, g, b, a, cov = 1) {
	const sa = (a / 255) * cov;
	if (sa <= 0) return;
	const da = dst[i + 3] / 255;
	const oa = sa + da * (1 - sa);
	if (oa <= 0) {
		dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 0;
		return;
	}
	dst[i] = Math.round((r * sa + dst[i] * da * (1 - sa)) / oa);
	dst[i + 1] = Math.round((g * sa + dst[i + 1] * da * (1 - sa)) / oa);
	dst[i + 2] = Math.round((b * sa + dst[i + 2] * da * (1 - sa)) / oa);
	dst[i + 3] = Math.round(oa * 255);
}

/** ctx.fillRect in device space with analytic edge coverage (exact for integer rects). */
export function fillRect(cv, x0, y0, x1, y1, rgb, alpha = 255) {
	const xa = Math.max(0, Math.floor(x0)), xb = Math.min(cv.width, Math.ceil(x1));
	const ya = Math.max(0, Math.floor(y0)), yb = Math.min(cv.height, Math.ceil(y1));
	for (let y = ya; y < yb; y++) {
		const cy = Math.min(y + 1, y1) - Math.max(y, y0);
		if (cy <= 0) continue;
		for (let x = xa; x < xb; x++) {
			const cx = Math.min(x + 1, x1) - Math.max(x, x0);
			if (cx <= 0) continue;
			blendPixel(cv.data, 4 * (y * cv.width + x), rgb[0], rgb[1], rgb[2], alpha, Math.min(1, cx * cy));
		}
	}
}

/** drawImage(src, 0,0,sw,sh, dx,dy,dw,dh) with imageSmoothingEnabled = true (bilinear). */
export function drawImageBilinear(cv, src, dx, dy, dw, dh) {
	const sx = src.width / dw, sy = src.height / dh;
	const s = src.data;
	const at = (x, y) => 4 * (Math.min(src.height - 1, Math.max(0, y)) * src.width + Math.min(src.width - 1, Math.max(0, x)));
	const ya = Math.max(0, Math.ceil(dy - 0.5)), yb = Math.min(cv.height, Math.floor(dy + dh - 0.5) + 1);
	const xa = Math.max(0, Math.ceil(dx - 0.5)), xb = Math.min(cv.width, Math.floor(dx + dw - 0.5) + 1);
	for (let y = ya; y < yb; y++) {
		const fy = (y + 0.5 - dy) * sy - 0.5;
		const y0 = Math.floor(fy), wy = fy - y0;
		for (let x = xa; x < xb; x++) {
			const fx = (x + 0.5 - dx) * sx - 0.5;
			const x0 = Math.floor(fx), wx = fx - x0;
			// premultiplied bilinear
			let r = 0, g = 0, b = 0, a = 0;
			const taps = [
				[at(x0, y0), (1 - wx) * (1 - wy)],
				[at(x0 + 1, y0), wx * (1 - wy)],
				[at(x0, y0 + 1), (1 - wx) * wy],
				[at(x0 + 1, y0 + 1), wx * wy]
			];
			for (const [i, w] of taps) {
				if (w === 0) continue;
				const al = s[i + 3] / 255;
				r += s[i] * al * w;
				g += s[i + 1] * al * w;
				b += s[i + 2] * al * w;
				a += al * w;
			}
			if (a <= 0) continue;
			blendPixel(cv.data, 4 * (y * cv.width + x), r / a, g / a, b / a, a * 255);
		}
	}
}

/**
 * drawImage(...) with imageSmoothingEnabled = false (nearest neighbour).
 * subtexel = 256 snaps the sample coordinate to 1/256 texel before flooring, like GPU texture
 * sampling. This reproduced the two boundary columns where plain floor() disagreed with a Chrome
 * screenshot (Bigfoot Blaze, 118 px -> 800 px: canvas columns 230 and 630). Pass 0 to disable.
 */
export function drawImageNearest(cv, src, dx, dy, dw, dh, subtexel = 256) {
	const sx = src.width / dw, sy = src.height / dh;
	const s = src.data;
	const q = (u) => (subtexel ? Math.floor(Math.round(u * subtexel) / subtexel) : Math.floor(u));
	for (let y = Math.max(0, Math.ceil(dy - 0.5)); y < Math.min(cv.height, Math.floor(dy + dh - 0.5) + 1); y++) {
		const yy = Math.min(src.height - 1, q((y + 0.5 - dy) * sy));
		for (let x = Math.max(0, Math.ceil(dx - 0.5)); x < Math.min(cv.width, Math.floor(dx + dw - 0.5) + 1); x++) {
			const xx = Math.min(src.width - 1, q((x + 0.5 - dx) * sx));
			const i = 4 * (yy * src.width + xx);
			blendPixel(cv.data, 4 * (y * cv.width + x), s[i], s[i + 1], s[i + 2], s[i + 3]);
		}
	}
}

/** Composite a canvas over an opaque CSS background colour (what the viewer sees). */
export function flattenOver(cv, rgb) {
	const out = newCanvas(cv.width, cv.height, [rgb[0], rgb[1], rgb[2], 255]);
	for (let i = 0; i < cv.width * cv.height; i++) {
		const d = cv.data;
		blendPixel(out.data, 4 * i, d[4 * i], d[4 * i + 1], d[4 * i + 2], d[4 * i + 3]);
	}
	return out;
}
