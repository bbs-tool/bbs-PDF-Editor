// 편집 캔버스 (Fabric.js): 문서 모델 ↔ 화면 객체 변환, 확대·축소, 선택

import { currentPage, assets } from './state.js';
import { renderPdfPage } from './pdfRender.js';
import { cssFamily } from './fonts.js';
import { NO_CROP, uncropped } from './pageSize.js';
import { paintEffect } from './blur.js';

const round = v => Math.round(v * 100) / 100;
const norm = a => round(((a % 360) + 360) % 360) % 360;

let canvas = null;
let stageEl = null;
let hooks = {};
let zoom = 1;
let autoFit = true;
let renderToken = 0;
let builtScale = 0;
let shownPageId = null;
let rendering = false;
let muteSelection = 0;

fabric.Object.prototype.set({
  transparentCorners: false,
  cornerColor: '#ffffff',
  cornerStrokeColor: '#2563eb',
  borderColor: '#2563eb',
  cornerSize: 10,
  cornerStyle: 'circle',
  borderScaleFactor: 1.5,
});

export function initEditor(canvasEl, stage, h) {
  hooks = h;
  stageEl = stage;
  canvas = new fabric.Canvas(canvasEl, {
    width: 10,
    height: 10,
    preserveObjectStacking: true,
    backgroundColor: '#ffffff',
    stopContextMenu: true,
    selectionColor: 'rgba(37,99,235,0.08)',
    selectionBorderColor: '#2563eb',
  });
  // 요소를 끌어 캔버스 밖(왼쪽 페이지 목록 등)에 놓는 경우를 위해 끄는 중인 요소와 마우스 위치를 알린다
  let dragIds = null;
  canvas.on('object:moving', e => {
    dragIds ||= getSelectedIds();
    hooks.onDragMove?.(e.e);
  });
  canvas.on('object:modified', e => {
    normalizeTextbox(e.target);
    const ids = dragIds;
    dragIds = null;
    // 다른 페이지에 놓았으면 그쪽에서 처리한다 (이 페이지에는 끈 위치를 기록하지 않음)
    if (ids && hooks.onDragDrop?.(e.e, ids)) return;
    hooks.onModified?.();
  });
  canvas.on('mouse:up', () => {
    if (dragIds) hooks.onDragMove?.(null);
    dragIds = null;
  });
  canvas.on('text:editing:exited', () => hooks.onModified?.());
  const sel = () => { if (!muteSelection) hooks.onSelection?.(getSelectedIds()); };
  canvas.on('selection:created', sel);
  canvas.on('selection:updated', sel);
  canvas.on('selection:cleared', sel);
  new ResizeObserver(() => { if (autoFit) fitToStage(); }).observe(stage);
}

export const getCanvas = () => canvas;

// ── 모델 → Fabric 객체 ─────────────────────────────────

