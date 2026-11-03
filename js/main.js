// 화면 구성과 입력 처리

import { state, on, canUndo, canRedo, currentPage, findObject, PT_PER_MM, MAX_PAGE_MM, MAX_PAGE_PT } from './state.js';
import * as cmd from './commands.js';
import * as editor from './canvas.js';
import { initFonts, listFonts, fontInfo, addUserFont, removeUserFont, provideSystemFontFile } from './fonts.js';
import { thumbFor, cachedThumb } from './thumbs.js';
import { ACCEPT_FILES, ACCEPT_IMAGES, isPdf, isImage } from './importer.js';
import { createApi } from './api.js';
import { listTemplates, deleteTemplate } from './templates.js';
import { startTour, shouldAutoStart } from './tour.js';
import { DEFAULT_ALIGN } from './pageSize.js';
import { makeZip } from './zip.js';
import { ensureEntry, trackExport } from './gate.js';
import { bindAdminAuth, getAdminToken } from './adminAuth.js';
import { TRACKING_URL } from './config.js';
import { extensions } from './extensions/index.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const toMm = pt => Math.round((pt / PT_PER_MM) * 10) / 10;
const toPt = mm => mm * PT_PER_MM;

const TYPE_LABEL = { pdfpage: 'PDF 원본 페이지', image: '이미지', text: '텍스트', rect: '네모', ellipse: '동그라미' };
const FONT_SOURCE_LABEL = { file: '기본 포함', system: 'Windows 기본 · 저장 시 PC에서 불러옴', user: '직접 추가' };

let docName = '';
let selection = [];

// ── 공통 ──────────────────────────────────────────────

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

async function withBusy(msg, fn) {
  $('#busyMsg').textContent = msg;
  $('#busy').hidden = false;
  try {
    return await fn();
  } finally {
    $('#busy').hidden = true;
  }
}

function setVal(sel, v) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (el !== document.activeElement) el.value = v;
}

function needPage() {
  if (currentPage()) return true;
  toast('먼저 파일을 열거나 빈 페이지를 추가하세요');
  return false;
}

const selectedObjects = () => selection.map(id => findObject(id)?.obj).filter(Boolean);

// ── 시작 ──────────────────────────────────────────────

async function boot() {
  // 입장 확인을 마치기 전에는 편집기 기능을 연결하지 않는다 (버튼·단축키·끌어다 놓기 모두 동작 안 함)
  await ensureEntry();
  $('#fileOpen').accept = ACCEPT_FILES;
  $('#fileImage').accept = ACCEPT_IMAGES;
  await withBusy('폰트 불러오는 중…', initFonts);

  editor.initEditor($('#editorCanvas'), $('#stage'), {
    onModified: () => cmd.canvasModified(),
    onSelection: ids => { selection = ids; renderObjectPanel(); },
    onZoom: z => { $('#zoomLabel').textContent = `${Math.round(z * 100)}%`; },
    onCrop: active => { $('#cropBar').hidden = !active; },
    onDragMove: e => markDropTarget(pageItemAt(e)),
    onDragDrop: (e, ids) => {
      const li = pageItemAt(e);
      markDropTarget(null);
      const index = li ? state.doc.pages.findIndex(p => p.id === li.dataset.id) : -1;
      if (index < 0 || index === state.current) return false;
      cmd.moveObjectsToPage(ids, index).then(n => {
        if (!n) return;
        toast(`${n}개 요소를 ${index + 1}쪽으로 옮겼습니다 (Ctrl+Z로 되돌리기)`);
        const target = $(`#pageList [data-id="${state.doc.pages[index].id}"]`);
        target?.classList.add('drop-done');
        setTimeout(() => target?.classList.remove('drop-done'), 900);
      });
      return true;
    },
  });

  bindToolbar();
  bindPagePanel();
  bindObjectPanel();
  bindFontPanel();
  bindTemplatePanel();
  bindContextMenu();
  bindPageTools();
  bindKeyboard();
  bindDragDrop();
  Sortable.create($('#pageList'), {
    animation: 150,
    filter: '.page-check', // 체크 상자를 누를 때는 끌기를 시작하지 않는다
    preventOnFilter: false,
    onEnd: e => cmd.movePage(e.oldIndex, e.newIndex),
  });

  on('change', refreshUi);
  on('navigate', refreshUi);
  renderFontPanel();
  renderTemplatePanel().catch(e => console.error('템플릿 목록을 읽지 못했습니다', e));
  refreshUi();

  $('#btnHelp').onclick = startTour;
  bindAdminButton();
  if (shouldAutoStart()) startTour();

  window.addEventListener('beforeunload', e => {
    if (state.doc.pages.length) e.preventDefault();
  });

  const api = createApi();
  window.PDFEditor = api;
  for (const ext of extensions) {
    try {
      await ext.install({ api, slot: $('#extensionSlot') });
    } catch (e) {
      console.error(`확장 ${ext.id} 설치 실패`, e);
    }
  }
}

function refreshUi() {
  const hasPages = state.doc.pages.length > 0;
  $('#emptyState').hidden = hasPages;
  $('#canvasWrap').hidden = !hasPages;
  $('#btnUndo').disabled = !canUndo();
  $('#btnRedo').disabled = !canRedo();
  renderPageList();
  renderPagePanel();
  renderObjectPanel();
}

// ── 상단 도구 ─────────────────────────────────────────

async function openFilesUi(files, at) {
  if (!files.length) return;
  const { added, errors } = await withBusy('파일 여는 중…', () => cmd.openFiles(files, at, { askSplit }));
  if (!docName && added) docName = files[0].name.replace(/\.[^.]+$/, '');
  if (errors.length) toast(errors.join('\n'), 6000);
  else if (added) toast(`${added}페이지를 추가했습니다`);
}

