// PDF 저장 (pdf-lib)
// 원본 PDF 페이지는 이미지로 바꾸지 않고 벡터 그대로 넣고, 이미지는 원본 파일을 그대로 넣는다.

import { assets } from './state.js';
import { getFontBytes, cssFamily } from './fonts.js';
import { subsetFont } from './fontSubset.js';
import { uncropped } from './pageSize.js';

const { PDFDocument, rgb, degrees, pushGraphicsState, popGraphicsState, moveTo, lineTo, closePath, clip, endPath } = window.PDFLib;

function color(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/**
 * 화면 좌표(왼쪽 위 기준, y 아래로)의 회전된 사각형을 pdf-lib 그리기 인자로 바꾼다.
 * pdf-lib는 왼쪽 아래 모서리(x, y)를 기준으로 반시계 방향 회전한다.
 */
function placement(cx, cy, dw, dh, angleDeg, pageH) {
  const t = (angleDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const rx = (-dw / 2) * c - (dh / 2) * s;
  const ry = (-dw / 2) * s + (dh / 2) * c;
  return { x: cx + rx, y: pageH - (cy + ry), rotate: degrees(-angleDeg) };
}

function localToPdf(o, lx, ly, pageH) {
  const t = (o.angle * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return { x: o.cx + lx * c - ly * s, y: pageH - (o.cy + lx * s + ly * c) };
}

export async function exportPdf(doc) {
  // 폰트를 먼저 확보한다. (맑은 고딕은 PC 폰트 접근 권한 요청이 필요해 클릭 직후에 해야 함)
  const fontBytes = new Map();
  const fontChars = new Map(); // 폰트별로 실제 쓴 글자
  for (const page of doc.pages) {
    for (const o of objectsOf(page)) {
      if (o.type !== 'text' || !o.text.trim()) continue;
      const k = `${o.fontFamily}|${o.bold ? 1 : 0}`;
      if (!fontBytes.has(k)) fontBytes.set(k, await getFontBytes(o.fontFamily, o.bold));
      fontChars.set(k, (fontChars.get(k) || '') + o.text);
    }
  }

  const out = await PDFDocument.create();
  out.registerFontkit(window.fontkit);
  out.setProducer('PDF 편집기');

  const embeddedPages = new Map();
  const embeddedImages = new Map();
  const embeddedFonts = new Map();

  const ctx = {
    async pdfPage(o) {
      const key = `${o.assetId}:${o.pageIndex}`;
      if (!embeddedPages.has(key)) {
        const asset = assets.get(o.assetId);
        asset.libDoc ||= await PDFDocument.load(asset.bytes, { updateMetadata: false });
        const src = asset.libDoc.getPage(o.pageIndex);
        const box = src.getCropBox();
        const embedded = await out.embedPage(src, { left: box.x, bottom: box.y, right: box.x + box.width, top: box.y + box.height });
        embeddedPages.set(key, { embedded, rotation: ((src.getRotation().angle % 360) + 360) % 360 });
      }
      return embeddedPages.get(key);
    },
    async image(o) {
      if (!embeddedImages.has(o.assetId)) {
        const asset = assets.get(o.assetId);
        embeddedImages.set(o.assetId, asset.mime === 'image/png' ? await out.embedPng(asset.bytes) : await out.embedJpg(asset.bytes));
      }
      return embeddedImages.get(o.assetId);
    },
    async font(o) {
      const k = `${o.fontFamily}|${o.bold ? 1 : 0}`;
      if (!embeddedFonts.has(k)) {
        // 쓴 글자만 남긴 폰트를 넣는다. 실패하면 폰트 전체를 넣는다 (파일이 커질 뿐 결과는 같음).
        let bytes = fontBytes.get(k);
        try {
          bytes = await subsetFont(bytes, fontChars.get(k));
        } catch (e) {
          console.warn('폰트 축소 실패, 전체 폰트를 넣습니다', e);
        }
        const font = await out.embedFont(bytes, { subset: false });
        embeddedFonts.set(k, { font, track: trackGlyphWidths(font) });
      }
      return embeddedFonts.get(k);
    },
  };

  for (const page of doc.pages) {
    const H = page.height;
    const p = out.addPage([page.width, H]);
    if (!page.parts) {
      for (const o of page.objects) await drawObject(p, o, H, ctx);
      continue;
    }
    // 합친 페이지: 부분마다 원래 페이지 영역만 보이게 잘라서 그린다
    for (const part of page.parts) {
      p.pushOperators(pushGraphicsState(), ...rectPath(part.dx, H - part.dy - part.height, part.width, part.height), clip(), endPath());
      for (const o of part.objects) await drawObject(p, { ...o, cx: o.cx + part.dx, cy: o.cy + part.dy }, H, ctx);
      p.pushOperators(popGraphicsState());
    }
  }
  return out.save();
}

const objectsOf = page => (page.parts ? page.parts.flatMap(part => part.objects) : page.objects);

function rectPath(x, y, w, h) {
  return [moveTo(x, y), lineTo(x + w, y), lineTo(x + w, y + h), lineTo(x, y + h), closePath()];
}

/**
 * pdf-lib 1.17.1은 폰트의 기본 글자표(cmap)에 있는 글자 폭만 PDF에 적는다.
 * 폰트의 문맥 대체 기능으로 바뀐 글자(예: Pretendard의 '+')는 폭이 빠져 간격이 벌어지므로,
 * 실제로 쓴 글자 모양의 폭도 함께 적도록 보정한다. (vendor/pdf-lib.min.js 내부 구조에 의존)
 */
function trackGlyphWidths(pdfFont) {
  const embedder = pdfFont.embedder;
  const base = embedder.glyphCache;
  const used = new Map();
  embedder.glyphCache = {
    access() {
      const all = new Map(base.access().map(g => [g.id, g]));
      used.forEach((g, id) => all.set(id, g));
      return [...all.values()].sort((a, b) => a.id - b.id);
    },
    invalidate() {},
  };
  return text => {
    for (const g of embedder.font.layout(text, embedder.fontFeatures).glyphs) used.set(g.id, g);
  };
}

async function drawObject(p, o, H, ctx) {
  const opacity = o.opacity ?? 1;
  if (opacity <= 0) return;

  if (o.type === 'pdfpage' || o.type === 'image') {
    // 자른 요소는 원본 전체를 그리고 보이는 영역만 남긴다 (원본 데이터는 그대로)
    const g = o.crop ? uncropped(o) : o;
    if (o.crop) {
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => localToPdf(o, (sx * o.w) / 2, (sy * o.h) / 2, H));
      p.pushOperators(pushGraphicsState(), moveTo(corners[0].x, corners[0].y), ...corners.slice(1).map(c => lineTo(c.x, c.y)), closePath(), clip(), endPath());
    }
    if (o.type === 'pdfpage') {
      const { embedded, rotation } = await ctx.pdfPage(o);
      // 원본에 /Rotate가 있으면 회전 전 모양으로 그린 뒤 함께 돌린다
      const swap = rotation % 180 === 90;
      const dw = swap ? g.h : g.w;
      const dh = swap ? g.w : g.h;
      p.drawPage(embedded, { ...placement(g.cx, g.cy, dw, dh, o.angle + rotation, H), width: dw, height: dh, opacity });
    } else {
      const img = await ctx.image(o);
      p.drawImage(img, { ...placement(g.cx, g.cy, g.w, g.h, o.angle, H), width: g.w, height: g.h, opacity });
    }
    if (o.crop) p.pushOperators(popGraphicsState());
  } else if (o.type === 'rect' || o.type === 'ellipse') {
    const style = {};
    if (o.fill) Object.assign(style, { color: color(o.fill), opacity });
    if (o.stroke && o.strokeWidth > 0) Object.assign(style, { borderColor: color(o.stroke), borderWidth: o.strokeWidth, borderOpacity: opacity });
    if (!style.color && !style.borderColor) return;
    if (o.type === 'rect') {
      p.drawRectangle({ ...placement(o.cx, o.cy, o.w, o.h, o.angle, H), width: o.w, height: o.h, ...style });
    } else {
      p.drawEllipse({ x: o.cx, y: H - o.cy, xScale: o.w / 2, yScale: o.h / 2, rotate: degrees(-o.angle), ...style });
    }
  } else if (o.type === 'text') {
    await drawText(p, o, H, ctx, opacity);
  }
}

// 줄바꿈 위치와 기준선은 화면(Fabric.js)과 같은 방식으로 계산한다
async function drawText(p, o, H, ctx, opacity) {
  if (!o.text.trim()) return;
  const { font, track } = await ctx.font(o);
  const tb = new fabric.Textbox(o.text, {
    width: o.w,
    fontSize: o.fontSize,
    fontFamily: cssFamily(o.fontFamily),
    fontWeight: o.bold ? 'bold' : 'normal',
    lineHeight: o.lineHeight,
  });
  const top = -tb.height / 2;
  const left = -tb.width / 2;
  let y = top;
  tb.textLines.forEach((line, i) => {
    const lh = tb.getHeightOfLine(i);
    const baseline = y + lh / tb.lineHeight - (lh * tb._fontSizeFraction) / tb.lineHeight;
    y += lh;
    const textLine = line.replace(/\s+$/, '');
    if (!textLine) return;
    const lineW = font.widthOfTextAtSize(textLine, o.fontSize);
    const offset = o.align === 'center' ? (tb.width - lineW) / 2 : o.align === 'right' ? tb.width - lineW : 0;
    const at = localToPdf(o, left + offset, baseline, H);
    track(textLine);
    p.drawText(textLine, { ...at, size: o.fontSize, font, color: color(o.color), opacity, rotate: degrees(-o.angle) });
  });
}
