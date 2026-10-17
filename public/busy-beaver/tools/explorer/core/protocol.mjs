// Frozen contract (atlas/explorer-spec.md §5.1). Changing this file needs both builders + a PROTOCOL_VERSION bump.
export const PROTOCOL_VERSION = 1;
export const TILE = 256;                 // rows and columns per tile
export const STRIP = 32;                 // rows per strip job
export const MAG = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32];   // device px per unit at ladder index z >= 0
// Row flags (meta field 2). 1/2/4 are BBD's own; 8+ are explorer-only.
export const F_FRESH = 1, F_NOHEAD = 2, F_HALTED = 4, F_ABSENT = 8, F_PENDING = 16, F_START = 32;
export const UNREAD = 255;               // cell value meaning "never read", in probe/cursor windows and the `near` plane
export const LIMITS = {
  maxStates: 25, maxSymbols: 10, spanCap: 2 ** 28,
  ckptC0Min: 12, ckptMaxCount: 2048, ckptBudgetBytes: 256 << 20,
  recBudgetBytes: 32 << 20, ovMaxCols: 2048,
  tileCacheBytes: 128 << 20, bitmapCacheCount: 256, workerCkptCacheBytes: 32 << 20,
  maxPatterns: 3, maxPatternLen: 8, maxBlockK: 4,
  sliceSteps: 2 ** 22,                   // max steps between yields in any worker loop
  defaultSteps: 1e8, stubMaxSteps: 2e6,
};
export const ERR = {
  PARSE: 'E_PARSE', CONFIG: 'E_CONFIG', CANCELLED: 'E_CANCELLED', SPANCAP: 'E_SPANCAP',
  CLOSED: 'E_CLOSED', VERSION: 'E_VERSION', RANGE: 'E_RANGE', INTERNAL: 'E_INTERNAL',
};
/** rowsKey: 'auto' | 'every:K' | 'every:K+O' | 'rec:LR'|'rec:L'|'rec:R' | 'st:X' | 'st:X:L' | 'st:X:R' | 'tr:Xs' */
export function rowsKey(rows) {
  switch (rows && rows.kind) {
    case 'auto': return 'auto';
    case 'every': return rows.o ? `every:${rows.k}+${rows.o}` : `every:${rows.k}`;
    case 'records': return `rec:${rows.side || 'LR'}`;
    case 'state': return rows.dir ? `st:${rows.q}:${rows.dir}` : `st:${rows.q}`;
    case 'trans': return `tr:${rows.tr}`;
    default: throw new Error(`rowsKey: bad RowsSpec ${JSON.stringify(rows)}`);
  }
}
/** `${sid}|${rowsKey}|${frame}|t${kt}|x${kx}|${planesKey}|${halt}|${ty},${tx}`
 *  planesKey = '' when kx == 0; else patterns.join(',') + (blk ? `;blk:${k}.${p}.${words.join('+')}` : '') */
export function tileKey(req, ty, tx) {
  let planes = '';
  if (req.kx !== 0) {
    planes = (req.patterns || []).join(',');
    if (req.blk) planes += `;blk:${req.blk.k}.${req.blk.p}.${req.blk.words.join('+')}`;
  }
  return `${req.sid}|${rowsKey(req.rows)}|${req.frame}|t${req.kt}|x${req.kx}|${planes}|${req.halt}|${ty},${tx}`;
}
