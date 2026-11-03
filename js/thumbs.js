// 페이지 미리보기 이미지 (페이지 내용이 바뀐 경우에만 다시 그림)

import { buildFabricObject } from './canvas.js';

const THUMB_W = 150;
const cache = new Map(); // pageId -> { sig, url }

export function cachedThumb(pageId) {
  return cache.get(pageId)?.url || null;
}

export async function thumbFor(page) {
  const sig = JSON.stringify(page);
  const hit = cache.get(page.id);
  if (hit && hit.sig === sig) return hit.url;

  const s = THUMB_W / page.width;
  const el = document.createElement('canvas');
  const sc = new fabric.StaticCanvas(el, {
    width: Math.round(page.width * s),
    height: Math.round(page.height * s),
    backgroundColor: '#ffffff',
    enableRetinaScaling: false,
    renderOnAddRemove: false,
  });
  sc.setZoom(s);
  const objs = await Promise.all(page.objects.map(o => buildFabricObject(o, Math.max(0.5, s * 2))));
  objs.forEach(o => sc.add(o));
  sc.renderAll();
  const url = sc.toDataURL({ format: 'png' });
  sc.dispose();
  cache.set(page.id, { sig, url });
  return url;
}