/** rasterPerPt: 원본 PDF를 그릴 해상도 (요소 1pt당 픽셀 수) */
export async function buildFabricObject(o, rasterPerPt = 2) {
  const common = {
    originX: 'center',
    originY: 'center',
    left: o.cx,
    top: o.cy,
    angle: o.angle,
    opacity: o.opacity ?? 1,
    data: { id: o.id, type: o.type },
    lockScalingFlip: true,
    strokeUniform: true,
  };
  let fo;
  try {
    if (o.type === 'pdfpage' || o.type === 'image') {
      // 자르기: 원본에서 보이는 부분만 그린다 (crop은 원본 대비 잘라낸 비율)
      const c = o.crop || NO_CROP;
      const fullW = o.w / (1 - c.l - c.r);
      if (o.type === 'pdfpage') {
        // PDF는 보이는 부분만 따로 그려 온다
        const el = await renderPdfPage(o.assetId, o.pageIndex, (rasterPerPt * fullW) / o.natW, o.crop);
        fo = new fabric.Image(el, { ...common, scaleX: o.w / el.width, scaleY: o.h / el.height });
      } else {
        const el = assets.get(o.assetId).el;
        const elW = el.naturalWidth;
        const elH = el.naturalHeight;
        const width = elW * (1 - c.l - c.r);
        const height = elH * (1 - c.t - c.b);
        fo = new fabric.Image(el, { ...common, cropX: elW * c.l, cropY: elH * c.t, width, height, scaleX: o.w / width, scaleY: o.h / height });
      }
    } else if (o.type === 'text') {
      fo = new fabric.Textbox(o.text, {
        ...common,
        width: o.w,
        fontSize: o.fontSize,
        fontFamily: cssFamily(o.fontFamily),
        fontWeight: o.bold ? 'bold' : 'normal',
        fill: o.color,
        textAlign: o.align,
        lineHeight: o.lineHeight,
      });
      fo.setControlsVisibility({ mt: false, mb: false });
    } else if (o.type === 'rect') {
      fo = new fabric.Rect({ ...common, width: o.w, height: o.h, ...shapeStyle(o) });
    } else if (o.type === 'ellipse') {
      fo = new fabric.Ellipse({ ...common, rx: o.w / 2, ry: o.h / 2, ...shapeStyle(o) });
    } else if (o.type === 'blur') {
      // 아래에 그려진 픽셀을 읽어 효과를 넣으므로 따로 캐시하지 않고 매번 캔버스에 직접 그린다
      fo = new fabric.Rect({ ...common, width: o.w, height: o.h, fill: 'rgba(0,0,0,0)', strokeWidth: 0, objectCaching: false });
      const effect = { shape: o.shape, mode: o.mode, strength: o.strength };
      fo._render = function (ctx) {
        paintEffect(ctx, this.width, this.height, effect, Math.abs(this.scaleX) || 1);
      };
    }
  } catch (e) {
    console.error('요소를 그리지 못했습니다', o, e);
  }
  fo ||= new fabric.Rect({ ...common, width: o.w, height: o.h, fill: '#f3f4f6', stroke: '#ef4444', strokeWidth: 1, strokeDashArray: [4, 4] });
  applyLock(fo, o.locked);
  return fo;
}

function shapeStyle(o) {
  return { fill: o.fill || 'rgba(0,0,0,0)', stroke: o.stroke || null, strokeWidth: o.stroke ? o.strokeWidth : 0 };
}

// 잠긴 요소는 클릭되지 않는다 (배경처럼 동작). 해제는 속성 패널·페이지 설정에서.
function applyLock(fo, locked) {
  fo.set({ selectable: !locked, evented: !locked });
  if (fo.type === 'textbox') fo.editable = !locked;
}

// ── Fabric 객체 → 모델 ─────────────────────────────────

function readFabric(fo, o) {
  const d = fabric.util.qrDecompose(fo.calcTransformMatrix());
  const sx = Math.abs(d.scaleX);
  const sy = Math.abs(d.scaleY);
  // 반올림 오차만큼만 다르면 문서 값을 그대로 둔다 (아니면 동기화만으로 실행 취소 기록이 생긴다)
  const set = (key, v) => { if (!(Math.abs(o[key] - v) < 0.01)) o[key] = round(v); };
  set('cx', d.translateX);
  set('cy', d.translateY);
  if (!(Math.abs(norm(o.angle - d.angle + 180) - 180) < 0.01)) o.angle = norm(d.angle);
  set('opacity', fo.opacity);
  if (o.type === 'ellipse') {
    set('w', fo.rx * 2 * sx);
    set('h', fo.ry * 2 * sy);
  } else if (o.type === 'text') {
    o.text = fo.text;
    set('fontSize', fo.fontSize * sy);
    set('w', fo.width * sx);
    set('h', fo.height * sy);
  } else {
    set('w', fo.width * sx);
    set('h', fo.height * sy);
  }
}

