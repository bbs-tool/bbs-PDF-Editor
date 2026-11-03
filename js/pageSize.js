// 페이지 규격·방향·배치 방식 계산

import { A4_PT, PT_PER_MM } from './state.js';

const norm = a => ((a % 360) + 360) % 360;
const quarterTurns = angle => Math.round(norm(angle) / 90) % 4;
export const NO_MARGIN = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });
export const DEFAULT_ALIGN = Object.freeze({ h: 'center', v: 'middle' });
export const NO_CROP = Object.freeze({ l: 0, t: 0, r: 0, b: 0 }); // 원본에서 잘라낸 비율 (0~1)

export function baseOf(page) {
  return page.baseId ? page.objects.find(o => o.id === page.baseId) || null : null;
}

/** 회전을 반영한 요소의 바깥 사각형 */
export function rotatedBounds(o) {
  const t = (o.angle * Math.PI) / 180;
  const c = Math.abs(Math.cos(t));
  const s = Math.abs(Math.sin(t));
  const bw = o.w * c + o.h * s;
  const bh = o.w * s + o.h * c;
  return { left: o.cx - bw / 2, top: o.cy - bh / 2, width: bw, height: bh };
}

function oriented(w, h, orientation) {
  const short = Math.min(w, h);
  const long = Math.max(w, h);
  return orientation === 'landscape' ? { w: long, h: short } : { w: short, h: long };
}

/** 잘리기 전 전체 모습의 중심·크기 (페이지 좌표). 자르기 화면과 PDF 저장에서 쓴다. */
export function uncropped(o) {
  const c = o.crop || NO_CROP;
  const w = o.w / (1 - c.l - c.r);
  const h = o.h / (1 - c.t - c.b);
  const lx = ((c.l - c.r) * w) / 2; // 보이는 부분 중심이 전체 중심에서 떨어진 거리 (요소 좌표)
  const ly = ((c.t - c.b) * h) / 2;
  const t = (o.angle * Math.PI) / 180;
  return { cx: o.cx - (lx * Math.cos(t) - ly * Math.sin(t)), cy: o.cy - (lx * Math.sin(t) + ly * Math.cos(t)), w, h };
}

/** 자르기를 반영한 원본의 보이는 크기 (회전 전) */
export function visibleNat(o) {
  const c = o.crop || NO_CROP;
  return { w: o.natW * (1 - c.l - c.r), h: o.natH * (1 - c.t - c.b) };
}

/**
 * 페이지 설정을 반영해 페이지 크기와 원본 배경 위치를 다시 계산한다.
 * - fit: 배경이 차지하는 영역 + 상하좌우 여백
 * - custom: 너비×높이 영역 + 상하좌우 여백. 배경은 너비×높이 영역 안에 배치 방식·정렬대로 놓는다.
 * - a4 / original: 여백 없음
 * 배경이 아닌 요소는 배경과 함께 움직인다. 배경이 없으면 페이지 중심 기준 위치를 유지한다.
 */
export function layoutPage(page) {
  const base = baseOf(page);
  if (!base && (page.sizeMode === 'original' || page.sizeMode === 'fit')) page.sizeMode = 'a4';

  const oldW = page.width || 0;
  const oldH = page.height || 0;
  const m = page.margin || NO_MARGIN;
  const ml = m.left * PT_PER_MM;
  const mt = m.top * PT_PER_MM;
  let W;
  let H;

  if (page.sizeMode === 'fit') {
    const b = rotatedBounds(base);
    W = b.width + ml + m.right * PT_PER_MM;
    H = b.height + mt + m.bottom * PT_PER_MM;
    const dx = ml - b.left;
    const dy = mt - b.top;
    for (const o of page.objects) { o.cx += dx; o.cy += dy; }
  } else {
    let box;
    if (page.sizeMode === 'a4') {
      ({ w: W, h: H } = oriented(A4_PT.w, A4_PT.h, page.orientation));
      box = { x: 0, y: 0, w: W, h: H };
    } else if (page.sizeMode === 'custom') {
      const bw = page.customW * PT_PER_MM;
      const bh = page.customH * PT_PER_MM;
      W = bw + ml + m.right * PT_PER_MM;
      H = bh + mt + m.bottom * PT_PER_MM;
      box = { x: ml, y: mt, w: bw, h: bh };
    } else {
      const v = visibleNat(base);
      const swap = quarterTurns(base.angle) % 2 === 1;
      W = swap ? v.h : v.w;
      H = swap ? v.w : v.h;
      box = { x: 0, y: 0, w: W, h: H };
    }
    let dx = (W - oldW) / 2;
    let dy = (H - oldH) / 2;
    if (base) {
      const before = { cx: base.cx, cy: base.cy };
      placeBase(page, base, box);
      dx = base.cx - before.cx;
      dy = base.cy - before.cy;
    }
    if (oldW && oldH) {
      for (const o of page.objects) {
        if (o === base) continue;
        o.cx += dx;
        o.cy += dy;
      }
    }
  }

  page.width = W;
  page.height = H;
  page.orientation = W > H ? 'landscape' : 'portrait';
}

/** 배치 방식(맞춤/채우기/늘이기)과 정렬에 따라 배경을 영역(box) 안에 놓는다. 90° 단위 회전은 유지한다. */
function placeBase(page, base, box) {
  const q = quarterTurns(base.angle);
  const swap = q % 2 === 1;
  const v = visibleNat(base);
  const vw = swap ? v.h : v.w; // 화면에 보이는 가로
  const vh = swap ? v.w : v.h;
  let sx;
  let sy;
  if (page.sizeMode === 'original') {
    sx = sy = 1;
  } else if (page.fitMode === 'stretch') {
    sx = box.w / vw;
    sy = box.h / vh;
  } else {
    const s = page.fitMode === 'cover' ? Math.max(box.w / vw, box.h / vh) : Math.min(box.w / vw, box.h / vh);
    sx = sy = s;
  }
  base.w = v.w * (swap ? sy : sx);
  base.h = v.h * (swap ? sx : sy);
  base.angle = q * 90;
  const dw = vw * sx;
  const dh = vh * sy;
  const a = page.align || DEFAULT_ALIGN;
  base.cx = box.x + (a.h === 'left' ? dw / 2 : a.h === 'right' ? box.w - dw / 2 : box.w / 2);
  base.cy = box.y + (a.v === 'top' ? dh / 2 : a.v === 'bottom' ? box.h - dh / 2 : box.h / 2);
}

/** 페이지를 시계 방향으로 90° 돌린다. 모든 요소가 함께 돈다. */
export function rotatePageCW(page) {
  const W = page.width;
  const H = page.height;
  for (const o of page.objects) {
    const { cx, cy } = o;
    o.cx = H - cy;
    o.cy = cx;
    o.angle = norm(o.angle + 90);
  }
  page.width = H;
  page.height = W;
  if (page.sizeMode === 'custom') [page.customW, page.customH] = [page.customH, page.customW];
  const m = page.margin || NO_MARGIN; // 여백도 함께 돈다: 왼쪽 → 위
  page.margin = { top: m.left, right: m.top, bottom: m.right, left: m.bottom };
  page.orientation = page.width > page.height ? 'landscape' : 'portrait';
}