/** 이미지를 현재 페이지 위에 올릴지, 새 페이지로 추가할지 묻고 넣는다 (페이지가 없으면 새 페이지로) */
async function insertImagesUi(files) {
  if (!files.length) return;
  if (!currentPage()) return openFilesUi(files);
  $('#insertMsg').textContent = `이미지 ${files.length}개를 넣습니다. 현재 ${state.doc.pages.length}쪽 중 ${state.current + 1}쪽을 편집하고 있습니다.`;
  $('#insertHere').textContent = `현재 페이지(${state.current + 1}쪽) 위에 올리기`;
  const where = await choose($('#insertDialog'));
  if (where === 'new') return openFilesUi(files);
  if (where !== 'here') return;
  try {
    await withBusy('이미지 넣는 중…', () => cmd.insertImages(files));
  } catch (e) {
    toast(`이미지를 넣지 못했습니다: ${e.message}`, 5000);
  }
}

function bindToolbar() {
  $('#btnOpen').onclick = () => $('#fileOpen').click();
  $('#fileOpen').onchange = async e => {
    await openFilesUi([...e.target.files]);
    e.target.value = '';
  };
  $('#btnInsertImage').onclick = () => $('#fileImage').click();
  $('#fileImage').onchange = async e => {
    await insertImagesUi([...e.target.files]);
    e.target.value = '';
  };
  $('#btnText').onclick = async () => {
    if (!needPage()) return;
    const id = await cmd.addText();
    editor.editText(id);
  };
  $('#btnRect').onclick = () => needPage() && cmd.addShape('rect');
  $('#btnEllipse').onclick = () => needPage() && cmd.addShape('ellipse');
  $('#btnUndo').onclick = () => cmd.undo();
  $('#btnRedo').onclick = () => cmd.redo();
  $('#btnZoomIn').onclick = () => editor.setZoom(editor.getZoom() * 1.25);
  $('#btnZoomOut').onclick = () => editor.setZoom(editor.getZoom() / 1.25);
  $('#btnZoomFit').onclick = () => editor.fitToStage();
  $('#btnExport').onclick = doExport;
  imagePages = bindPageRange($('#imgRange'), $('#imgPages'));
  const syncBg = () => {
    // 투명 배경은 PNG만 가능
    const png = $('#imgFormat').value === 'png';
    $('#imgBg').disabled = !png;
    if (!png) $('#imgBg').value = 'white';
  };
  $('#imgFormat').onchange = syncBg;
  $('#btnExportImage').onclick = () => {
    if (!state.doc.pages.length) return toast('저장할 페이지가 없습니다');
    syncBg();
    $('#imgMergeRow').hidden = !cmd.splitRuns().length;
    if (checkedPages.size) {
      $('#imgRange').value = 'selected';
      $('#imgRange').dispatchEvent(new Event('change'));
    }
    $('#imageExportDialog').showModal();
  };
  $('#imageExportForm').addEventListener('submit', e => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    doExportImages();
  });
  $('#btnAddPage').onclick = () => cmd.addBlankPage();

  $('#stage').addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    editor.setZoom(editor.getZoom() * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });
}

// ── 페이지 목록 ───────────────────────────────────────

// 왼쪽 목록에서 고른 페이지 (화면 상태라 실행 취소 기록에는 넣지 않는다)
const checkedPages = new Set();
let lastChecked = null;

const checkedIndexes = () => state.doc.pages.map((p, i) => (checkedPages.has(p.id) ? i : -1)).filter(i => i >= 0);

function toggleChecked(i, { range = false } = {}) {
  const pages = state.doc.pages;
  if (range && lastChecked != null) {
    const from = pages.findIndex(p => p.id === lastChecked);
    if (from >= 0) {
      for (let k = Math.min(from, i); k <= Math.max(from, i); k++) checkedPages.add(pages[k].id);
      return renderPageList();
    }
  }
  const id = pages[i].id;
  if (checkedPages.has(id)) checkedPages.delete(id);
  else checkedPages.add(id);
  lastChecked = id;
  renderPageList();
}

function renderPageTools() {
  const pages = state.doc.pages;
  for (const id of [...checkedPages]) if (!pages.some(p => p.id === id)) checkedPages.delete(id);
  const n = checkedPages.size;
  const all = pages.length > 0 && n === pages.length;
  $('#btnSelectPages').textContent = all ? '선택 해제' : '전체 선택';
  $('#btnDeletePages').textContent = n && !all ? `선택 삭제 (${n})` : '전체 삭제';
  $('#btnSelectPages').disabled = $('#btnDeletePages').disabled = !pages.length;
  $('#btnApplySelected').disabled = !n;
  $('#btnApplySelected').textContent = n ? `선택한 ${n}쪽에 적용` : '선택한 페이지에 적용';
  $('#pageList').classList.toggle('selecting', n > 0);
}

function bindPageTools() {
  $('#btnSelectPages').onclick = () => {
    const pages = state.doc.pages;
    if (checkedPages.size === pages.length) checkedPages.clear();
    else pages.forEach(p => checkedPages.add(p.id));
    renderPageList();
  };
  $('#btnDeletePages').onclick = async () => {
    const pages = state.doc.pages;
    const picked = checkedIndexes();
    const indexes = picked.length ? picked : pages.map((_, i) => i);
    const all = indexes.length === pages.length;
    if (!confirm(all ? `${pages.length}쪽 전체를 삭제할까요?\nCtrl+Z로 되돌릴 수 있습니다.` : `선택한 ${indexes.length}쪽을 삭제할까요?\nCtrl+Z로 되돌릴 수 있습니다.`)) return;
    const n = await cmd.deletePages(indexes);
    checkedPages.clear();
    renderPageList();
    toast(`${n}쪽을 삭제했습니다 (Ctrl+Z로 되돌리기)`);
  };
}

