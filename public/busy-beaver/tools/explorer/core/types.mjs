// Frozen contract (atlas/explorer-spec.md §5.2-§5.5): JSDoc typedefs only, no code.

/** @typedef {{text:string, n:number, m:number,          // normalised text (trim; letters upper-cased like the site)
 *   W:Uint8Array, D:Int8Array, N:Int8Array,               // index q*m+s; D = +1/-1; N = next state, -1 undefined '---', -2 halt state
 *   names:string[], acts:string[],                        // names[q*m+s] = 'A0'; acts[q*m+s] = '1RB' | '---' | '1RZ'
 *   reachable:boolean[]}} Machine                         // states reachable from A through defined transitions
 *
 * @typedef {{kind:'blank'}
 *  | {kind:'site', tape:string}                           // bbchallenge "initial tape content", e.g. '1 1 B 0 1'
 *  | {kind:'config', dh:string, vars?:Object<string,number>, pos?:number,
 *     from?:{tm:string, step:number}, src?:string}        // src: '@machines/<tm>/work/x.txt' if loaded from a file
 * } StartSpec                                             // the start configuration's step number is OpenSpec.s0
 *
 * @typedef {{kind:'auto'}                                 // base row b = step b
 *  | {kind:'every', k:number, o?:number}                  // base row b = step b*k + o (0 <= o < k); absolute grid
 *  | {kind:'records', side:'LR'|'L'|'R'}                  // base row b = record ordinal b; ordinal 0 = start config
 *  | {kind:'state', q:string, dir?:'L'|'R'}               // base row b = (b+1)-th entry into q after s0 (no start row)
 *  | {kind:'trans', tr:string}                            // base row b = (b+1)-th firing of transition tr, e.g. 'C1'
 * } RowsSpec
 *
 * @typedef {'abs'|'head'|'left'|'right'} FrameSpec        // anchor = 0 | pos | lo | hi of each row
 *
 * @typedef {{tm:string, start:StartSpec, s0:number, steps:number}} OpenSpec
 *
 * @typedef {{sid:string, tm:string, n:number, m:number, start:StartSpec, s0:number,
 *   t:number, target:number, rate:number,                 // steps simulated (absolute step), budget, steps/s (EMA)
 *   status:'running'|'paused'|'done'|'halted'|'span-cap'|'error',
 *   state:string, pos:number, lo:number, hi:number,       // live, sim.py semantics
 *   extent:{lo:number, hi:number},                        // min lo / max hi over the run so far
 *   halt:null|{step:number, from:string, read:number, kind:'undefined'|'halt-state'},
 *   ckpt:{c:number, count:number, bytes:number},          // stride 2^c
 *   rec:{count:number, r:number},                         // records seen; index keeps every 2^r-th
 *   error?:{code:string, message:string}}} RunInfo
 *
 * @typedef {{id:number, t:number, q:number, pos:number, lo:number, hi:number, dir:-1|0|1, fresh:boolean,
 *   tr:number,                                            // q*m+s of the transition that produced this config (-1 at start)
 *   bitsPerCell:1|2|4, bits:ArrayBuffer}} Checkpoint      // cells lo..hi packed LSB-first; a fresh head cell is stored as 0
 */

/** @typedef {{key:string, kind:'exact', sid:string, ty:number, tx:number, kt:number, m:number,
 *   n:256,                              // always 256 rows; flags say which are real
 *   meta:Int32Array,                    // 8*256: [state, dir, flags, pos, lo, hi, clo, len] per row (BBD layout)
 *   steps:Float64Array,                 // 256: absolute step of each row (NaN if ABSENT/PENDING)
 *   ev:Float64Array|null,               // 256: event ordinal (records/state/trans rows), else null
 *   next:Int16Array,                    // 256: q*m+s about to fire at this row (-1 halted/absent)
 *   cells:Uint8Array,                   // 256*256: row i's stored cells at cells[256*i + (p - clo)], p in [clo, clo+len)
 *   off:Float64Array,                   // 257: off[i] = 256*i (BBD's offsets)
 *   final:boolean}} ExactTile
 */

/** @typedef {{key:string, kind:'pooled', sid:string, ty:number, tx:number, kt:number, kx:number, cx:number, m:number,
 *   n:256, cols:256,
 *   meta:Int32Array, steps:Float64Array, ev:Float64Array|null, next:Int16Array,   // as ExactTile; clo = anchor + 256*tx*cx, len = 256*cx
 *   headCol:Int16Array,                 // 256: texel column holding pos, -1 if outside this tile or NOHEAD
 *   dtype:'u16'|'u32',                  // u16 when cx <= 32768, else u32
 *   planes:Object<string, Uint16Array|Uint32Array|Uint8Array>,   // each [256*256], index = row*256 + col
 *   final:boolean}} PooledTile
 */

/** @typedef {{step:number, state:string, dir:-1|0|1, pos:number, lo:number, hi:number, fresh:boolean, halted:boolean,
 *   x0:number, cells:Uint8Array,                       // absolute cells x0..x1 (UNREAD where not read)
 *   next:null|{tr:string, act:string},                 // {tr:'C1', act:'0LD'}; act '---' for undefined
 *   prev:null|{tr:string, act:string},                 // the transition that produced this row
 *   dh:string, dhExact:string}} ProbeResult            // sim.py cfg.dh() and cfg.dh(trim=False), byte-exact
 *
 * @typedef {{step:number, state:string, dir:-1|0|1, pos:number, lo:number, hi:number, fresh:boolean, halted:boolean,
 *   x0:number, cells:Uint8Array,                       // pos-64 .. pos+64, UNREAD where not read
 *   next:null|{tr:string, act:string}, prev:null|{tr:string, act:string},
 *   fired:Float64Array}} Frame                         // n*m counts of transitions fired since the previous frame
 *
 * @typedef {{t0:number, t1:number, counts:Float64Array}} UsageTable   // n*m firings in steps (t0, t1]
 *
 * @typedef {{t:Float64Array,                           // step of each overview row (= checkpoint steps)
 *   j:number, u0:number, cols:number,                  // col c covers abs cells [u0 + c*2^j, u0 + (c+1)*2^j); u0 % 2^j == 0
 *   cnt:Array<Uint32Array>,                            // per symbol k=1..m-1: [rows*cols]
 *   vis:Uint32Array, near:Uint8Array,                  // [rows*cols]
 *   lo:Float64Array, hi:Float64Array, pos:Float64Array}} Overview
 */
export {};