// 텍스트 상자를 모서리로 늘리면 글자 크기에 반영하고 배율은 1로 되돌린다
function normalizeTextbox(fo) {
  if (fo?.type !== 'textbox' || (fo.scaleX === 1 && fo.scaleY === 1)) return;
  fo.set({ fontSize: fo.fontSize * fo.scaleY, width: fo.width * fo.scaleX, scaleX: 1, scaleY: 1 });
  fo.setCoords();
}

/** 캔버스에서 바뀐 위치·크기·순서를 현재 페이지 모델에 반영 */
export function syncFromCanvas() {
  const page = currentPage();
  if (!page || !canvas || rendering || shownPageId !== page.id) return;
  const byId = new Map(page.objects.map(o => [o.id, o]));
  const next = [];
  for (const fo of canvas.getObjects()) {
    const o = byId.get(fo.data?.id);
    if (!o) continue;
    readFabric(fo, o);
    next.push(o);
  }
  for (const o of page.objects) if (!next.includes(o)) next.push(o);
  page.objects = next;
}

// ── 렌더링 ────────────────────────────────────────────

function rasterPerPt() {
  const want = zoom * (window.devicePixelRatio || 1);
  return Math.min(4, Math.max(1.5, Math.ceil(want * 2) / 2));
}

function fitZoom(page) {
  const pad = 56;
  const w = stageEl.clientWidth - pad;
  const h = stageEl.clientHeight - pad;
  return Math.max(0.1, Math.min(w / page.width, h / page.height));
}

function applyDimensions(page) {
  canvas.setZoom(zoom);
  canvas.setDimensions({ width: Math.round(page.width * zoom), height: Math.round(page.height * zoom) });
}

/**
 * 현재 페이지를 모델 기준으로 다시 그린다. select: 그린 뒤 선택할 요소 id
 * fit: 화면 배율을 페이지에 맞춤 / keepZoom: 지금 배율을 유지 (페이지 크기를 바꾸는 중일 때)
 */
export async function renderCurrentPage({ fit = false, keepZoom = false, select = null } = {}) {
  cancelCrop();
  cancelDraw();
  const token = ++renderToken;
  const page = currentPage();
  if (!page) {
    canvas.discardActiveObject();
    canvas.remove(...canvas.getObjects()); // clear()는 흰 배경색까지 지우므로 쓰지 않는다
    shownPageId = null;
    hooks.onSelection?.([]);
    return;
  }
  rendering = true;
  if (fit) autoFit = true;
  else if (keepZoom) autoFit = false;
  if (autoFit) zoom = fitZoom(page);
  const keep = select || (shownPageId === page.id ? getSelectedIds() : []);
  const scale = rasterPerPt();
  const built = await Promise.all(page.objects.map(o => buildFabricObject(o, scale)));
  if (token !== renderToken) return;

  muteSelection++;
  canvas.discardActiveObject();
  canvas.remove(...canvas.getObjects());
  applyDimensions(page);
  built.forEach(fo => canvas.add(fo));
  builtScale = scale;
  shownPageId = page.id;
  rendering = false;
  restoreSelection(keep);
  muteSelection--;
  canvas.requestRenderAll();
  hooks.onZoom?.(zoom);
  hooks.onSelection?.(getSelectedIds());
}

/** 일부 요소만 다시 그린다 (속성 패널에서 값을 바꿀 때) */
export async function patchObjects(ids) {
  const page = currentPage();
  if (!page || shownPageId !== page.id || rendering) return renderCurrentPage();
  const targets = page.objects.filter(o => ids.includes(o.id));
  const built = await Promise.all(targets.map(o => buildFabricObject(o, builtScale)));

  muteSelection++;
  const keep = getSelectedIds();
  canvas.discardActiveObject();
  built.forEach((fo, i) => {
    const old = canvas.getObjects().find(f => f.data.id === targets[i].id);
    if (!old) return;
    const idx = canvas.getObjects().indexOf(old);
    canvas.remove(old);
    canvas.insertAt(fo, idx);
  });
  restoreSelection(keep);
  muteSelection--;
  canvas.requestRenderAll();
}