function renderPageList() {
  const pages = state.doc.pages;
  $('#pageCount').textContent = pages.length;
  renderPageTools();
  $('#pageList').replaceChildren(...pages.map((page, i) => {
    const li = document.createElement('li');
    li.className = `page-item${i === state.current ? ' active' : ''}${checkedPages.has(page.id) ? ' checked' : ''}`;
    li.dataset.id = page.id;
    li.innerHTML = `
      <input type="checkbox" class="page-check" title="페이지 선택 (Shift+클릭: 범위 선택)" aria-label="${i + 1}페이지 선택"${checkedPages.has(page.id) ? ' checked' : ''}>
      <div class="thumb"><img alt="${i + 1}페이지" style="aspect-ratio:${page.width}/${page.height}"></div>
      <div class="page-meta">
        <span class="num">${i + 1}</span>
        <span class="acts">
          <button data-act="dup" title="페이지 복제">복제</button>
          <button data-act="rot" title="시계 방향 90° 회전">회전</button>
          <button data-act="del" title="페이지 삭제">삭제</button>
        </span>
      </div>`;
    const url = cachedThumb(page.id);
    if (url) li.querySelector('img').src = url;
    li.addEventListener('click', e => {
      const act = e.target.closest('button')?.dataset.act;
      if (e.target.matches('.page-check') || (!act && (e.ctrlKey || e.metaKey || e.shiftKey))) {
        // 체크 상자, Ctrl+클릭: 하나씩 / Shift+클릭: 범위 선택 (페이지는 넘기지 않음)
        if (!e.target.matches('.page-check')) e.preventDefault();
        return toggleChecked(i, { range: e.shiftKey });
      }
      if (act === 'dup') cmd.duplicatePage(i);
      else if (act === 'rot') cmd.rotatePage(i);
      else if (act === 'del') cmd.deletePage(i).then(() => toast('페이지를 삭제했습니다 (Ctrl+Z로 되돌리기)'));
      else cmd.goToPage(i);
    });
    return li;
  }));
  $('#pageList .active')?.scrollIntoView({ block: 'nearest' });
  scheduleThumbs();
}

/** 마우스 아래의 페이지 목록 항목 (현재 페이지 제외) */
function pageItemAt(e) {
  const p = e?.changedTouches?.[0] || e;
  if (!p || p.clientX == null) return null;
  const li = document.elementFromPoint(p.clientX, p.clientY)?.closest?.('#pageList .page-item');
  return li && !li.classList.contains('active') ? li : null;
}

function markDropTarget(li) {
  for (const el of $$('#pageList .drop-target')) if (el !== li) el.classList.remove('drop-target');
  li?.classList.add('drop-target');
}

let thumbTimer;
function scheduleThumbs() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(async () => {
    for (const page of [...state.doc.pages]) {
      try {
        const url = await thumbFor(page);
        const img = $(`#pageList li[data-id="${page.id}"] img`);
        if (img && img.src !== url) img.src = url;
      } catch (e) {
        console.warn('미리보기 실패', e);
      }
    }
  }, 200);
}

// ── 페이지 설정 ───────────────────────────────────────

const PAGE_HINTS = {
  a4: '210 × 297mm 용지에 원본을 배치 방식대로 맞춥니다.',
  original: '원본 PDF 페이지·이미지 크기를 그대로 씁니다.',
  fit: '원본 배경이 차지하는 영역에 상하좌우 영역을 더해 페이지 크기를 정합니다. 더한 영역에 텍스트를 넣을 수 있습니다.',
  custom: '너비×높이 영역에 원본을 배치하고, 필요하면 상하좌우로 영역을 더합니다. 페이지 전체 크기는 오른쪽 위에 표시됩니다.',
};

const marginOf = page => ({ top: 0, right: 0, bottom: 0, left: 0, ...page.margin });
let lastMarginSide = 'top'; // '모든 영역 동일 여백'을 켤 때 기준이 되는 마지막 수정 칸

/**
 * 바꾼 뒤 페이지 전체 크기가 PDF 최대 크기(5080mm)를 넘으면 안내하고 false.
 * 이미 넘는 페이지를 줄이는 것은 막지 않는다.
 */
function withinLimit(page, { customW = page.customW, customH = page.customH, margin = marginOf(page) } = {}) {
  const old = marginOf(page);
  const curW = page.width / PT_PER_MM;
  const curH = page.height / PT_PER_MM;
  let w = curW;
  let h = curH;
  if (page.sizeMode === 'custom') {
    w = customW + margin.left + margin.right;
    h = customH + margin.top + margin.bottom;
  } else if (page.sizeMode === 'fit') {
    w = curW - old.left - old.right + margin.left + margin.right;
    h = curH - old.top - old.bottom + margin.top + margin.bottom;
  }
  const over = (v, cur) => v > MAX_PAGE_MM + 0.05 && v > cur + 0.05;
  if (!over(w, curW) && !over(h, curH)) return true;
  toast(`PDF 페이지는 가로·세로 최대 ${MAX_PAGE_MM}mm(200인치)까지 만들 수 있습니다.\n여백 포함 ${Math.round(Math.max(w, h))}mm가 되어 적용하지 않았습니다.`, 6000);
  renderPagePanel();
  return false;
}

function renderPagePanel() {
  const page = currentPage();
  $('#pagePanel').classList.toggle('disabled', !page);
  if (!page) {
    $('#pageSizeInfo').textContent = '';
    $('#pageHint').textContent = '페이지를 추가하면 설정할 수 있습니다.';
    return;
  }
  const hasBase = !!page.baseId;
  const fixedSize = page.sizeMode === 'original' || page.sizeMode === 'fit';
  setVal('#pageSizeMode', page.sizeMode);
  for (const opt of $('#pageSizeMode').options) {
    if (opt.value === 'original' || opt.value === 'fit') opt.disabled = !hasBase;
  }
  $('#customFields').hidden = page.sizeMode !== 'custom';
  setVal('#pageCustomW', Math.round(page.customW * 10) / 10);
  setVal('#pageCustomH', Math.round(page.customH * 10) / 10);
  $('#marginFields').hidden = page.sizeMode !== 'fit' && page.sizeMode !== 'custom';
  for (const input of $$('#marginFields input')) {
    setVal(input, Math.round(marginOf(page)[input.dataset.margin] * 10) / 10);
  }
  $('#alignFields').hidden = !hasBase || (page.sizeMode !== 'a4' && page.sizeMode !== 'custom');
  setVal('#pageAlignH', page.align?.h || 'center');
  setVal('#pageAlignV', page.align?.v || 'middle');
  for (const b of $$('#pageOrientation button')) {
    b.classList.toggle('active', b.dataset.orient === page.orientation);
    b.disabled = fixedSize;
  }
  setVal('#pageFitMode', page.fitMode);
  $('#pageFitMode').disabled = !hasBase || fixedSize;
  $('#pageSizeInfo').textContent = `${toMm(page.width)} × ${toMm(page.height)} mm`;
  $('#pageHint').textContent = PAGE_HINTS[page.sizeMode] + (hasBase ? '' : ' (빈 페이지)');
}

