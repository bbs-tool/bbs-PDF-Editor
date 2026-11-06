// 모자이크·블러 (부분 가리기)
// 요소: { type: 'blur', shape: 'rect' | 'ellipse', mode: 'mosaic' | 'blur', strength: 10~100(%) }
// - 화면: 아래에 이미 그려진 픽셀을 읽어 그 자리에 모자이크·블러를 덮어 그린다 (아래 요소를 옮기면 바로 따라 바뀜)
// - 저장: 원본 글자가 PDF 안에 남지 않도록, 가리기가 있는 페이지는 맨 위 가리기 아래까지를 이미지 한 장으로 합친다.
//         그 위에 있는 요소(텍스트·도형 등)는 원래대로 벡터로 넣는다.

import { assets, uid } from './state.js';
import { exportPdf } from './exporter.js';
import { openPdfBytes } from './pdfRender.js';

export const BLUR_DEFAULTS = { shape: 'rect', mode: 'mosaic', strength: 50 };

// 강도(%) → 크기(pt). 화면 배율·저장 해상도와 관계없이 같은 모양이 되도록 페이지 단위로 정한다
const mosaicCellPt = s => 2 + s * 0.18; // 10% ≈ 1.3mm 칸, 100% ≈ 7mm 칸
// 블러는 큰 제목 글자도 읽히지 않도록 넉넉하게: 10% ≈ 1.4mm, 50% ≈ 6mm, 100% ≈ 12mm
const blurRadiusPt = s => 1 + s * 0.33;

let scratchA = null;
let scratchB = null;
const scratch = (which, w, h) => {
  let c = which === 'a' ? scratchA : scratchB;
  if (!c) {
    c = document.createElement('canvas');
    if (which === 'a') scratchA = c;
    else scratchB = c;
  }
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  } else {
    c.getContext('2d').clearRect(0, 0, w, h);
  }
  return c;
};

/** src 영역을 tw×th로 줄인다. 한 번에 크게 줄이면 일부 픽셀만 뽑히므로 절반씩 나눠 줄여 평균을 낸다 */
function shrink(src, sx, sy, sw, sh, tw, th) {
  let cur = src;
  let cx = sx;
  let cy = sy;
  let cw = sw;
  let ch = sh;
  const temps = [];
  while (cw / 2 > tw || ch / 2 > th) {
    const nw = Math.max(tw, Math.ceil(cw / 2));
    const nh = Math.max(th, Math.ceil(ch / 2));
    const t = document.createElement('canvas');
    t.width = nw;
    t.height = nh;
    const tc = t.getContext('2d');
    tc.imageSmoothingEnabled = true;
    tc.imageSmoothingQuality = 'high';
    tc.drawImage(cur, cx, cy, cw, ch, 0, 0, nw, nh);
    temps.push(t);
    cur = t;
    cx = cy = 0;
    cw = nw;
    ch = nh;
  }
  const out = document.createElement('canvas');
  out.width = tw;
  out.height = th;
  const oc = out.getContext('2d');
  oc.imageSmoothingEnabled = true;
  oc.imageSmoothingQuality = 'high';
  oc.drawImage(cur, cx, cy, cw, ch, 0, 0, tw, th);
  for (const t of temps) t.width = t.height = 0;
  return out;
}

/**
 * ctx에 이미 그려진 픽셀 위에 효과를 덮어 그린다.
 * ctx의 현재 변환은 '요소 중심이 (0,0)인 좌표 → 캔버스 픽셀'이어야 한다 (Fabric의 _render와 같은 상태).
 * w, h: 요소 크기(변환 전 단위), scale: 요소 자체 배율(끌어서 늘이는 중일 때), effect: { shape, mode, strength }
 */
