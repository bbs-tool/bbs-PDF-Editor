// pdf.js로 원본 PDF 페이지를 화면용 이미지로 그린다 (저장 시에는 원본을 그대로 쓴다)

import { assets } from './state.js';

const pdfjs = window.pdfjsLib;
const vendorUrl = (p) => new URL(`../vendor/pdfjs/${p}`, import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = vendorUrl('pdf.worker.min.js');

// 워커는 첫 PDF를 열 때가 아니라 시작할 때 미리 띄워 둔다 (나중에 로컬 서버가 꺼져도 PDF를 열 수 있게)
let worker = null;
function getWorker() {
  if (!worker) {
    const w = (worker = new pdfjs.PDFWorker());
    w.promise.catch(() => { if (worker === w) worker = null; w.destroy(); });
  }
  return worker;
}
getWorker();

const docs = new Map();
const rasters = new Map();
const MAX_SIDE = 4096;
const CACHE_LIMIT = 40;

/** PDF 바이트 → pdf.js 문서 (bytes는 워커로 넘어가므로 복사본을 준다) */
export function openPdfBytes(bytes) {
  return pdfjs.getDocument({
    data: bytes.slice(),
    worker: getWorker(),
    cMapUrl: vendorUrl('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: vendorUrl('standard_fonts/'),
  }).promise;
}

export function getPdfDocument(assetId) {
  if (!docs.has(assetId)) {
    const task = { promise: openPdfBytes(assets.get(assetId).bytes) };
    docs.set(assetId, task.promise);
    task.promise.catch(() => docs.delete(assetId));
  }
  return docs.get(assetId);
}

/**
 * scale = 원본 1pt당 픽셀 수. 0.25 단위로 묶어 캐시한다.
 * crop을 주면 보이는 부분만 그린다 (긴 페이지를 나눈 경우에도 부분마다 선명하게)
 */
export function renderPdfPage(assetId, pageIndex, scale, crop = null) {
  const s = Math.max(0.25, Math.round(scale * 4) / 4);
  const c = crop || { l: 0, t: 0, r: 0, b: 0 };
  const key = `${assetId}:${pageIndex}:${s}:${[c.l, c.t, c.r, c.b].map(v => v.toFixed(5))}`;
  if (rasters.has(key)) {
    const hit = rasters.get(key);
    rasters.delete(key);
    rasters.set(key, hit);
    return hit;
  }

  const job = (async () => {
    const pdf = await getPdfDocument(assetId);
    const page = await pdf.getPage(pageIndex + 1);
    const fw = 1 - c.l - c.r;
    const fh = 1 - c.t - c.b;
    let viewport = page.getViewport({ scale: s });
    const over = Math.max(viewport.width * fw, viewport.height * fh) / MAX_SIDE;
    if (over > 1) viewport = page.getViewport({ scale: s / over });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width * fw));
    canvas.height = Math.max(1, Math.ceil(viewport.height * fh));
    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
      transform: [1, 0, 0, 1, -viewport.width * c.l, -viewport.height * c.t], // 보이는 부분이 캔버스 왼쪽 위에 오도록
      background: 'rgba(0,0,0,0)', // 저장 결과처럼 배경을 투명하게
      annotationMode: pdfjs.AnnotationMode.DISABLE, // 주석은 저장되지 않으므로 화면에서도 뺀다
    }).promise;
    return canvas;
  })();

  rasters.set(key, job);
  job.catch(() => rasters.delete(key));
  if (rasters.size > CACHE_LIMIT) rasters.delete(rasters.keys().next().value);
  return job;
}