function bindPagePanel() {
  $('#pageSizeMode').onchange = e => {
    const page = currentPage();
    const settings = { sizeMode: e.target.value };
    if (settings.sizeMode === 'custom') Object.assign(settings, cmd.customSizeOf(page));
    cmd.setPageSettings(settings);
  };
  const onAlign = () => cmd.setPageSettings({ align: { h: $('#pageAlignH').value, v: $('#pageAlignV').value } });
  $('#pageAlignH').onchange = onAlign;
  $('#pageAlignV').onchange = onAlign;
  const onCustom = () => {
    const w = parseFloat($('#pageCustomW').value);
    const h = parseFloat($('#pageCustomH').value);
    if (!(w >= 10 && h >= 10)) return renderPagePanel();
    if (withinLimit(currentPage(), { customW: w, customH: h })) cmd.setPageSettings({ customW: w, customH: h });
  };
  $('#pageCustomW').onchange = onCustom;
  $('#pageCustomH').onchange = onCustom;
  const setMargin = (side, v) => {
    const page = currentPage();
    if (!page) return;
    if (!(v >= 0)) { renderPagePanel(); return; }
    lastMarginSide = side;
    const margin = $('#marginSame').checked
      ? { top: v, right: v, bottom: v, left: v }
      : { ...marginOf(page), [side]: v };
    if (withinLimit(page, { margin })) cmd.setPageSettings({ margin });
  };
  $('#marginFields').onchange = e => {
    if (e.target.id === 'marginSame') {
      // 켜는 순간 마지막으로 고친 칸의 값을 네 칸 모두에 넣는다
      if (e.target.checked) setMargin(lastMarginSide, parseFloat($(`[data-margin=${lastMarginSide}]`).value));
      return;
    }
    if (e.target.dataset.margin) setMargin(e.target.dataset.margin, parseFloat(e.target.value));
  };
  $('#pageOrientation').onclick = e => {
    const orient = e.target.closest('button')?.dataset.orient;
    const page = currentPage();
    if (!orient || !page || orient === page.orientation) return;
    if (page.sizeMode === 'custom') cmd.setPageSettings({ customW: page.customH, customH: page.customW }, undefined, { fit: true });
    else cmd.setPageSettings({ orientation: orient });
  };
  $('#pageFitMode').onchange = e => cmd.setPageSettings({ fitMode: e.target.value });
  // 지금 페이지의 규격·방향·배치·여백·정렬을 다른 페이지에 똑같이
  const applyTo = async indexes => {
    const page = currentPage();
    if (!page || !indexes.length) return;
    const { sizeMode, orientation, fitMode, customW, customH } = page;
    const settings = { sizeMode, orientation, fitMode, customW, customH, margin: marginOf(page), align: { ...DEFAULT_ALIGN, ...page.align } };
    await cmd.setPageSettings(settings, indexes);
  };
  $('#btnApplyAll').onclick = async () => {
    await applyTo(state.doc.pages.map((_, i) => i));
    toast('모든 페이지에 같은 설정을 적용했습니다');
  };
  $('#btnApplySelected').onclick = async () => {
    const indexes = checkedIndexes();
    if (!indexes.length) return toast('왼쪽 페이지 목록에서 적용할 페이지를 먼저 선택하세요');
    await applyTo(indexes);
    toast(`선택한 ${indexes.length}쪽에 같은 설정을 적용했습니다`);
  };
  $('#btnUnlockAll').onclick = async () => {
    const n = await cmd.unlockAll();
    toast(n ? `${n}개 요소의 잠금을 풀었습니다` : '잠긴 요소가 없습니다');
  };
}

// ── 요소 속성 ─────────────────────────────────────────

function renderObjectPanel() {
  const objs = selectedObjects();
  $('#objectPanel').hidden = !objs.length;
  if (!objs.length) return;
  const o = objs[0];
  const single = objs.length === 1;
  const allText = objs.every(x => x.type === 'text');
  const allShape = objs.every(x => x.type === 'rect' || x.type === 'ellipse');

  $('#objectTitle').textContent = `선택한 요소 · ${single ? TYPE_LABEL[o.type] : `${objs.length}개`}`;
  const geom = { x: toMm(o.cx - o.w / 2), y: toMm(o.cy - o.h / 2), w: toMm(o.w), h: toMm(o.h), angle: Math.round(o.angle * 10) / 10 };
  for (const input of $$('[data-geom]')) {
    const key = input.dataset.geom;
    input.disabled = !single || (key === 'h' && o.type === 'text');
    setVal(input, single ? geom[key] : '');
  }
  setVal('#propOpacity', Math.round((o.opacity ?? 1) * 100));
  $('#propOpacityVal').textContent = `${Math.round((o.opacity ?? 1) * 100)}%`;

  $('#textFields').hidden = !allText;
  if (allText) {
    setVal('#propFont', fontInfo(o.fontFamily).key);
    setVal('#propFontSize', Math.round(o.fontSize * 10) / 10);
    setVal('#propLineHeight', o.lineHeight);
    setVal('#propColor', o.color);
    $('#propBold').classList.toggle('active', !!o.bold);
    $('#propBold').disabled = !fontInfo(o.fontFamily).hasBold;
    for (const b of $$('#propAlign button')) b.classList.toggle('active', b.dataset.align === o.align);
  }

  $('#shapeFields').hidden = !allShape;
  if (allShape) {
    $('#propFillNone').checked = !o.fill;
    setVal('#propFill', o.fill || '#ffffff');
    $('#propStrokeNone').checked = !o.stroke;
    setVal('#propStroke', o.stroke || '#000000');
    setVal('#propStrokeWidth', o.strokeWidth);
  }
  $('#btnPaste').disabled = !cmd.hasClipboard();
}