// ── 선택 ──────────────────────────────────────────────

export function getSelectedIds() {
  return canvas ? canvas.getActiveObjects().map(f => f.data.id) : [];
}

function restoreSelection(ids) {
  const objs = canvas.getObjects().filter(f => ids.includes(f.data.id) && f.selectable);
  if (objs.length === 1) canvas.setActiveObject(objs[0]);
  else if (objs.length > 1) canvas.setActiveObject(new fabric.ActiveSelection(objs, { canvas }));
}

export function selectIds(ids) {
  canvas.discardActiveObject();
  restoreSelection(ids);
  canvas.requestRenderAll();
}

export function clearSelection() {
  canvas.discardActiveObject();
  canvas.requestRenderAll();
}

export function isEditingText() {
  return !!canvas?.getActiveObject()?.isEditing;
}

export function exitEditing() {
  const a = canvas?.getActiveObject();
  if (a?.isEditing) a.exitEditing();
}

export function editText(id) {
  const fo = canvas.getObjects().find(f => f.data.id === id);
  if (!fo || fo.type !== 'textbox') return;
  canvas.setActiveObject(fo);
  fo.enterEditing();
  fo.selectAll();
  canvas.requestRenderAll();
}

/** 마우스 위치의 요소 id (잠긴 요소 포함, 맨 위부터) — 우클릭 메뉴용 */
export function objectIdAt(e) {
  if (!canvas || crop) return null;
  const p = canvas.getPointer(e, true);
  const objs = canvas.getObjects();
  for (let i = objs.length - 1; i >= 0; i--) {
    const fo = objs[i];
    if (fo.visible && fo.data?.id && fo.containsPoint(p)) return fo.data.id;
  }
  return null;
}

// ── 자르기 ────────────────────────────────────────────
// 원본 전체를 흐리게 깔고, 자를 영역(사각형)을 조절한다. 사각형 안쪽은 원래 밝기로 보인다.

let crop = null;

export const isCropping = () => !!crop;

export async function startCrop(id) {
  const page = currentPage();
  const o = page?.objects.find(x => x.id === id);
  const fo = canvas.getObjects().find(f => f.data?.id === id);
  if (!o || !fo || (o.type !== 'pdfpage' && o.type !== 'image')) return false;
  cancelDraw();
  cancelCrop();

  const full = { ...o, ...uncropped(o), crop: null, opacity: 1 };

  const helper = { data: { id: null }, selectable: false, evented: false };
  const dim = await buildFabricObject(full, builtScale);
  const bright = await buildFabricObject(full, builtScale);
  dim.set({ ...helper, opacity: 0.35 });
  const rect = new fabric.Rect({
    originX: 'center', originY: 'center', left: o.cx, top: o.cy, width: o.w, height: o.h, angle: o.angle,
    fill: 'rgba(0,0,0,0)', stroke: '#2563eb', strokeWidth: 2, strokeUniform: true, strokeDashArray: [6, 4],
    lockRotation: true, lockScalingFlip: true, data: { id: null },
    cornerSize: 16, cornerStyle: 'rect', cornerColor: '#2563eb', // 페이지 가장자리에 걸쳐도 잡기 쉽게 크게
  });
  rect.setControlsVisibility({ mtr: false });
  bright.set(helper);
  bright.clipPath = new fabric.Rect({ originX: 'center', originY: 'center', absolutePositioned: true });
  const syncClip = () => {
    bright.clipPath.set({ left: rect.left, top: rect.top, width: rect.width * rect.scaleX, height: rect.height * rect.scaleY, angle: rect.angle });
    bright.dirty = true;
  };
  syncClip();
  rect.on('moving', syncClip);
  rect.on('scaling', syncClip);

  crop = { id, o, full, dim, bright, rect, restore: canvas.getObjects().map(f => [f, f.selectable, f.evented]) };
  muteSelection++;
  canvas.discardActiveObject();
  for (const f of canvas.getObjects()) f.set({ selectable: false, evented: false });
  fo.visible = false;
  const idx = canvas.getObjects().indexOf(fo);
  canvas.insertAt(dim, idx);
  canvas.insertAt(bright, idx + 1);
  canvas.add(rect);
  canvas.setActiveObject(rect);
  muteSelection--;
  canvas.requestRenderAll();
  hooks.onCrop?.(true);
  return true;
}

