// 이미지(PNG·JPG)로 저장: 저장용 PDF를 만든 뒤 그 PDF를 그대로 그려서 PDF 저장 결과와 똑같게 만든다.

import { openPdfBytes } from './pdfRender.js';

const MAX_SIDE = 32000; // 브라우저 캔버스 한계(32767px) 안쪽. 합친 긴 이미지도 들어가도록
const MAX_PIXELS = 64e6; // 메모리 약 256MB

/**
 * pdfBytes의 모든 페이지를 이미지로 → [{ index, bytes, width, height }]
 * format: 'png' | 'jpg', dpi: 1인치당 픽셀 수
 * background (PNG만): 'white' | 'page'(아무것도 그려지지 않은 곳만 투명) | 'all'(흰색에 가까운 곳 모두 투명)
 */
export async function renderPdfToImages(pdfBytes, { format = 'png', dpi = 300, background = 'white', onProgress } = {}) {
  const pdf = await openPdfBytes(pdfBytes);
  const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const transparent = format === 'png' && background !== 'white';
  const out = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      onProgress?.(i, pdf.numPages);
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      let scale = dpi / 72;
      scale = Math.min(scale, MAX_SIDE / Math.max(base.width, base.height), Math.sqrt(MAX_PIXELS / (base.width * base.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      // 배경은 흰색 (pdf.js 기본값). 주석은 저장 PDF에 없으므로 그대로 그린다.
      const ctx = canvas.getContext('2d', { willReadFrequently: background === 'all' });
      await renderTiled(page, viewport, ctx, canvas.width, canvas.height, transparent);
      if (transparent && background === 'all') clearWhite(ctx, canvas.width, canvas.height);
      const blob = await new Promise(r => canvas.toBlob(r, mime, 0.92));
      // dpi: 너무 커서 낮춘 경우 실제로 쓴 해상도
      out.push({ index: i - 1, bytes: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height, dpi: Math.round(scale * 72) });
      canvas.width = canvas.height = 0; // 메모리 바로 반환
      page.cleanup();
    }
  } finally {
    pdf.destroy();
  }
  return out;
}

/**
 * 페이지를 TILE px 이하 조각으로 나눠 그린 뒤 이어 붙인다.
 * pdf.js 3.11은 투명 효과(소프트 마스크)가 걸린 영역이 4096px을 넘으면 마스크를 잘못된 위치에서 읽어
 * 그 안의 사진·그림이 통째로 사라진다. 조각 캔버스가 4096px 이하면 그 영역도 조각 안으로 잘려서 문제가 없다.
 */
const TILE = 4000;
async function renderTiled(page, viewport, ctx, width, height, transparent) {
  const tile = document.createElement('canvas');
  try {
    for (let y = 0; y < height; y += TILE) {
      for (let x = 0; x < width; x += TILE) {
        tile.width = Math.min(TILE, width - x); // 크기를 다시 정하면 내용도 지워진다
        tile.height = Math.min(TILE, height - y);
        await page.render({
          canvasContext: tile.getContext('2d'),
          viewport,
          transform: [1, 0, 0, 1, -x, -y], // 이 조각에 해당하는 부분이 왼쪽 위에 오도록
          ...(transparent && { background: 'rgba(0,0,0,0)' }),
        }).promise;
        ctx.drawImage(tile, x, y);
      }
    }
  } finally {
    tile.width = tile.height = 0;
  }
}

// 흰색에 가까운 픽셀을 투명하게. 경계가 거칠지 않도록 245~255는 완전 투명, 225~245는 점점 흐리게.
const SOLID = 225;
const CLEAR = 245;
function clearWhite(ctx, w, h) {
  const rows = Math.max(1, Math.floor(4e6 / w)); // 메모리를 아끼려고 나눠서 처리
  for (let y = 0; y < h; y += rows) {
    const hh = Math.min(rows, h - y);
    const img = ctx.getImageData(0, y, w, hh);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const m = Math.min(d[i], d[i + 1], d[i + 2]);
      if (m >= CLEAR) d[i + 3] = 0;
      else if (m > SOLID) d[i + 3] = Math.round(d[i + 3] * (CLEAR - m) / (CLEAR - SOLID));
    }
    ctx.putImageData(img, 0, y);
  }
}