function bindObjectPanel() {
  const update = (props, opts) => cmd.updateObjects(selection, props, opts);

  for (const input of $$('[data-geom]')) {
    input.onchange = () => {
      const v = parseFloat(input.value);
      const [o] = selectedObjects();
      if (!o || Number.isNaN(v)) return;
      const key = input.dataset.geom;
      if (key === 'x') update({ cx: toPt(v) + o.w / 2 });
      else if (key === 'y') update({ cy: toPt(v) + o.h / 2 });
      else if (key === 'w' && v > 0) update({ w: toPt(v), cx: o.cx - o.w / 2 + toPt(v) / 2 }); // 왼쪽 위 고정
      else if (key === 'h' && v > 0) update({ h: toPt(v), cy: o.cy - o.h / 2 + toPt(v) / 2 });
      else if (key === 'angle') update({ angle: ((v % 360) + 360) % 360 });
    };
  }

  const opacity = $('#propOpacity');
  opacity.oninput = () => {
    $('#propOpacityVal').textContent = `${opacity.value}%`;
    update({ opacity: opacity.value / 100 }, { record: false });
  };
  opacity.onchange = () => update({ opacity: opacity.value / 100 });

  // 텍스트
  $('#propFont').onchange = e => {
    const font = fontInfo(e.target.value);
    update(o => ({ fontFamily: font.key, bold: font.hasBold ? o.bold : false }));
  };
  $('#propFontSize').onchange = e => {
    const v = parseFloat(e.target.value);
    if (v > 0) update({ fontSize: v });
  };
  $('#propLineHeight').onchange = e => {
    const v = parseFloat(e.target.value);
    if (v > 0) update({ lineHeight: v });
  };
  $('#propColor').oninput = e => update({ color: e.target.value }, { record: false });
  $('#propColor').onchange = e => update({ color: e.target.value });
  $('#propBold').onclick = () => {
    const [o] = selectedObjects();
    update({ bold: !o.bold });
  };
  $('#propAlign').onclick = e => {
    const align = e.target.closest('button')?.dataset.align;
    if (align) update({ align });
  };

  // 도형
  $('#propFill').oninput = e => update({ fill: e.target.value }, { record: false });
  $('#propFill').onchange = e => update({ fill: e.target.value });
  $('#propFillNone').onchange = e => update({ fill: e.target.checked ? null : $('#propFill').value });
  $('#propStroke').oninput = e => update({ stroke: e.target.value }, { record: false });
  $('#propStroke').onchange = e => update({ stroke: e.target.value });
  $('#propStrokeNone').onchange = e => update({ stroke: e.target.checked ? null : $('#propStroke').value });
  $('#propStrokeWidth').onchange = e => {
    const v = parseFloat(e.target.value);
    if (v > 0) update({ strokeWidth: v });
  };

  for (const b of $$('[data-arrange]')) b.onclick = () => cmd.arrange(selection, b.dataset.arrange);

  $('#btnLock').onclick = async () => {
    await cmd.setLocked(selection, true);
    toast('잠갔습니다. 페이지 설정의 [잠금 모두 해제]로 풀 수 있습니다', 3500);
  };
  $('#btnObjectClose').onclick = () => editor.clearSelection();
  $('#btnCopy').onclick = () => copySelection();
  $('#btnPaste').onclick = () => cmd.paste();
  $('#btnDuplicate').onclick = () => cmd.duplicateObjects(selection);
  $('#btnDelete').onclick = () => cmd.deleteObjects(selection);
}

// 편집기 안에서 요소를 복사하면 Windows 클립보드에도 표시 글자를 넣어 둔다.
// 붙여넣을 때 이 표시가 그대로면 편집기 요소를, 그 사이 다른 곳에서 이미지를 복사했으면 그 이미지를 넣는다.
// (표시가 없으면 예전에 복사해 둔 엉뚱한 이미지가 붙어 버린다)
let clipMark = null;
let clipMarkFailed = false;

function markSystemClipboard(n) {
  clipMark = `[PDF 편집기 요소 ${n}개 복사됨 #${Date.now()}]`;
  const onCopy = e => { e.preventDefault(); e.clipboardData.setData('text/plain', clipMark); };
  document.addEventListener('copy', onCopy);
  let done = false;
  try { done = document.execCommand('copy'); } catch { /* 지원 안 함 */ }
  document.removeEventListener('copy', onCopy);
  clipMarkFailed = !done;
  if (!done) navigator.clipboard?.writeText(clipMark).then(() => { clipMarkFailed = false; }, () => {});
}

function copyElements(ids) {
  const n = cmd.copyObjects(ids);
  if (n) {
    markSystemClipboard(n);
    $('#btnPaste').disabled = false;
  }
  return n;
}

function copySelection() {
  const n = copyElements(selection);
  if (n) toast(`${n}개 요소를 복사했습니다`);
}

async function cutSelection(ids = selection) {
  const n = copyElements(ids);
  if (!n) return;
  await cmd.deleteObjects(ids);
  toast(`${n}개 요소를 잘라냈습니다. Ctrl+V로 붙여 넣으세요`);
}

// ── 폰트 ──────────────────────────────────────────────

