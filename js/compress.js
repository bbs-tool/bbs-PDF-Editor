// PDF 용량 줄이기 (브라우저 안에서만 처리, 서버로 보내지 않음)
// - 보통·강하게: PDF 안의 사진만 해상도를 줄이고 JPG로 다시 압축한다. 글자·도형(벡터)은 그대로라 선택·검색된다.
// - 최대: 페이지 전체를 JPG 이미지로 바꾼다. 가장 작아지지만 글자를 선택·검색할 수 없다.

import { openPdfBytes } from './pdfRender.js';
import { renderTiled } from './imageExport.js';

const { PDFDocument, PDFName, PDFRawStream, PDFArray, PDFRef, PDFNumber, decodePDFRawStream } = window.PDFLib;
const N = PDFName.of;

export const COMPRESS_LEVELS = {
  normal: { maxSide: 2000, quality: 0.75 }, // 사진 긴 변 2000px (A4 전체에 깔아도 약 170dpi)
  strong: { maxSide: 1300, quality: 0.6 },
  max: { raster: true, dpi: 150, quality: 0.65 }, // 150dpi: 화면·사무용 출력에서 글자가 읽히는 정도
};

const MIN_BYTES = 20 * 1024; // 이보다 작은 사진은 줄여도 차이가 없어 건너뛴다
const KEEP_RATIO = 0.9; // 10% 이상 줄어들 때만 바꾼다 (이미 압축된 사진의 화질을 괜히 깎지 않게)

/** PDF 바이트 → 줄인 PDF 바이트. 줄어들지 않으면 원래 바이트를 그대로 돌려준다. */
export async function compressPdf(bytes, level = 'normal', { onProgress } = {}) {
  const opt = COMPRESS_LEVELS[level];
  if (!opt) return bytes;
  const out = opt.raster ? await rasterize(bytes, opt, onProgress) : await recompressImages(bytes, opt, onProgress);
  return out.length < bytes.length ? out : bytes;
}

// ── 사진만 다시 압축 ──────────────────────────────────

async function recompressImages(bytes, opt, onProgress) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const images = [];
  const masks = new Set(); // 다른 사진의 투명도(마스크)로 쓰이는 이미지는 건드리지 않는다
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.get(N('Subtype')) !== N('Image')) continue;
    images.push([ref, obj]);
    for (const k of ['SMask', 'Mask']) {
      const m = obj.dict.get(N(k));
      if (m instanceof PDFRef) masks.add(m.toString());
    }
  }
  let i = 0;
  for (const [ref, stream] of images) {
    onProgress?.(++i, images.length);
    if (masks.has(ref.toString())) continue;
    try {
      const next = await recompressOne(ctx, stream, opt);
      if (next) ctx.assign(ref, next);
    } catch (e) {
      console.warn('이 사진은 압축하지 않고 그대로 둡니다', e);
    }
  }
  return doc.save({ useObjectStreams: true });
}

