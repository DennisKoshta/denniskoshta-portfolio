// Port of the rendering-relevant parts of bbchallenge.org's front end.
// Source: github.com/bbchallenge/bbchallenge @ 7d11ec7 (2026-09-29), file src/lib/tm.ts.
// Deployed bundle checked identical in logic: /_app/immutable/chunks/tm.49c7e91d.js (fetched 2026-10-09).
// Functions are copied verbatim (TypeScript annotations removed). DOM calls are replaced by
// pure pixel-buffer code in canvas.mjs; the per-pixel logic here is unchanged.

export function machineCodeToTM(machineCode) {
	// tm.ts machineCodeToTM (the page calls it after machine_code.trim().toUpperCase())
	const len_with_underscores = machineCode.length;
	machineCode = machineCode.replaceAll('_', '');
	const states = len_with_underscores - machineCode.length + 1;
	if (machineCode.length % (3 * states) !== 0) throw 'Invalid TM code.';
	const symbols = machineCode.length / (3 * states);

	const tm = { states: states, symbols: symbols, code: new Uint8Array(machineCode.length) };
	for (let i = 0; 3 * i < machineCode.length; i++) {
		tm.code[3 * i + 0] = parseInt(machineCode[3 * i + 0]); // Write symbol
		tm.code[3 * i + 1] = machineCode[3 * i + 1] == 'L' ? 1 : 0; // Direction
		tm.code[3 * i + 2] = machineCode[3 * i + 2] == '-' ? 0 : 1 + machineCode.charCodeAt(3 * i + 2) - 65; // Goto state
	}
	return tm;
}

export function tmToMachineCode(machine) {
	let to_return = '';
	for (let q = 0; q < machine.states; q += 1) {
		for (let s = 0; s < machine.symbols; s += 1) {
			const t = machine.code.slice(3 * (q * machine.symbols + s), 3 * (q * machine.symbols + s + 1));
			if (t[2] == 0) to_return += '---';
			else to_return += String.fromCharCode(48 + t[0]) + (t[1] == 0 ? 'R' : 'L') + String.fromCharCode(65 + (t[2] - 1));
		}
		if (q < machine.states - 1) to_return += '_';
	}
	return to_return;
}

// tm.ts defaultPaletteBytes(isDark): palette handed to the Blaze WASM to_png().
export function defaultPaletteBytes(isDark) {
	if (isDark) {
		return new Uint8Array([
			255, 255, 255, // white (symbol 0)
			0, 0, 0, // black (symbol 1)
			128, 128, 128, // 50% gray (symbol 2)
			64, 64, 64, // 25% gray (symbol 3)
			192, 192, 192 // 75% gray (symbol 4)
		]);
	}
	return new Uint8Array([
		255, 255, 255, // white (symbol 0)
		255, 165, 0, // orange (symbol 1)
		255, 255, 0, // yellow (symbol 2)
		255, 0, 255, // magenta (symbol 3)
		0, 255, 255 // cyan (symbol 4)
	]);
}

// tm.ts colorList: Explore-mode head colour, indexed by state (A..G). States >= 7 get no head colour.
export const colorList = [
	[255, 0, 0],
	[255, 128, 0],
	[0, 0, 255],
	[0, 255, 0],
	[255, 0, 255],
	[0, 255, 255],
	[255, 255, 0]
];

// Tape cells are stored in a JS array indexed by the "natural" interleaving 0,-1,1,-2,2,...
export function intToNatural(n) {
	return n < 0 ? -n * 2 - 1 : n * 2;
}
export function naturalToInt(n) {
	return n % 2 == 0 ? n / 2 : -(n + 1) / 2;
}

export function parse_initial_tape(machine, initial_tape) {
	const raw_tape = [];
	let state = 0;
	let pos = 0;

	for (let i = 0; i < initial_tape.length; i++) {
		const c = initial_tape.charCodeAt(i);
		if (48 <= c && c < 48 + machine.symbols) {
			raw_tape.push(c - 48);
		} else if ((65 <= c && c < 65 + machine.states) || (97 <= c && c < 97 + machine.states)) {
			state = (c - 1) % 32;
			pos = raw_tape.length;
		}
	}

	const tape = [];
	for (let i = 0; i < raw_tape.length; i++) {
		tape[intToNatural(i - pos)] = raw_tape[i];
	}

	return { tape, state };
}

