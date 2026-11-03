// 편집 명령 모음. 화면 UI와 외부 API(js/api.js)가 모두 이 함수들을 통해 문서를 바꾼다.

import { state, assets, uid, commit, emit, undo as historyUndo, redo as historyRedo, currentPage, findObject, PT_PER_MM, A4_PT, MAX_PAGE_PT } from './state.js';
import { layoutPage, rotatePageCW, baseOf, uncropped, NO_MARGIN } from './pageSize.js';
import { importPdf, importImage, importImageAsset, isPdf, isImage } from './importer.js';
import { exportPdf } from './exporter.js';
import { renderPdfToImages } from './imageExport.js';
import { DEFAULT_FONT } from './fonts.js';
import * as editor from './canvas.js';
import { getTemplate, putTemplate, templatePages } from './templates.js';

const clone = v => JSON.parse(JSON.stringify(v));
let clipboard = [];

/** 캔버스에서 진행 중인 변경(드래그, 글자 입력)을 모델에 반영 */
function sync() {
  editor.syncFromCanvas();
}

const refresh = opts => editor.renderCurrentPage(opts);
const pageAt = i => state.doc.pages[i ?? state.current];

/** 캔버스에서 이동·크기 조절·글자 수정이 끝났을 때 */
export function canvasModified() {
  sync();
  commit('canvas');
}

// ── 페이지 ────────────────────────────────────────────

function newPage(base = null, settings = {}) {
  const page = {
    id: uid('p'),
    width: 0,
    height: 0,
    sizeMode: base ? 'original' : 'a4',
    orientation: 'portrait',
    fitMode: 'contain',
    customW: 210,
    customH: 297,
    margin: { top: 0, right: 0, bottom: 0, left: 0 }, // mm, '이미지 크기에 맞춤'·'영역 직접 지정'에서 상하좌우로 더하는 영역
    align: { h: 'center', v: 'middle' }, // 원본 배경 정렬 (A4·영역 직접 지정)
    baseId: base ? base.id : null,
    objects: base ? [base] : [],
    ...settings,
  };
  layoutPage(page);
  return page;
}

/**
 * PDF·이미지 파일을 새 페이지로 추가. at: 넣을 위치 (기본: 현재 페이지 다음)
 * askSplit({ name, w, h, count }): PDF 최대 높이(5080mm)를 넘는 페이지가 있을 때 나눌지 묻는다
 *   → 'a4'(가로폭 기준 A4 비율로) | 'max'(최대 높이로) | 'none'(나누지 않음). 없으면 나누지 않는다.
 */
