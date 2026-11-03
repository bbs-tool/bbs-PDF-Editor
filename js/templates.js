// 자주 쓰는 템플릿: 페이지 설정 + 원본 배경을 뺀 요소(텍스트·도형·이미지)를 브라우저에 보관
//
// 저장 형식 { id, name, createdAt, pages: [{ width, height, settings, objects }], assets }
// - width/height: 저장할 때의 페이지 크기(pt). 크기가 다른 페이지에 불러오면 위치를 비율로 옮긴다.
// - assets: 이미지 요소의 원본 바이트 { [assetId]: { bytes, mime, name } } (모든 페이지 공용)
// 예전 형식(한 페이지: width, height, settings, objects가 최상위)도 읽는다.

import { uid } from './state.js';
import { idbAll, idbGet, idbPut, idbDelete } from './idb.js';

const STORE = 'templates';

export function templatePages(tpl) {
  return tpl.pages || [{ width: tpl.width, height: tpl.height, settings: tpl.settings, objects: tpl.objects }];
}

export async function listTemplates() {
  const all = await idbAll(STORE);
  return all
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(tpl => {
      const pages = templatePages(tpl);
      return { id: tpl.id, name: tpl.name, createdAt: tpl.createdAt, pages: pages.length, count: pages.reduce((n, p) => n + p.objects.length, 0) };
    });
}

export const getTemplate = id => idbGet(STORE, id);

export async function putTemplate(tpl) {
  const id = tpl.id || uid('t');
  await idbPut(STORE, id, { ...tpl, id, createdAt: tpl.createdAt || Date.now() });
  return id;
}

export const deleteTemplate = id => idbDelete(STORE, id);