export function render_history(machine, initial_tape = '0', height = 1000) {
	const history = [];

	let { tape, state: curr_state } = parse_initial_tape(machine, initial_tape);
	let curr_pos = 0;
	history.push({ tape, curr_state, curr_pos });

	for (let row = 0; row < height; row += 1) {
		tape = [...tape];
		[curr_state, curr_pos] = step(machine, curr_state, curr_pos, tape);
		history.push({ tape, curr_pos, curr_state });
		if (curr_state === null || curr_state >= machine.states) {
			break;
		}
	}
	return history;
}

export function step(machine, curr_state, curr_pos, tape, use_int_positions = false) {
	function identity(x) {
		return x;
	}

	const f = use_int_positions ? identity : intToNatural;

	if (tape[f(curr_pos)] === undefined) {
		tape[f(curr_pos)] = 0;
	}

	const i = 3 * (curr_state * machine.symbols + tape[f(curr_pos)]);
	const write = machine.code[i];
	const move = machine.code[i + 1];
	const goto = machine.code[i + 2] - 1;

	if (goto == -1) return [null, null];

	tape[f(curr_pos)] = write;
	const next_pos = curr_pos + (move ? -1 : 1);
	return [goto, next_pos];
}

/**
 * Default mode, part 1: tm.ts tm_trace_to_image() up to (and including) the ImageData fill.
 * Returns the `imgData` RGBA buffer (width x height) exactly as the site builds it; alpha 0
 * marks pixels the site never writes (they end up showing the black canvas fill).
 * Parameter clamping copied from tm_trace_to_image.
 */
export function traceImageData(machine, initial_tape = '0', width = 900, height = 1000, origin_x = 0.5, showHeadMove = false) {
	width = Math.max(1, Math.min(99_999, Math.floor(width) || 0));
	height = Math.max(1, Math.min(99_999, Math.floor(height) || 0));

	const data = new Uint8ClampedArray(width * height * 4); // ctx.createImageData(width, height)
	const color_scale = 255 / (machine.symbols - 1);
	const history = render_history(machine, initial_tape, height);

	for (let row = 1; row < history.length; row += 1) {
		const last_pos = history[row - 1].curr_pos;
		const { tape, curr_pos } = history[row];
		for (let i = 0; i <= tape.length; i += 1) {
			const pos = naturalToInt(i);
			const col = pos + Math.floor(width * origin_x);
			if (col < 0 || col >= width) continue;

			const imgIndex = 4 * (row * width + col);
			// Browser ImageData silently ignores writes past the end (row == height); mimic that.
			if (imgIndex + 3 >= data.length) continue;
			if (pos == curr_pos && showHeadMove) {
				data[imgIndex + 0] = curr_pos > last_pos ? 255 : 0;
				data[imgIndex + 1] = curr_pos < last_pos ? 255 : 0;
				data[imgIndex + 2] = 0;
				data[imgIndex + 3] = 255;
			} else if (tape[intToNatural(pos)] != undefined) {
				const color = Math.floor(color_scale * tape[intToNatural(pos)]);
				data[imgIndex + 0] = color;
				data[imgIndex + 1] = color;
				data[imgIndex + 2] = color;
				data[imgIndex + 3] = 255;
			}
		}
	}
	return { width, height, data, history_length: history.length };
}

/**
 * Explore mode: tm.ts tm_explore() render() for a given view transform
 * (initially zoom=10, x_offset=canvas.width/2, y_offset=0). Returns the list of
 * fillRect calls in user space, in the same order the site issues them:
 * {col,row,rgb}. canvas.mjs rasterises them.
 */
export function exploreFillRects(machine, initial_tape = '0', height = 1000, canvasW = 800, canvasH = 500, zoom = 10, x_offset = canvasW / 2, y_offset = 0) {
	const history = render_history(machine, initial_tape, height);
	const rects = [];
	const h = Math.ceil(canvasH / zoom);
	const w = Math.ceil(canvasW / zoom);
	const minx = Math.floor(-x_offset / zoom);
	const miny = Math.floor(-y_offset / zoom);
	const color_scale = 255 / (machine.symbols - 1);

	for (let row = Math.max(miny, 0); row < Math.min(miny + h + 1, history.length); row++) {
		if (!history[row]) continue;
		const { tape, curr_pos, curr_state } = history[row];

		for (let i = 0; i < tape.length; i += 1) {
			const col = naturalToInt(i);
			if (col < minx || col > minx + w) continue;

			if (tape[i]) {
				const color = Math.floor(color_scale * tape[i]);
				rects.push({ col, row, rgb: [color, color, color] });
			}
		}

		if (curr_state !== null && curr_state < colorList.length) {
			rects.push({ col: curr_pos, row, rgb: colorList[curr_state], head: true });
		}
	}
	return { rects, history_length: history.length };
}
