// 문서 상태, 원본 파일 저장소, 실행 취소 기록, 이벤트

export const PT_PER_MM = 72 / 25.4;
export const A4_PT = { w: 595.28, h: 841.89 };
export const PX_TO_PT = 0.75; // 96dpi 픽셀 → pt
// PDF 표준 페이지 최대 크기 200인치(14400pt). 넘으면 Adobe Acrobat 등에서 잘리거나 열리지 않는다.
export const MAX_PAGE_MM = 5080;
export const MAX_PAGE_PT = 14400;

let seq = 0;
export function uid(prefix = 'o') {
  return prefix + Date.now().toString(36) + (seq++).toString(36);
}

/**
 * 업로드한 원본 바이너리. 실행 취소 기록에는 넣지 않고 assetId로만 참조한다.
 * pdf:   { kind, name, bytes, libDoc? }
 * image: { kind, name, bytes, mime, el }
 */
export const assets = new Map();

/**
 * doc.pages[] = {
 *   id, width, height (pt),
 *   sizeMode: 'a4' | 'original' | 'fit' | 'custom',
 *   orientation: 'portrait' | 'landscape',
 *   fitMode: 'contain' | 'cover' | 'stretch',
 *   customW, customH (mm), margin: { top, right, bottom, left } (mm, 'fit'에서만 사용), baseId (원본 배경 요소 id | null),
 *   objects: [요소...]  // 배열 순서 = 레이어 순서 (뒤 → 앞)
 * }
 * 요소 공통: { id, type, cx, cy, w, h, angle, opacity, locked }  // cx, cy = 중심 좌표(pt)
 *   pdfpage: assetId, pageIndex, natW, natH
 *   image:   assetId, natW, natH
 *   text:    text, fontFamily, bold, fontSize, color, align, lineHeight
 *   rect / ellipse: fill, stroke, strokeWidth  (색이 null이면 없음)
 *   blur:    shape ('rect'|'ellipse'), mode ('mosaic'|'blur'), strength (10~100%) — 아래 요소를 가린다 (blur.js)
 */
export const state = {
  doc: { pages: [] },
  current: 0,
};

export function currentPage() {
  return state.doc.pages[state.current] || null;
}

export function findObject(id) {
  for (let i = 0; i < state.doc.pages.length; i++) {
    const page = state.doc.pages[i];
    const obj = page.objects.find(o => o.id === id);
    if (obj) return { page, pageIndex: i, obj };
  }
  return null;
}

// ── 이벤트 ──────────────────────────────────────────
const listeners = {};

export function on(evt, fn) {
  (listeners[evt] ||= []).push(fn);
  return () => { listeners[evt] = listeners[evt].filter(f => f !== fn); };
}

export function emit(evt, payload) {
  for (const fn of listeners[evt] || []) {
    try { fn(payload); } catch (e) { console.error(e); }
  }
}

// ── 실행 취소 / 다시 실행 ─────────────────────────────
const HISTORY_LIMIT = 100;
const undoStack = [];
const redoStack = [];
let lastDoc = JSON.stringify(state.doc);

/** 현재 문서를 기록에 남긴다. 바뀐 내용이 없으면 아무것도 하지 않는다. */
export function commit(reason = '') {
  const snap = JSON.stringify(state.doc);
  if (snap === lastDoc) return false;
  undoStack.push({ doc: lastDoc, current: state.current });
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  lastDoc = snap;
  emit('change', { reason });
  return true;
}

export function undo() {
  const entry = undoStack.pop();
  if (!entry) return false;
  redoStack.push({ doc: lastDoc, current: entry.current });
  restore(entry);
  return true;
}

export function redo() {
  const entry = redoStack.pop();
  if (!entry) return false;
  undoStack.push({ doc: lastDoc, current: entry.current });
  restore(entry);
  return true;
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

function restore(entry) {
  lastDoc = entry.doc;
  state.doc = JSON.parse(entry.doc);
  state.current = Math.max(0, Math.min(entry.current, state.doc.pages.length - 1));
  emit('change', { reason: 'history' });
}