/** 이미지 하나를 JPG로 다시 만든다 → 새 스트림 (줄일 수 없거나 지원하지 않는 형식이면 null) */
async function recompressOne(ctx, stream, { maxSide, quality }) {
  const d = stream.dict;
  if (stream.contents.length < MIN_BYTES) return null;
  // 글자 모양 마스크·색 범위 마스크·색 반전이 있는 이미지는 JPG로 바꾸면 모양이 달라질 수 있다
  if (d.has(N('ImageMask')) || d.has(N('Mask')) || d.has(N('Decode'))) return null;
  const num = k => {
    const v = d.lookup(N(k));
    return v instanceof PDFNumber ? v.asNumber() : NaN;
  };
  const w = num('Width');
  const h = num('Height');
  if (!(w > 0 && h > 0) || num('BitsPerComponent') !== 8) return null;
  const comps = colorComponents(ctx, d.lookup(N('ColorSpace')));
  if (!comps) return null; // CMYK·별색 등은 색이 바뀔 수 있어 그대로 둔다

  const filters = filterNames(ctx, d.lookup(N('Filter')));
  let source; // drawImage로 그릴 수 있는 원본
  if (filters.length === 1 && filters[0] === N('DCTDecode')) {
    source = await createImageBitmap(new Blob([stream.contents], { type: 'image/jpeg' }));
  } else if (filters.length === 1 && filters[0] === N('FlateDecode')) {
    let data = decodePDFRawStream(stream).decode();
    const parms = d.lookup(N('DecodeParms'));
    const predictor = parms?.lookup?.(N('Predictor'))?.asNumber?.() || 1;
    if (predictor >= 10) {
      const colors = parms.lookup(N('Colors'))?.asNumber?.() || 1;
      const columns = parms.lookup(N('Columns'))?.asNumber?.() || 1;
      if (colors !== comps || columns !== w) return null;
      data = unpredictPng(data, colors, columns);
    } else if (predictor !== 1) {
      return null;
    }
    if (data.length < w * h * comps) return null;
    source = pixelsToCanvas(data, w, h, comps);
  } else {
    return null;
  }

  const s = Math.min(1, maxSide / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * s));
  const th = Math.max(1, Math.round(h * s));
  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, 0, 0, tw, th);
  source.close?.();
  if (source.width !== undefined && source !== canvas && source.getContext) source.width = source.height = 0;
  const jpg = await toJpeg(canvas, quality);
  canvas.width = canvas.height = 0;
  if (jpg.length > stream.contents.length * KEEP_RATIO) return null;

  const dict = ctx.obj({ Type: 'XObject', Subtype: 'Image', Width: tw, Height: th, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' });
  const smask = d.get(N('SMask')); // 투명도는 원래 마스크를 그대로 쓴다 (크기가 달라도 PDF 규격상 문제없음)
  if (smask) dict.set(N('SMask'), smask);
  return PDFRawStream.of(dict, jpg);
}

/** 색 공간 → 채널 수 (1: 회색, 3: RGB). 다루지 않는 색 공간이면 0 */
function colorComponents(ctx, cs) {
  if (cs === N('DeviceRGB') || cs === N('CalRGB')) return 3;
  if (cs === N('DeviceGray') || cs === N('CalGray')) return 1;
  if (cs instanceof PDFArray) {
    const kind = ctx.lookup(cs.get(0));
    if (kind === N('CalRGB')) return 3;
    if (kind === N('CalGray')) return 1;
    if (kind === N('ICCBased')) {
      const n = ctx.lookup(cs.get(1))?.dict?.lookup(N('N'))?.asNumber?.();
      return n === 1 || n === 3 ? n : 0;
    }
  }
  return 0;
}

function filterNames(ctx, f) {
  if (!f) return [];
  if (f instanceof PDFArray) return f.asArray().map(x => ctx.lookup(x));
  return [f];
}

/** PNG 예측 필터(PDF Predictor 10~15)를 풀어 원래 픽셀로 */
function unpredictPng(data, bpp, columns) {
  const row = bpp * columns;
  const rows = Math.floor(data.length / (row + 1));
  const out = new Uint8Array(rows * row);
  for (let y = 0; y < rows; y++) {
    const type = data[y * (row + 1)];
    const src = y * (row + 1) + 1;
    const o = y * row;
    for (let x = 0; x < row; x++) {
      const raw = data[src + x];
      const a = x >= bpp ? out[o + x - bpp] : 0;
      const b = y ? out[o - row + x] : 0;
      const c = x >= bpp && y ? out[o - row + x - bpp] : 0;
      let v;
      if (type === 0) v = raw;
      else if (type === 1) v = raw + a;
      else if (type === 2) v = raw + b;
      else if (type === 3) v = raw + ((a + b) >> 1);
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`알 수 없는 PNG 필터 ${type}`);
      out[o + x] = v & 255;
    }
  }
  return out;
}

function pixelsToCanvas(data, w, h, comps) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  const img = g.createImageData(w, h);
  const px = img.data;
  for (let i = 0, j = 0, n = w * h; i < n; i++, j += comps) {
    const k = i * 4;
    if (comps === 3) {
      px[k] = data[j];
      px[k + 1] = data[j + 1];
      px[k + 2] = data[j + 2];
    } else {
      px[k] = px[k + 1] = px[k + 2] = data[j];
    }
    px[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

async function toJpeg(canvas, quality) {
  const blob = await new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('JPG로 바꾸지 못했습니다'))), 'image/jpeg', quality));
  return new Uint8Array(await blob.arrayBuffer());
}

// ── 페이지 전체를 이미지로 ────────────────────────────

const RASTER_MAX_SIDE = 8000;

async function rasterize(bytes, { dpi, quality }, onProgress) {
  const pdf = await openPdfBytes(bytes);
  const out = await PDFDocument.create();
  out.setProducer("BB's PDF Editor");
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      onProgress?.(i, pdf.numPages);
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(dpi / 72, RASTER_MAX_SIDE / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const g = canvas.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, canvas.width, canvas.height);
      await renderTiled(page, viewport, g, canvas.width, canvas.height, false);
      const img = await out.embedJpg(await toJpeg(canvas, quality));
      canvas.width = canvas.height = 0;
      page.cleanup();
      out.addPage([base.width, base.height]).drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
    }
  } finally {
    pdf.destroy();
  }
  return out.save({ useObjectStreams: true });
}