/** 자르기 결과 → { id, crop, cx, cy, w, h } (crop은 원본 전체 대비 비율). 자르기 중이 아니면 null */
export function finishCrop() {
  if (!crop) return null;
  const { full, dim, rect, id } = crop;
  const m = dim.calcTransformMatrix();
  const inv = fabric.util.invertTransform(m);
  const center = fabric.util.transformPoint(rect.getCenterPoint(), inv); // 원본 이미지 기준 좌표 (가운데가 0,0)
  const W = dim.width;
  const H = dim.height;
  const rw = (rect.width * rect.scaleX) / dim.scaleX;
  const rh = (rect.height * rect.scaleY) / dim.scaleY;
  const clamp = v => Math.min(1, Math.max(0, v));
  let l = clamp((center.x - rw / 2 + W / 2) / W);
  let r = clamp(1 - (center.x + rw / 2 + W / 2) / W);
  let t = clamp((center.y - rh / 2 + H / 2) / H);
  let b = clamp(1 - (center.y + rh / 2 + H / 2) / H);
  // 너무 작게 자르지 않도록 최소 2%는 남긴다
  if (1 - l - r < 0.02) {
    l = Math.min(l, 0.98);
    r = 0.98 - l;
  }
  if (1 - t - b < 0.02) {
    t = Math.min(t, 0.98);
    b = 0.98 - t;
  }
  const vis = fabric.util.transformPoint(new fabric.Point(((l - r) * W) / 2, ((t - b) * H) / 2), m);
  cancelCrop();
  const none = l + t + r + b < 1e-4;
  return { id, crop: none ? null : { l, t, r, b }, cx: vis.x, cy: vis.y, w: full.w * (1 - l - r), h: full.h * (1 - t - b) };
}

export function cancelCrop() {
  if (!crop) return;
  const { dim, bright, rect, restore, id } = crop;
  crop = null;
  muteSelection++;
  canvas.discardActiveObject();
  canvas.remove(dim, bright, rect);
  for (const [f, selectable, evented] of restore) f.set({ selectable, evented });
  const fo = canvas.getObjects().find(f => f.data?.id === id);
  if (fo) fo.visible = true;
  muteSelection--;
  canvas.requestRenderAll();
  hooks.onCrop?.(false);
  hooks.onSelection?.(getSelectedIds());
}

// ── 도형 그리기 ───────────────────────────────────────
// 네모·동그라미 도구를 고른 뒤 페이지 위를 끌면 그 위치에 끈 크기로 만든다 (PPT와 같은 방식).
// 클릭만 하면 그 자리를 가운데로 기본 크기, Shift를 누르고 끌면 정사각형·정원.

let draw = null;

export const isDrawing = () => !!draw;