export async function openFiles(files, at, { askSplit } = {}) {
  sync();
  const pages = [];
  const errors = [];
  for (const file of files) {
    try {
      const items = isPdf(file) ? await importPdf(file) : isImage(file) ? await importImage(file) : null;
      if (!items) throw new Error(`${file.name}: 지원하지 않는 형식입니다`);
      const long = items.filter(item => item.natH > MAX_PAGE_PT);
      const mode = long.length && askSplit ? await askSplit({ name: file.name, w: long[0].natW, h: long[0].natH, count: long.length }) : 'none';
      for (const item of items) {
        if (mode !== 'none' && item.natH > MAX_PAGE_PT) pages.push(...splitPages(item, splitHeight(item, mode)));
        else pages.push(newPage(item));
      }
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (pages.length) {
    const idx = at ?? (state.doc.pages.length ? state.current + 1 : 0);
    state.doc.pages.splice(idx, 0, ...pages);
    state.current = idx;
    commit('open');
    await refresh({ fit: true });
  }
  return { added: pages.length, errors };
}

/** 나눌 한 페이지의 높이(pt). a4: 가로폭 × 297/210, max: PDF 최대 높이 */
export function splitHeight(item, mode) {
  return mode === 'a4' ? Math.min(MAX_PAGE_PT, (item.natW * A4_PT.h) / A4_PT.w) : MAX_PAGE_PT;
}

/**
 * 긴 원본 하나를 위에서부터 여러 페이지로 나눈다. 각 페이지는 같은 원본을 잘라 보여 주므로 화질이 그대로다.
 * splitGroup으로 묶어 두어 PDF 저장 때 다시 한 페이지로 합칠 수 있다.
 */
function splitPages(item, partH) {
  const n = Math.ceil(item.natH / partH - 1e-6);
  const group = uid('g');
  return Array.from({ length: n }, (_, k) => {
    const crop = { l: 0, r: 0, t: (k * partH) / item.natH, b: Math.max(0, 1 - ((k + 1) * partH) / item.natH) };
    return newPage({ ...item, id: uid(), crop }, { splitGroup: { id: group, part: k, parts: n } });
  });
}

export async function goToPage(index) {
  if (index < 0 || index >= state.doc.pages.length || index === state.current) return;
  sync();
  commit('canvas');
  state.current = index;
  emit('navigate', { index });
  await refresh();
}

export async function addBlankPage(after = state.current) {
  sync();
  const ref = pageAt(after);
  const settings = ref && (ref.sizeMode === 'a4' || ref.sizeMode === 'custom')
    ? { sizeMode: ref.sizeMode, orientation: ref.orientation, customW: ref.customW, customH: ref.customH }
    : {};
  const page = newPage(null, settings);
  const idx = state.doc.pages.length ? after + 1 : 0;
  state.doc.pages.splice(idx, 0, page);
  state.current = idx;
  commit('add-page');
  await refresh();
  return page.id;
}

export async function duplicatePage(index = state.current) {
  sync();
  const copy = clone(pageAt(index));
  copy.id = uid('p');
  for (const o of copy.objects) {
    const newId = uid();
    if (copy.baseId === o.id) copy.baseId = newId;
    o.id = newId;
  }
  state.doc.pages.splice(index + 1, 0, copy);
  state.current = index + 1;
  commit('duplicate-page');
  await refresh();
  return copy.id;
}

export async function deletePage(index = state.current) {
  sync();
  if (!pageAt(index)) return;
  state.doc.pages.splice(index, 1);
  if (state.current > index) state.current--;
  state.current = Math.max(0, Math.min(state.current, state.doc.pages.length - 1));
  commit('delete-page');
  await refresh({ fit: true });
}

/** 여러 페이지를 한 번에 삭제 (실행 취소 한 번으로 되돌림) */
export async function deletePages(indexes) {
  sync();
  const remove = new Set(indexes.filter(i => pageAt(i)).map(i => pageAt(i).id));
  if (!remove.size) return 0;
  const currentId = currentPage()?.id;
  const before = state.doc.pages;
  state.doc.pages = before.filter(p => !remove.has(p.id));
  // 보던 페이지가 지워지면 그 자리의 다음 페이지(없으면 앞 페이지)로
  const kept = state.doc.pages.findIndex(p => p.id === currentId);
  const removedBefore = before.slice(0, state.current).filter(p => remove.has(p.id)).length;
  state.current = kept >= 0 ? kept : Math.max(0, Math.min(state.current - removedBefore, state.doc.pages.length - 1));
  commit('delete-pages');
  await refresh({ fit: true });
  return remove.size;
}

export async function rotatePage(index = state.current) {
  sync();
  rotatePageCW(pageAt(index));
  commit('rotate-page');
  if (index === state.current) await refresh({ fit: true });
}

export async function movePage(from, to) {
  sync();
  const pages = state.doc.pages;
  if (from === to || !pages[from] || to < 0 || to >= pages.length) return;
  const currentId = currentPage()?.id;
  const [page] = pages.splice(from, 1);
  pages.splice(to, 0, page);
  state.current = pages.findIndex(p => p.id === currentId);
  commit('move-page');
}

/**
 * 규격·방향·배치·여백·정렬 설정. indexes를 여러 개 주면 해당 페이지 모두에 적용.
 * fit: 화면 배율을 페이지에 다시 맞출지 (기본: 규격·방향을 바꿀 때만. 크기·여백 조정 중에는 배율을 유지해 변화가 그대로 보이게)
 */
export async function setPageSettings(settings, indexes = [state.current], { fit = 'sizeMode' in settings || 'orientation' in settings } = {}) {
  sync();
  for (const i of indexes) {
    const page = pageAt(i);
    if (!page) continue;
    Object.assign(page, clone(settings));
    layoutPage(page);
  }
  commit('page-settings');
  if (indexes.includes(state.current)) await refresh(fit ? { fit } : { keepZoom: true });
}

/** 지금 페이지 크기를 그대로 유지하는 '영역 직접 지정' 값 (mm) */
export function customSizeOf(page) {
  const m = page.margin || NO_MARGIN;
  return {
    customW: Math.max(10, page.width / PT_PER_MM - m.left - m.right),
    customH: Math.max(10, page.height / PT_PER_MM - m.top - m.bottom),
  };
}

// ── 요소 추가 ─────────────────────────────────────────

async function addObjects(objs, pageIndex) {
  const page = pageAt(pageIndex);
  page.objects.push(...objs);
  commit('add');
  const ids = objs.map(o => o.id);
  if (page === currentPage()) await refresh({ select: ids });
  return ids;
}

function ensurePage(pageIndex) {
  if (!pageAt(pageIndex)) throw new Error('먼저 페이지를 추가하세요');
}

/** opts: { text, cx, cy, w, fontFamily, bold, fontSize, color, align, lineHeight, pageIndex } */
export async function addText(opts = {}) {
  sync();
  const { pageIndex, ...props } = opts;
  ensurePage(pageIndex);
  const page = pageAt(pageIndex);
  const o = {
    id: uid(),
    type: 'text',
    text: '텍스트를 입력하세요',
    cx: page.width / 2,
    cy: page.height / 2,
    w: Math.min(260, page.width * 0.8),
    h: 0,
    angle: 0,
    opacity: 1,
    locked: false,
    fontFamily: DEFAULT_FONT,
    bold: false,
    fontSize: 20,
    color: '#111111',
    align: 'left',
    lineHeight: 1.2,
    ...props,
  };
  const [id] = await addObjects([o], pageIndex);
  return id;
}

/** type: 'rect' | 'ellipse', opts: { cx, cy, w, h, fill, stroke, strokeWidth, pageIndex } */
export async function addShape(type, opts = {}) {
  sync();
  const { pageIndex, ...props } = opts;
  ensurePage(pageIndex);
  const page = pageAt(pageIndex);
  const size = type === 'ellipse' ? { w: 120, h: 120 } : { w: 160, h: 100 };
  const o = {
    id: uid(),
    type,
    cx: page.width / 2,
    cy: page.height / 2,
    ...size,
    angle: 0,
    opacity: 1,
    locked: false,
    fill: '#4472c4',
    stroke: '#2f528f',
    strokeWidth: 1,
    ...props,
  };
  const [id] = await addObjects([o], pageIndex);
  return id;
}

/** 이미지를 현재 페이지 위에 올린다 (페이지 크기의 60% 안으로 줄여서 가운데 배치) */
export async function insertImages(blobs, { pageIndex } = {}) {
  sync();
  ensurePage(pageIndex);
  const page = pageAt(pageIndex);
  const objs = [];
  for (const blob of blobs) {
    const a = await importImageAsset(blob);
    const s = Math.min(1, (page.width * 0.6) / a.natW, (page.height * 0.6) / a.natH);
    const n = objs.length;
    objs.push({ id: uid(), type: 'image', ...a, cx: page.width / 2 + n * 12, cy: page.height / 2 + n * 12, w: a.natW * s, h: a.natH * s, angle: 0, opacity: 1, locked: false });
  }
  return objs.length ? addObjects(objs, pageIndex) : [];
}

// ── 요소 수정 ─────────────────────────────────────────

/** 요소 속성 변경. record=false면 기록 없이 화면만 갱신 (슬라이더를 끄는 중일 때) */
export async function updateObjects(ids, props, { record = true } = {}) {
  sync();
  const touched = [];
  for (const id of ids) {
    const found = findObject(id);
    if (!found) continue;
    const patch = typeof props === 'function' ? props(found.obj) : props;
    Object.assign(found.obj, patch);
    if (found.page === currentPage()) touched.push(id);
  }
  if (record) commit('update');
  if (touched.length) await editor.patchObjects(touched);
}

export const updateObject = (id, props, opts) => updateObjects([id], props, opts);

export async function deleteObjects(ids) {
  sync();
  if (!ids.length) return;
  for (const page of state.doc.pages) {
    const base = baseOf(page);
    page.objects = page.objects.filter(o => !ids.includes(o.id));
    if (base && ids.includes(base.id)) {
      page.baseId = null;
      if (page.sizeMode === 'original' || page.sizeMode === 'fit') {
        Object.assign(page, { sizeMode: 'custom', ...customSizeOf(page) });
      }
    }
  }
  commit('delete');
  await refresh({ select: [] });
}

/**
 * 현재 페이지의 요소를 다른 페이지로 옮긴다. 위치는 끌기 전 자리를 페이지 크기 비율대로 옮긴다.
 * (화면에서 끌어 놓을 때는 캔버스 위치가 페이지 밖이므로 문서에 남아 있는 끌기 전 위치를 쓴다)
 */
export async function moveObjectsToPage(ids, targetIndex) {
  const page = currentPage();
  const target = pageAt(targetIndex);
  if (!page || !target || target === page || !ids.length) return 0;
  const before = new Map(page.objects.filter(o => ids.includes(o.id)).map(o => [o.id, { cx: o.cx, cy: o.cy }]));
  sync();
  const moving = page.objects.filter(o => ids.includes(o.id));
  page.objects = page.objects.filter(o => !ids.includes(o.id));
  if (page.baseId && ids.includes(page.baseId)) {
    // 원본을 옮기면 이 페이지는 빈 페이지가 된다 (크기는 유지)
    page.baseId = null;
    if (page.sizeMode === 'original' || page.sizeMode === 'fit') Object.assign(page, { sizeMode: 'custom', ...customSizeOf(page) });
  }
  const sx = target.width / page.width;
  const sy = target.height / page.height;
  for (const o of moving) {
    const { cx, cy } = before.get(o.id);
    Object.assign(o, { cx: cx * sx, cy: cy * sy });
  }
  target.objects.push(...moving);
  commit('move-to-page');
  await refresh({ select: [] });
  return moving.length;
}

export async function setLocked(ids, locked) {
  await updateObjects(ids, { locked });
  if (locked) editor.clearSelection();
}

export async function unlockAll(pageIndex) {
  sync();
  const page = pageAt(pageIndex);
  if (!page) return 0;
  const ids = page.objects.filter(o => o.locked).map(o => o.id);
  if (ids.length) await updateObjects(ids, { locked: false });
  return ids.length;
}

/** dir: 'front' | 'back' | 'forward' | 'backward' */
export async function arrange(ids, dir) {
  sync();
  const page = currentPage();
  if (!page || !ids.length) return;
  const sel = o => ids.includes(o.id);
  let list = [...page.objects];
  if (dir === 'front') list = [...list.filter(o => !sel(o)), ...list.filter(sel)];
  else if (dir === 'back') list = [...list.filter(sel), ...list.filter(o => !sel(o))];
  else if (dir === 'forward') {
    for (let i = list.length - 2; i >= 0; i--) if (sel(list[i]) && !sel(list[i + 1])) [list[i], list[i + 1]] = [list[i + 1], list[i]];
  } else if (dir === 'backward') {
    for (let i = 1; i < list.length; i++) if (sel(list[i]) && !sel(list[i - 1])) [list[i], list[i - 1]] = [list[i - 1], list[i]];
  }
  page.objects = list;
  commit('arrange');
  await refresh({ select: ids });
}

/** 자르기 적용. crop: 원본 대비 잘라낸 비율 { l, t, r, b } (0~1). 위치·크기는 남는 부분 기준 */
export async function cropObject(id, { crop, cx, cy, w, h }) {
  await updateObject(id, { crop, cx, cy, w, h });
}

/** 자르기를 풀어 원본 전체를 다시 보인다 */
export async function resetCrop(id) {
  const o = findObject(id)?.obj;
  if (o?.crop) await updateObject(id, { ...uncropped(o), crop: null });
}

export async function nudge(ids, dx, dy) {
  await updateObjects(ids, o => ({ cx: o.cx + dx, cy: o.cy + dy }));
}

// ── 복사·붙여넣기 ─────────────────────────────────────

export function copyObjects(ids) {
  sync();
  const page = currentPage();
  if (!page) return 0;
  clipboard = clone(page.objects.filter(o => ids.includes(o.id)));
  return clipboard.length;
}

export const hasClipboard = () => clipboard.length > 0;

async function pasteCopies(objs) {
  const page = currentPage();
  if (!page || !objs.length) return [];
  const copies = clone(objs).map(o => ({ ...o, id: uid(), cx: o.cx + 12, cy: o.cy + 12, locked: false }));
  return addObjects(copies, state.current);
}

export async function paste() {
  sync();
  const ids = await pasteCopies(clipboard);
  clipboard = clone(clipboard).map(o => ({ ...o, cx: o.cx + 12, cy: o.cy + 12 })); // 다음 붙여넣기는 조금 더 비켜서
  return ids;
}

export async function duplicateObjects(ids) {
  sync();
  const page = currentPage();
  return page ? pasteCopies(page.objects.filter(o => ids.includes(o.id))) : [];
}

// ── 실행 취소·저장 ────────────────────────────────────

export async function undo() {
  editor.exitEditing();
  sync();
  commit('canvas');
  if (historyUndo()) await refresh();
}

export async function redo() {
  editor.exitEditing();
  sync();
  if (historyRedo()) await refresh();
}

// ── 템플릿 ────────────────────────────────────────────

/** 페이지 설정과 원본 배경을 뺀 요소를 템플릿으로 저장 → 템플릿 id. indexes: 저장할 페이지들 */
export async function saveTemplate(name, indexes = [state.current]) {
  editor.exitEditing();
  sync();
  const pages = [indexes].flat().map(pageAt).filter(Boolean);
  if (!pages.length) throw new Error('먼저 페이지를 추가하세요');
  const images = {};
  const tplPages = pages.map(page => {
    // 원본 PDF 페이지는 파일 전체가 필요해 템플릿에 넣지 않는다
    const objects = clone(page.objects.filter(o => o.id !== page.baseId && o.type !== 'pdfpage'));
    for (const o of objects) {
      if (o.type !== 'image' || images[o.assetId]) continue;
      const a = assets.get(o.assetId);
      images[o.assetId] = { bytes: a.bytes, mime: a.mime, name: a.name };
    }
    const { sizeMode, orientation, fitMode, customW, customH, margin, align } = page;
    return { width: page.width, height: page.height, settings: clone({ sizeMode, orientation, fitMode, customW, customH, margin, align }), objects };
  });
  return putTemplate({ name: name.trim() || '이름 없는 템플릿', pages: tplPages, assets: images });
}

/**
 * 템플릿을 페이지에 불러온다. 기존 요소는 그대로 두고 템플릿 요소를 위에 올린다.
 * 대상 페이지에 템플릿 페이지를 차례로 적용하고, 대상이 더 많으면 템플릿 첫 페이지부터 다시 반복한다.
 * settings: true면 규격·방향·배치·여백도 템플릿대로 바꾼다.
 */
export async function applyTemplate(id, { indexes = [state.current], settings = true } = {}) {
  sync();
  const tpl = await getTemplate(id);
  if (!tpl) throw new Error('템플릿을 찾을 수 없습니다');
  const tplPages = templatePages(tpl);
  const targets = indexes.map(pageAt).filter(Boolean);
  if (!targets.length) throw new Error('먼저 페이지를 추가하세요');

  const assetIds = new Map();
  for (const [oldId, a] of Object.entries(tpl.assets || {})) {
    const { assetId } = await importImageAsset(new Blob([a.bytes], { type: a.mime }));
    assets.get(assetId).name = a.name;
    assetIds.set(oldId, assetId);
  }

  const added = [];
  targets.forEach((page, k) => {
    const tp = tplPages[k % tplPages.length];
    if (settings) {
      Object.assign(page, clone(tp.settings));
      layoutPage(page);
    }
    // 페이지 크기가 다르면 위치만 비율로 옮기고 크기는 유지한다
    const sx = page.width / tp.width;
    const sy = page.height / tp.height;
    for (const src of tp.objects) {
      const o = { ...clone(src), id: uid(), cx: src.cx * sx, cy: src.cy * sy };
      if (o.type === 'image') o.assetId = assetIds.get(src.assetId);
      page.objects.push(o);
      if (page === currentPage()) added.push(o.id);
    }
  });
  commit('template');
  await refresh({ fit: settings, select: added });
  return targets.length;
}

/**
 * PDF 저장 → Uint8Array
 * merge: true면 나눠서 불러온 페이지(splitGroup)가 순서대로 이어져 있을 때 다시 한 페이지로 합친다
 */
export async function exportDocument({ merge = false } = {}) {
  editor.exitEditing();
  sync();
  commit('canvas');
  if (!state.doc.pages.length) throw new Error('저장할 페이지가 없습니다');
  return exportPdf(merge ? { pages: mergeSplitPages(state.doc.pages) } : state.doc);
}

/** 같은 원본에서 나눈 페이지가 순서대로 이어진 묶음들 → [[page, page, ...], ...] (2쪽 이상만) */
export function splitRuns(pages = state.doc.pages) {
  const runs = [];
  for (let i = 0; i < pages.length; i++) {
    const g = pages[i].splitGroup;
    if (!g) continue;
    const run = [pages[i]];
    while (pages[i + 1]?.splitGroup?.id === g.id && pages[i + 1].splitGroup.part > run[run.length - 1].splitGroup.part) run.push(pages[++i]);
    if (run.length > 1) runs.push(run);
  }
  return runs;
}

/** 이어진 묶음을 세로로 쌓아 한 페이지로. 각 부분은 원래 페이지 영역만 보이도록 parts로 나눠 둔다 */
function mergeSplitPages(pages) {
  const runs = new Map(splitRuns(pages).map(run => [run[0], run]));
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    const run = runs.get(pages[i]);
    if (!run) { out.push(pages[i]); continue; }
    const width = Math.max(...run.map(p => p.width));
    let y = 0;
    const parts = run.map(p => {
      const part = { dx: (width - p.width) / 2, dy: y, width: p.width, height: p.height, objects: p.objects };
      y += p.height;
      return part;
    });
    out.push({ width, height: y, parts, objects: [] });
    i += run.length - 1;
  }
  return out;
}

/**
 * 페이지를 PNG·JPG로 → [{ pageIndex, bytes, width, height }]
 * opts: { indexes(기본: 현재 페이지), format: 'png'│'jpg', dpi(기본 300),
 *         background: 'white'│'page'(페이지 빈 곳 투명)│'all'(흰색 부분 모두 투명) — PNG만 }
 */
export async function exportImages({ indexes = [state.current], format = 'png', dpi = 300, background = 'white', merge = false, onProgress } = {}) {
  editor.exitEditing();
  sync();
  commit('canvas');
  const list = indexes.filter(i => pageAt(i));
  if (!list.length) throw new Error('저장할 페이지가 없습니다');
  // merge: 나눠 불러온 페이지가 이어져 있으면 한 장의 긴 이미지로 (pageIndex는 묶음의 첫 페이지)
  const pages = list.map(pageAt);
  const merged = merge ? mergeSplitPages(pages) : pages;
  const firstIndex = [];
  for (let i = 0, k = 0; i < merged.length; i++) {
    firstIndex.push(list[k]);
    k += merged[i].parts ? merged[i].parts.length : 1;
  }
  const pdf = await exportPdf({ pages: merged });
  const images = await renderPdfToImages(pdf, { format, dpi, background, onProgress });
  return images.map(img => ({ ...img, pageIndex: firstIndex[img.index], merged: !!merged[img.index].parts }));
}

/** 문서 구조(바이너리 제외) 복사본 */
export function getDocument() {
  sync();
  return clone({ current: state.current, pages: state.doc.pages });
}