function renderFontPanel() {
  const fonts = listFonts();
  $('#fontList').replaceChildren(...fonts.map(f => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="font-name"></span><span class="muted">${FONT_SOURCE_LABEL[f.source]}</span>`;
    const name = li.querySelector('.font-name');
    name.textContent = f.label;
    name.style.fontFamily = `"${f.css}"`;
    if (f.source === 'user') {
      const del = document.createElement('button');
      del.className = 'small';
      del.textContent = '삭제';
      del.onclick = async () => {
        if (!confirm(`'${f.label}' 폰트를 삭제할까요? 이 폰트를 쓰던 텍스트는 기본 폰트로 표시됩니다.`)) return;
        await removeUserFont(f.key);
        renderFontPanel();
        editor.renderCurrentPage();
      };
      li.append(del);
    }
    return li;
  }));
  const select = $('#propFont');
  select.replaceChildren(...fonts.map(f => new Option(f.label, f.key)));
  renderObjectPanel();
}

function bindFontPanel() {
  const dialog = $('#fontDialog');
  $('#btnAddFont').onclick = () => dialog.showModal();
  $('#fontForm').addEventListener('submit', async e => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    try {
      await addUserFont($('#fontName').value, $('#fontRegular').files[0], $('#fontBold').files[0]);
      dialog.close();
      $('#fontForm').reset();
      renderFontPanel();
      toast('폰트를 추가했습니다');
    } catch (err) {
      console.error(err);
      toast('폰트 파일을 읽을 수 없습니다. TTF 또는 OTF 파일인지 확인하세요.', 5000);
    }
  });
}

// ── 페이지 범위 (예: "1-3, 5") ────────────────────────

/** "1-3, 5" → [0, 1, 2, 4]. 잘못된 입력이면 안내 문구와 함께 Error */
function parsePageRange(text, count) {
  const out = new Set();
  const parts = text.split(/[,\s]+/).filter(Boolean);
  if (!parts.length) throw new Error('페이지 번호를 입력하세요 (예: 1-3, 5)');
  for (const part of parts) {
    const m = /^(\d+)(?:[-~](\d+))?$/.exec(part);
    if (!m) throw new Error(`'${part}'은(는) 페이지 번호가 아닙니다 (예: 1-3, 5)`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < 1 || a > count || b > count) throw new Error(`페이지는 1~${count} 사이로 입력하세요`);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(i - 1);
  }
  return [...out].sort((x, y) => x - y);
}

/** 범위 선택칸(현재/모든/지정)과 입력칸을 묶는다 → 선택된 페이지 인덱스를 돌려주는 함수 */
function bindPageRange(select, input) {
  select.addEventListener('change', () => {
    input.hidden = select.value !== 'pick';
    if (!input.hidden) {
      input.value ||= `${state.current + 1}`;
      input.focus();
    }
  });
  return () => {
    const n = state.doc.pages.length;
    if (select.value === 'all') return state.doc.pages.map((_, i) => i);
    if (select.value === 'pick') return parsePageRange(input.value, n);
    if (select.value === 'selected') {
      const picked = checkedIndexes();
      if (!picked.length) throw new Error('왼쪽 페이지 목록에서 페이지를 먼저 선택하세요 (체크 상자, Ctrl·Shift+클릭)');
      return picked;
    }
    return [state.current];
  };
}

// ── 자주 쓰는 템플릿 ──────────────────────────────────

async function renderTemplatePanel(selectId) {
  const list = await listTemplates();
  const select = $('#templateSelect');
  const keep = selectId || select.value;
  select.replaceChildren(...(list.length
    ? list.map(t => new Option(`${t.name} (${t.pages > 1 ? `${t.pages}쪽, ` : ''}요소 ${t.count}개)`, t.id))
    : [new Option('저장된 템플릿이 없습니다', '')]));
  if (list.some(t => t.id === keep)) select.value = keep;
  for (const id of ['#btnTemplateApply', '#btnTemplateApplyAll', '#btnTemplateDelete']) $(id).disabled = !list.length;
}

function bindTemplatePanel() {
  const dialog = $('#templateSaveDialog');
  const savePages = bindPageRange($('#templateRange'), $('#templatePages'));
  $('#btnTemplateSave').onclick = () => {
    if (!needPage()) return;
    if (checkedPages.size) {
      $('#templateRange').value = 'selected';
      $('#templateRange').dispatchEvent(new Event('change'));
    }
    $('#templateName').value = `템플릿 ${new Date().toLocaleDateString()}`;
    dialog.showModal();
    $('#templateName').select();
  };
  $('#templateSaveForm').addEventListener('submit', async e => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    try {
      const pages = savePages();
      const id = await cmd.saveTemplate($('#templateName').value, pages);
      dialog.close();
      await renderTemplatePanel(id);
      toast(`템플릿을 저장했습니다 (${pages.length}쪽)`);
    } catch (err) {
      toast(err.message, 5000); // 대부분 페이지 번호 입력 오류
    }
  });
  const apply = async all => {
    const id = $('#templateSelect').value;
    if (!id || !needPage()) return;
    // 여러 페이지 템플릿은 현재 페이지부터 템플릿 쪽수만큼 차례로 적용한다
    const tplPages = (await listTemplates()).find(t => t.id === id)?.pages || 1;
    const count = state.doc.pages.length;
    const indexes = all
      ? state.doc.pages.map((_, i) => i)
      : Array.from({ length: Math.min(tplPages, count - state.current) }, (_, k) => state.current + k);
    try {
      const n = await withBusy('템플릿 불러오는 중…', () => cmd.applyTemplate(id, { indexes, settings: $('#templateWithSettings').checked }));
      toast(`${n}개 페이지에 템플릿을 불러왔습니다`);
    } catch (e) {
      console.error(e);
      toast(e.message, 5000);
    }
  };
  $('#btnTemplateApply').onclick = () => apply(false);
  $('#btnTemplateApplyAll').onclick = () => apply(true);
  $('#btnTemplateDelete').onclick = async () => {
    const select = $('#templateSelect');
    if (!select.value) return;
    const label = select.selectedOptions[0].textContent;
    if (!confirm(`'${label}' 템플릿을 삭제할까요?`)) return;
    await deleteTemplate(select.value);
    await renderTemplatePanel();
    toast('템플릿을 삭제했습니다');
  };
}

// ── 관리자 모드 ───────────────────────────────────────

function bindAdminButton() {
  if (!TRACKING_URL) return; // 기록 서버를 설정해야 관리자 화면이 의미가 있다
  const dialog = $('#adminDialog');
  const done = on => {
    for (const el of dialog.querySelectorAll('.auth-request, .auth-greet')) el.hidden = on;
    dialog.querySelector('.auth-done').hidden = !on;
  };
  $('#btnAdmin').hidden = false;
  $('#btnAdmin').onclick = () => {
    if (getAdminToken()) {
      window.open('admin.html', '_blank', 'noopener');
      return;
    }
    done(false);
    bindAdminAuth(dialog, () => {
      for (const el of dialog.querySelectorAll('.auth-step2, .auth-error')) el.hidden = true;
      done(true);
    });
    dialog.showModal();
  };
  dialog.querySelector('.auth-done a').onclick = () => dialog.close();
}

// ── 저장 ──────────────────────────────────────────────

/** 대화상자를 열고 누른 버튼의 value를 돌려준다 (Esc는 '') */
function choose(dialog) {
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
    dialog.returnValue = '';
    dialog.showModal();
  });
}

/** 불러온 파일이 PDF 최대 높이를 넘을 때 나눌지 묻는다 → 'a4' | 'max' | 'none' */
async function askSplit({ name, w, h, count }) {
  const parts = mode => Math.ceil(h / cmd.splitHeight({ natW: w }, mode) - 1e-6);
  $('#splitMsg').innerHTML = '';
  $('#splitMsg').append(
    `‘${name}’${count > 1 ? `의 ${count}개 페이지` : ''}의 높이가 `,
    Object.assign(document.createElement('b'), { textContent: `${toMm(h)}mm` }),
    `로, PDF 최대 크기(${MAX_PAGE_MM}mm = 200인치)를 넘습니다. 그대로 저장하면 Adobe Acrobat 등에서 잘리거나 열리지 않을 수 있습니다.`,
  );
  $('#splitA4').textContent = `A4 비율로 나누기 (${parts('a4')}쪽)`;
  $('#splitMax').textContent = `최대 길이(${MAX_PAGE_MM}mm)로 나누기 (${parts('max')}쪽)`;
  return (await choose($('#splitDialog'))) || 'none';
}

async function doExport() {
  if (!state.doc.pages.length) return toast('저장할 페이지가 없습니다');
  let merge = false;
  const runs = cmd.splitRuns();
  if (runs.length) {
    const longest = Math.max(...runs.map(run => run.reduce((n, p) => n + p.height, 0)));
    $('#mergeMsg').textContent = `긴 파일을 나눠 불러온 페이지 ${runs.reduce((n, r) => n + r.length, 0)}쪽이 있습니다. 합치면 원래처럼 긴 한 페이지(최대 ${toMm(longest)}mm)가 됩니다.`
      + (longest > MAX_PAGE_PT ? ` ${MAX_PAGE_MM}mm를 넘는 페이지는 Chrome·Edge에서는 열리지만 Adobe Acrobat 등 일부 프로그램에서는 잘려 보일 수 있습니다.` : '');
    const answer = await choose($('#mergeDialog'));
    if (!answer || answer === 'cancel') return;
    merge = answer === 'merge';
  }
  try {
    const bytes = await withBusy('PDF 만드는 중…', () => cmd.exportDocument({ merge }));
    download(bytes, `${docName || 'document'}_편집.pdf`);
    trackExport('pdf');
    toast(`저장했습니다 (${(bytes.length / 1048576).toFixed(1)}MB)`);
  } catch (e) {
    if (e.code === 'NEED_FONT_FILE') askFontFile(e);
    else {
      console.error(e);
      toast(`저장하지 못했습니다: ${e.message}`, 6000);
    }
  }
}

let imagePages = () => [state.current]; // bindToolbar에서 범위 선택칸과 연결

async function doExportImages() {
  const dialog = $('#imageExportDialog');
  const format = $('#imgFormat').value;
  const dpi = Number($('#imgDpi').value);
  const background = $('#imgBg').value;
  const merge = !$('#imgMergeRow').hidden && $('#imgMerge').checked;
  const name = docName || 'document';
  try {
    const indexes = imagePages();
    const images = await withBusy('이미지 만드는 중…', () => cmd.exportImages({
      indexes, format, dpi, background, merge,
      onProgress: (i, n) => { $('#busyMsg').textContent = `이미지 만드는 중… (${i}/${n})`; },
    }));
    dialog.close();
    const fileName = img => `${name}_${img.pageIndex + 1}쪽${img.merged ? '_합침' : ''}.${format}`;
    // 합친 긴 이미지가 브라우저 한계를 넘으면 해상도를 낮춰 만든다 → 알려 준다
    const lowered = images.filter(img => img.dpi < dpi - 1);
    if (lowered.length) setTimeout(() => toast(`긴 페이지라 브라우저 한계(세로 32000px) 안에 맞추느라 해상도를 ${Math.min(...lowered.map(i => i.dpi))}dpi로 낮췄습니다`, 6000), 2600);
    if (images.length === 1) {
      download(images[0].bytes, fileName(images[0]), format === 'jpg' ? 'image/jpeg' : 'image/png');
    } else {
      download(makeZip(images.map(img => ({ name: fileName(img), bytes: img.bytes }))), `${name}_이미지.zip`);
    }
    trackExport('image');
    toast(images.length === 1 ? `저장했습니다 (${images[0].width}×${images[0].height}px)` : `${images.length}장을 ZIP 파일로 저장했습니다`);
  } catch (e) {
    if (e.code === 'NEED_FONT_FILE') askFontFile(e, doExportImages);
    else {
      console.error(e);
      toast(`저장하지 못했습니다: ${e.message}`, 6000);
    }
  }
}

function download(data, name, type = 'application/pdf') {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function askFontFile(err, retry = doExport) {
  const dialog = $('#needFontDialog');
  const weight = err.weight === 'bold' ? ' 굵게' : '';
  $('#needFontMsg').innerHTML = `PDF에 <b>${err.label}${weight}</b> 글꼴을 넣으려면 PC의 폰트 파일이 필요합니다.<br>
    아래에서 파일 선택 창을 연 뒤, 파일 이름 칸에 <code>C:\\Windows\\Fonts\\${err.fileHint}</code> 를 붙여 넣고 열기를 누르세요.<br>
    한 번 넣으면 이 브라우저에 저장되어 다시 묻지 않습니다.`;
  const input = $('#needFontFile');
  input.value = '';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      await provideSystemFontFile(err.fontKey, err.weight, file);
      dialog.close();
      retry();
    } catch {
      toast('폰트 파일을 읽을 수 없습니다', 4000);
    }
  };
  dialog.showModal();
}

// ── 우클릭 메뉴·자르기 ────────────────────────────────

function bindContextMenu() {
  const menu = $('#contextMenu');
  $('#stage').addEventListener('contextmenu', e => {
    e.preventDefault();
    if (editor.isCropping()) return;
    const id = editor.objectIdAt(e);
    const o = id && findObject(id)?.obj;
    if (!o) return hideContextMenu();
    if (!selection.includes(id)) editor.selectIds([id]);
    const ids = selection.includes(id) ? selection : [id];
    const croppable = o.type === 'pdfpage' || o.type === 'image';
    const items = [
      croppable && !o.locked && ['자르기', () => startCropUi(id)],
      croppable && o.crop && ['자르기 원래대로', () => cmd.resetCrop(id)],
      croppable && '-',
      ['잘라내기 (Ctrl+X)', () => cutSelection(ids)],
      ['복사 (Ctrl+C)', () => { copyElements(ids); toast('복사했습니다'); }],
      ['복제', () => cmd.duplicateObjects(ids)],
      '-',
      ['맨 앞으로', () => cmd.arrange(ids, 'front')],
      ['맨 뒤로', () => cmd.arrange(ids, 'back')],
      o.locked ? ['잠금 해제', () => cmd.setLocked([id], false).then(() => editor.selectIds([id]))] : ['잠금', () => cmd.setLocked(ids, true)],
      '-',
      ['삭제', () => cmd.deleteObjects(ids), 'danger'],
    ].filter(Boolean);
    menu.replaceChildren(...items.map(item => {
      if (item === '-') return document.createElement('hr');
      const [label, action, cls] = item;
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.onclick = () => { hideContextMenu(); action(); };
      return b;
    }));
    menu.hidden = false;
    const { innerWidth: vw, innerHeight: vh } = window;
    menu.style.left = `${Math.min(e.clientX, vw - menu.offsetWidth - 8)}px`;
    menu.style.top = `${Math.min(e.clientY, vh - menu.offsetHeight - 8)}px`;
  }, true); // 캔버스(Fabric)가 우클릭 이벤트 전달을 막으므로 캡처 단계에서 받는다
  document.addEventListener('pointerdown', e => { if (!menu.contains(e.target)) hideContextMenu(); });
  window.addEventListener('blur', hideContextMenu);

  $('#btnCropApply').onclick = applyCropUi;
  $('#btnCropCancel').onclick = () => editor.cancelCrop();
}

function hideContextMenu() {
  $('#contextMenu').hidden = true;
}

async function startCropUi(id) {
  if (!(await editor.startCrop(id))) toast('자를 수 없는 요소입니다');
}

async function applyCropUi() {
  const result = editor.finishCrop();
  if (result) await cmd.cropObject(result.id, result);
}

// ── 키보드·붙여넣기 ───────────────────────────────────

const isTyping = t => t?.matches?.('input, textarea, select, [contenteditable="true"]');

function bindKeyboard() {
  document.addEventListener('keydown', e => {
    if (isTyping(e.target) || editor.isEditingText()) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const run = fn => { e.preventDefault(); fn(); };

    // 자르기 중에는 Enter(적용)·Esc(취소)만 받는다
    if (editor.isCropping()) {
      if (k === 'enter') run(applyCropUi);
      else if (k === 'escape') run(() => editor.cancelCrop());
      else if (!k.startsWith('arrow')) e.preventDefault();
      return;
    }
    if (k === 'escape') hideContextMenu();

    if (mod && k === 'z' && !e.shiftKey) run(() => cmd.undo());
    else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) run(() => cmd.redo());
    else if (mod && k === 'c' && selection.length) run(copySelection);
    else if (mod && k === 'x' && selection.length) run(() => cutSelection());
    else if (mod && k === 'd' && selection.length) run(() => cmd.duplicateObjects(selection));
    else if (mod && (k === '=' || k === '+')) run(() => editor.setZoom(editor.getZoom() * 1.25));
    else if (mod && k === '-') run(() => editor.setZoom(editor.getZoom() / 1.25));
    else if (mod && k === '0') run(() => editor.fitToStage());
    else if ((k === 'delete' || k === 'backspace') && selection.length) run(() => cmd.deleteObjects(selection));
    else if (k.startsWith('arrow') && selection.length) {
      const step = e.shiftKey ? 10 : 1;
      const d = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[k];
      run(() => cmd.nudge(selection, ...d));
    } else if (k === 'pageup') run(() => cmd.goToPage(state.current - 1));
    else if (k === 'pagedown') run(() => cmd.goToPage(state.current + 1));
    else if (k === 'escape') editor.clearSelection();
  });

  // Ctrl+V: 가장 최근에 복사한 것을 붙인다.
  // 편집기에서 복사한 표시가 그대로면 요소, 그 뒤 다른 곳에서 복사한 이미지가 있으면 이미지 삽입
  document.addEventListener('paste', e => {
    if (isTyping(e.target) || editor.isEditingText() || !currentPage()) return;
    const ours = cmd.hasClipboard() && (clipMarkFailed || (clipMark && e.clipboardData?.getData('text/plain') === clipMark));
    const images = ours ? [] : [...(e.clipboardData?.files || [])].filter(isImage);
    if (images.length) {
      e.preventDefault();
      insertImagesUi(images);
    } else if (cmd.hasClipboard()) {
      e.preventDefault();
      cmd.paste();
    }
  });
}

// ── 끌어다 놓기 ───────────────────────────────────────

function bindDragDrop() {
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', e => {
    if (!e.relatedTarget) document.body.classList.remove('dragging');
  });
  document.addEventListener('drop', async e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    document.body.classList.remove('dragging');
    const files = [...e.dataTransfer.files];
    const onStage = e.target.closest?.('#stage');
    if (onStage && currentPage()) {
      // 편집 화면: 이미지는 현재 페이지 위에, PDF는 다음 페이지로
      const images = files.filter(f => isImage(f) && !isPdf(f));
      await insertImagesUi(images);
      await openFilesUi(files.filter(isPdf));
    } else {
      await openFilesUi(files, onStage ? undefined : state.doc.pages.length);
    }
  });
}

boot().catch(e => {
  console.error(e);
  toast(`시작하지 못했습니다: ${e.message}`, 10000);
});