export function paintEffect(ctx, w, h, effect, scale = 1) {
  const m = ctx.getTransform();
  const pxPerPt = Math.hypot(m.a, m.b) / (scale || 1);
  if (!(pxPerPt > 0) || !(w > 0) || !(h > 0)) return;
  const strength = Math.min(100, Math.max(1, effect.strength ?? BLUR_DEFAULTS.strength));
  const mode = effect.mode === 'blur' ? 'blur' : 'mosaic';
  const canvas = ctx.canvas;

  const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
  const radius = mode === 'blur' ? blurRadiusPt(strength) * pxPerPt : 0;
  const pad = Math.ceil(radius * 2.5);
  const x0 = Math.max(0, Math.floor(Math.min(...pts.map(p => p[0]))) - pad);
  const y0 = Math.max(0, Math.floor(Math.min(...pts.map(p => p[1]))) - pad);
  const x1 = Math.min(canvas.width, Math.ceil(Math.max(...pts.map(p => p[0]))) + pad);
  const y1 = Math.min(canvas.height, Math.ceil(Math.max(...pts.map(p => p[1]))) + pad);
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw < 1 || bh < 1) return;

  const out = scratch('a', bw, bh);
  const oc = out.getContext('2d');
  if (mode === 'mosaic') {
    const cell = Math.max(2, mosaicCellPt(strength) * pxPerPt);
    const small = shrink(canvas, x0, y0, bw, bh, Math.max(1, Math.round(bw / cell)), Math.max(1, Math.round(bh / cell)));
    oc.imageSmoothingEnabled = false;
    oc.drawImage(small, 0, 0, small.width, small.height, 0, 0, bw, bh);
    small.width = small.height = 0;
  } else if ('filter' in oc) {
    // 같은 캔버스를 읽으면서 그리지 않도록 먼저 복사해 둔다
    const src = scratch('b', bw, bh);
    src.getContext('2d').drawImage(canvas, x0, y0, bw, bh, 0, 0, bw, bh);
    oc.filter = `blur(${radius.toFixed(2)}px)`;
    oc.drawImage(src, 0, 0);
    oc.filter = 'none';
  } else {
    // ctx.filter를 지원하지 않는 브라우저(Safari 등): 크게 줄였다가 부드럽게 늘린다
    const f = Math.max(2, radius / 1.5);
    const small = shrink(canvas, x0, y0, bw, bh, Math.max(1, Math.round(bw / f)), Math.max(1, Math.round(bh / f)));
    oc.imageSmoothingEnabled = true;
    oc.imageSmoothingQuality = 'high';
    oc.drawImage(small, 0, 0, small.width, small.height, 0, 0, bw, bh);
    small.width = small.height = 0;
  }

  ctx.save();
  ctx.beginPath();
  if (effect.shape === 'ellipse') ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
  else ctx.rect(-w / 2, -h / 2, w, h);
  ctx.clip();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(out, x0, y0);
  ctx.restore();
}

export const hasBlur = page => page.objects.some(o => o.type === 'blur');

const MAX_SIDE = 16000;
const MAX_PIXELS = 48e6;

/** objs만 그린 PDF를 만들어 투명 배경으로 ctx에 겹친다 */
async function drawSegment(ctx, page, objs, scale) {
  const bytes = await exportPdf({ pages: [{ width: page.width, height: page.height, objects: objs }] });
  const pdf = await openPdfBytes(bytes);
  try {
    const p = await pdf.getPage(1);
    const viewport = p.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = ctx.canvas.width;
    c.height = ctx.canvas.height;
    await p.render({ canvasContext: c.getContext('2d'), viewport, background: 'rgba(0,0,0,0)' }).promise;
    ctx.drawImage(c, 0, 0);
    c.width = c.height = 0;
    p.cleanup();
  } finally {
    pdf.destroy();
  }
}

/**
 * 가리기가 있는 페이지를 저장용으로 바꾼다 → { pages, cleanup, flattened: 바뀐 페이지 수 }
 * 맨 위 가리기까지의 요소를 아래부터 차례로 그리면서 가리기마다 효과를 넣고, 결과를 이미지 한 장으로 만든다.
 */
export async function flattenBlurs(pages, { dpi = 300 } = {}) {
  const temp = [];
  let flattened = 0;
  const out = [];
  for (const page of pages) {
    const last = page.objects.map(o => o.type).lastIndexOf('blur');
    if (last < 0) { out.push(page); continue; }
    const scale = Math.min(dpi / 72, MAX_SIDE / Math.max(page.width, page.height), Math.sqrt(MAX_PIXELS / (page.width * page.height)));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(page.width * scale));
    c.height = Math.max(1, Math.round(page.height * scale));
    const ctx = c.getContext('2d'); // 배경은 투명으로 둔다 (PNG 투명 배경 저장도 그대로 동작)
    let seg = [];
    for (const o of page.objects.slice(0, last + 1)) {
      if (o.type !== 'blur') { seg.push(o); continue; }
      if (seg.length) await drawSegment(ctx, page, seg, scale);
      seg = [];
      if ((o.opacity ?? 1) <= 0) continue;
      ctx.save();
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.translate(o.cx, o.cy);
      ctx.rotate((o.angle * Math.PI) / 180);
      ctx.globalAlpha = o.opacity ?? 1;
      paintEffect(ctx, o.w, o.h, o);
      ctx.restore();
    }
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    c.width = c.height = 0;
    const assetId = uid('tmp');
    assets.set(assetId, { kind: 'image', name: 'flattened.png', bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png' });
    temp.push(assetId);
    const img = { id: uid(), type: 'image', assetId, natW: page.width, natH: page.height, cx: page.width / 2, cy: page.height / 2, w: page.width, h: page.height, angle: 0, opacity: 1, locked: true };
    out.push({ ...page, objects: [img, ...page.objects.slice(last + 1)] });
    flattened++;
  }
  return { pages: out, flattened, cleanup: () => temp.forEach(id => assets.delete(id)) };
}
