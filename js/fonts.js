// 폰트 관리
// - fonts/fonts.json: 저장소에 함께 배포하는 폰트 (기본: Pretendard)
// - 시스템 폰트: 맑은 고딕 (재배포 불가 → 사용자 PC의 폰트 파일을 저장 시점에 불러온다)
// - 사용자 폰트: 화면에서 추가한 TTF/OTF (이 브라우저의 IndexedDB에 보관)

import { idbGet, idbPut, idbDelete, idbAll } from './idb.js';
import { uid } from './state.js';

export const DEFAULT_FONT = 'Pretendard';

const SYSTEM_FONTS = [
  {
    key: 'MalgunGothic',
    label: '맑은 고딕',
    css: 'Malgun Gothic',
    source: 'system',
    localFamilies: ['Malgun Gothic', '맑은 고딕'],
    localStyles: { normal: 'Regular', bold: 'Bold' },
    fileHint: { normal: 'malgun.ttf', bold: 'malgunbd.ttf' },
  },
];

const registry = new Map();
const userFontData = new Map(); // key -> { normal, bold }

const weightOf = bold => (bold ? 'bold' : 'normal');

function registerFace(family, source, weight) {
  const face = new FontFace(family, source, { weight: weight === 'bold' ? '700' : '400' });
  document.fonts.add(face);
  return face.load().catch(e => console.warn(`폰트 로드 실패: ${family}`, e));
}

export async function initFonts() {
  const loads = [];

  let manifest = [];
  try {
    manifest = await (await fetch('fonts/fonts.json', { cache: 'no-cache' })).json();
  } catch (e) {
    console.warn('fonts/fonts.json을 읽지 못했습니다', e);
  }
  for (const f of manifest) {
    const def = { key: f.key, label: f.label || f.key, css: f.css || f.key, source: 'file', files: f.files, hasBold: !!f.files.bold };
    registry.set(def.key, def);
    loads.push(registerFace(def.css, `url("fonts/${f.files.normal}")`, 'normal'));
    if (f.files.bold) loads.push(registerFace(def.css, `url("fonts/${f.files.bold}")`, 'bold'));
  }

  for (const def of SYSTEM_FONTS) registry.set(def.key, { ...def, hasBold: true });

  try {
    for (const rec of await idbAll('userFonts')) loads.push(...registerUserFont(rec));
  } catch (e) {
    console.warn('사용자 폰트를 불러오지 못했습니다', e);
  }

  await Promise.all(loads);
}

function registerUserFont(rec) {
  registry.set(rec.key, { key: rec.key, label: rec.label, css: rec.key, source: 'user', hasBold: !!rec.bold });
  userFontData.set(rec.key, rec);
  const loads = [registerFace(rec.key, rec.normal, 'normal')];
  if (rec.bold) loads.push(registerFace(rec.key, rec.bold, 'bold'));
  return loads;
}

export function listFonts() {
  return [...registry.values()].map(({ key, label, css, source, hasBold }) => ({ key, label, css, source, hasBold }));
}

export function fontInfo(key) {
  return registry.get(key) || registry.get(DEFAULT_FONT);
}

export function cssFamily(key) {
  return fontInfo(key)?.css || 'sans-serif';
}

/** 화면에서 폰트 추가 (TTF/OTF). 잘못된 파일이면 예외를 던진다. */
export async function addUserFont(label, normalFile, boldFile) {
  const rec = { key: 'user_' + uid('f'), label: label.trim() || normalFile.name, normal: await normalFile.arrayBuffer(), bold: boldFile ? await boldFile.arrayBuffer() : null };
  await new FontFace('probe', rec.normal).load(); // 폰트 파일인지 확인
  if (rec.bold) await new FontFace('probe', rec.bold).load();
  await idbPut('userFonts', rec.key, rec);
  await Promise.all(registerUserFont(rec));
  return rec.key;
}

export async function removeUserFont(key) {
  await idbDelete('userFonts', key);
  registry.delete(key);
  userFontData.delete(key);
}

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`폰트 파일을 받을 수 없습니다: ${url}`);
  return res.arrayBuffer();
}

/** PDF에 넣을 폰트 파일 바이트. 시스템 폰트를 찾지 못하면 code='NEED_FONT_FILE' 예외. */
export async function getFontBytes(key, bold) {
  const def = fontInfo(key);
  const weight = weightOf(bold && def.hasBold);

  if (def.source === 'file') return fetchBytes(`fonts/${def.files[weight] || def.files.normal}`);
  if (def.source === 'user') {
    const rec = userFontData.get(def.key);
    return rec[weight] || rec.normal;
  }

  const cacheKey = `${def.key}:${weight}`;
  const cached = await idbGet('systemFonts', cacheKey).catch(() => null);
  if (cached) return cached;

  const local = await queryLocalFont(def, weight);
  if (local) {
    await idbPut('systemFonts', cacheKey, local).catch(() => {});
    return local;
  }
  const err = new Error(`${def.label} 폰트 파일을 찾지 못했습니다`);
  Object.assign(err, { code: 'NEED_FONT_FILE', fontKey: def.key, weight, label: def.label, fileHint: def.fileHint[weight] });
  throw err;
}

// Chrome·Edge의 Local Font Access API (처음 한 번 권한 요청)
async function queryLocalFont(def, weight) {
  if (!('queryLocalFonts' in window)) return null;
  try {
    const fonts = await window.queryLocalFonts();
    const hit = fonts.find(f => def.localFamilies.includes(f.family) && f.style === def.localStyles[weight]);
    return hit ? await (await hit.blob()).arrayBuffer() : null;
  } catch (e) {
    console.warn('로컬 폰트 접근 실패', e);
    return null;
  }
}

/** 사용자가 직접 고른 시스템 폰트 파일을 보관 */
export async function provideSystemFontFile(key, weight, file) {
  const bytes = await file.arrayBuffer();
  await new FontFace('probe', bytes).load();
  await idbPut('systemFonts', `${key}:${weight}`, bytes);
}