/** onDone({ cx, cy, w, h }) — 단위는 pt(페이지 좌표). shape: 미리보기 모양 ('ellipse'면 타원) */
export function startDraw(type, onDone, { shape = type } = {}) {
  cancelDraw();
  if (!canvas || !currentPage() || crop) return false;
  muteSelection++;
  canvas.discardActiveObject();
  muteSelection--;
  hooks.onSelection?.([]);
  const restore = canvas.getObjects().map(f => [f, f.selectable, f.evented]);
  for (const f of canvas.getObjects()) f.set({ selectable: false, evented: false });
  const prev = { selection: canvas.selection, defaultCursor: canvas.defaultCursor, hoverCursor: canvas.hoverCursor };
  canvas.selection = false;
  canvas.defaultCursor = canvas.hoverCursor = 'crosshair';

  let start = null;
  let preview = null;
  const boxOf = opt => {
    const p = canvas.getPointer(opt.e);
    let w = p.x - start.x;
    let h = p.y - start.y;
    if (opt.e.shiftKey) {
      const s = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * s;
      h = Math.sign(h || 1) * s;
    }
    return { left: Math.min(start.x, start.x + w), top: Math.min(start.y, start.y + h), w: Math.abs(w), h: Math.abs(h) };
  };
  const down = opt => {
    if (opt.e.button === 2) return;
    start = canvas.getPointer(opt.e);
    const style = {
      originX: 'left', originY: 'top', left: start.x, top: start.y, selectable: false, evented: false,
      fill: 'rgba(68,114,196,0.25)', stroke: '#2563eb', strokeWidth: 1.5, strokeUniform: true, strokeDashArray: [5, 4], data: { id: null },
    };
    if (type === 'blur') Object.assign(style, { fill: 'rgba(17,24,39,0.18)', stroke: '#111827' });
    preview = shape === 'ellipse' ? new fabric.Ellipse({ ...style, rx: 0, ry: 0 }) : new fabric.Rect({ ...style, width: 0, height: 0 });
    canvas.add(preview);
  };
  const move = opt => {
    if (!start || !preview) return;
    const b = boxOf(opt);
    if (shape === 'ellipse') preview.set({ left: b.left, top: b.top, rx: b.w / 2, ry: b.h / 2 });
    else preview.set({ left: b.left, top: b.top, width: b.w, height: b.h });
    canvas.requestRenderAll();
  };
  const up = opt => {
    if (!start) return;
    const b = boxOf(opt);
    const tiny = 6 / zoom; // 화면에서 6px 이하로 움직였으면 '클릭'으로 본다
    const result = b.w < tiny && b.h < tiny
      ? { cx: start.x, cy: start.y }
      : { cx: b.left + b.w / 2, cy: b.top + b.h / 2, w: Math.max(b.w, 2), h: Math.max(b.h, 2) };
    cancelDraw();
    onDone(result);
  };
  canvas.on('mouse:down', down);
  canvas.on('mouse:move', move);
  canvas.on('mouse:up', up);
  draw = {
    type,
    cleanup() {
      canvas.off('mouse:down', down);
      canvas.off('mouse:move', move);
      canvas.off('mouse:up', up);
      if (preview) canvas.remove(preview);
      for (const [f, selectable, evented] of restore) f.set({ selectable, evented });
      Object.assign(canvas, prev);
      canvas.requestRenderAll();
    },
  };
  hooks.onDraw?.(type);
  return true;
}

export function cancelDraw() {
  if (!draw) return;
  const d = draw;
  draw = null;
  d.cleanup();
  hooks.onDraw?.(null);
}

// ── 확대·축소 ─────────────────────────────────────────

export const getZoom = () => zoom;

export function setZoom(z, { manual = true } = {}) {
  if (manual) autoFit = false;
  zoom = Math.min(5, Math.max(0.1, z));
  const page = currentPage();
  if (page && shownPageId === page.id) {
    applyDimensions(page);
    canvas.requestRenderAll();
    if (rasterPerPt() > builtScale) renderCurrentPage(); // 확대하면 원본을 더 선명하게 다시 그린다
  }
  hooks.onZoom?.(zoom);
}

export function fitToStage() {
  autoFit = true;
  const page = currentPage();
  if (page && stageEl.clientWidth > 0) setZoom(fitZoom(page), { manual: false });
}
