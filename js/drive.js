// Word·PowerPoint·Excel → PDF 자동 변환 (이용자 본인의 구글 드라이브 사용)
// 1) 이용자에게 '이 앱이 만든 파일만' 다루는 드라이브 권한(drive.file)을 받는다 (처음 한 번 허용 창)
// 2) 파일을 이용자 드라이브에 구글 문서·슬라이드·시트로 변환하며 올린다
// 3) PDF로 내려받아 편집기에 열고, 드라이브에 올린 임시 파일은 바로 영구 삭제한다
// 운영자 서버나 운영자 계정은 거치지 않는다. 이용자의 다른 드라이브 파일은 볼 수 없다.

import { GOOGLE_CLIENT_ID } from './config.js';
import { googleMode, getSession, loadGoogle } from './account.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DOC = 'application/vnd.google-apps.document';
const SLIDES = 'application/vnd.google-apps.presentation';
const SHEET = 'application/vnd.google-apps.spreadsheet';

// 확장자 → [원본 형식, 변환할 구글 형식]
const TYPES = {
  doc: ['application/msword', DOC],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', DOC],
  odt: ['application/vnd.oasis.opendocument.text', DOC],
  rtf: ['application/rtf', DOC],
  ppt: ['application/vnd.ms-powerpoint', SLIDES],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', SLIDES],
  odp: ['application/vnd.oasis.opendocument.presentation', SLIDES],
  xls: ['application/vnd.ms-excel', SHEET],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', SHEET],
  xlsm: ['application/vnd.ms-excel.sheet.macroEnabled.12', SHEET],
  ods: ['application/vnd.oasis.opendocument.spreadsheet', SHEET],
  csv: ['text/csv', SHEET],
};

const extOf = f => (/\.([a-z0-9]+)$/i.exec(f.name || '')?.[1] || '').toLowerCase();

/** 구글 드라이브로 PDF 변환할 수 있는 파일인지 (구글 로그인을 쓰는 경우만) */
export const canConvert = f => googleMode() && !!TYPES[extOf(f)];

/** 파일 열기 창에서 고를 수 있게 할 확장자 */
export const ACCEPT_OFFICE = Object.keys(TYPES).map(e => `.${e}`).join(',');

// ── 드라이브 권한(접근 토큰) ──────────────────────────
// 토큰은 이 탭 메모리에만 두고 저장하지 않는다 (약 1시간 유효)

let token = null; // { value, expires }
let tokenClient = null;
let pending = null;

/** 변환 확인 창을 띄우기 전에 불러 둔다 (버튼을 누른 순간 바로 허용 창을 띄워야 팝업이 막히지 않는다) */
export async function prepareDrive() {
  const google = await loadGoogle();
  tokenClient ||= google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPE,
    callback: res => {
      const p = pending;
      pending = null;
      if (res.error || !res.access_token) return p?.reject(new Error(res.error === 'access_denied' ? '구글 드라이브 사용을 허용하지 않아 변환하지 못했습니다' : `구글 드라이브 권한을 받지 못했습니다 (${res.error || '알 수 없는 오류'})`));
      token = { value: res.access_token, expires: Date.now() + (Number(res.expires_in) || 3600) * 1000 - 60000 };
      p?.resolve(token.value);
    },
    error_callback: err => {
      const p = pending;
      pending = null;
      p?.reject(new Error(err?.type === 'popup_closed' ? '구글 드라이브 허용 창을 닫아 변환하지 못했습니다' : err?.type === 'popup_failed_to_open' ? '팝업이 차단되었습니다. 주소창 오른쪽의 팝업 차단을 풀고 다시 시도해 주세요' : '구글 드라이브 권한을 받지 못했습니다'));
    },
  });
}

/**
 * 접근 토큰 → Promise. 반드시 버튼 클릭 처리 안에서 (await 전에) 불러야 한다.
 * 이미 받은 토큰이 유효하면 창 없이 바로 돌려준다.
 */
export function requestDriveToken() {
  if (token && token.expires > Date.now()) return Promise.resolve(token.value);
  if (!tokenClient) return Promise.reject(new Error('구글 드라이브 연결을 준비하지 못했습니다. 새로고침 후 다시 시도해 주세요'));
  pending?.reject(new Error('cancelled'));
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    tokenClient.requestAccessToken({ prompt: '', login_hint: getSession()?.email || undefined });
  });
}

// ── 변환 ──────────────────────────────────────────────

const API = 'https://www.googleapis.com';

async function driveError(res, fallback) {
  let reason = '';
  try {
    const j = await res.json();
    reason = j.error?.errors?.[0]?.reason || j.error?.status || '';
  } catch { /* 본문 없음 */ }
  if (res.status === 401) {
    token = null;
    return new Error('구글 드라이브 권한이 만료되었습니다. 다시 시도해 주세요');
  }
  if (/accessNotConfigured|SERVICE_DISABLED/i.test(reason)) return new Error('구글 드라이브 연결(Drive API)이 아직 켜져 있지 않습니다. 관리자에게 알려 주세요');
  if (/exportSizeLimitExceeded/i.test(reason)) return new Error('변환 결과가 구글 한도(10MB)를 넘습니다. 해당 프로그램에서 [다른 이름으로 저장 → PDF]로 저장해 열어 주세요');
  if (/storageQuotaExceeded/i.test(reason)) return new Error('구글 드라이브 저장 공간이 부족합니다');
  if (/rateLimit|userRateLimit/i.test(reason)) return new Error('잠시 후 다시 시도해 주세요 (구글 요청 한도)');
  return new Error(`${fallback} (${res.status}${reason ? ` ${reason}` : ''})`);
}

/** 파일 하나를 드라이브에 변환하며 올린다 → 파일 id */
async function upload(file, accessToken) {
  const [srcType, target] = TYPES[extOf(file)];
  const meta = { name: `[BB PDF 변환 임시] ${file.name}`, mimeType: target };
  const auth = { Authorization: `Bearer ${accessToken}` };
  // 5MB 넘는 파일은 나눠 올리기(resumable) 방식이 권장된다. 주소를 못 받으면 한 번에 올리기로.
  if (file.size > 5 * 1024 * 1024) {
    const start = await fetch(`${API}/upload/drive/v3/files?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': srcType },
      body: JSON.stringify(meta),
    });
    if (!start.ok) throw await driveError(start, '파일을 구글 드라이브에 올리지 못했습니다');
    const location = start.headers.get('Location');
    if (location) {
      const res = await fetch(location, { method: 'PUT', headers: { 'Content-Type': srcType }, body: file });
      if (!res.ok) throw await driveError(res, '파일을 구글 드라이브에 올리지 못했습니다');
      return (await res.json()).id;
    }
  }
  const boundary = `bbpdf${Math.random().toString(16).slice(2)}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${boundary}\r\nContent-Type: ${srcType}\r\n\r\n`,
    file,
    `\r\n--${boundary}--`,
  ]);
  const res = await fetch(`${API}/upload/drive/v3/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw await driveError(res, '파일을 구글 형식으로 변환하지 못했습니다');
  return (await res.json()).id;
}

async function exportPdf(id, accessToken) {
  const res = await fetch(`${API}/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=application%2Fpdf`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw await driveError(res, 'PDF로 내려받지 못했습니다');
  return res.blob();
}

/** 드라이브에 올린 임시 파일을 영구 삭제 (휴지통에도 남지 않음). 실패해도 변환 결과에는 영향 없음 */
async function remove(id, accessToken) {
  try {
    await fetch(`${API}/drive/v3/files/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (e) {
    console.warn('임시 파일 삭제 실패', e);
  }
}

/**
 * Office 파일들 → PDF File들 (순서 유지). 하나가 실패해도 나머지는 계속한다.
 * → { pdfs: [{ source, pdf }], errors: [문구] }
 */
export async function convertToPdf(files, accessToken, { onProgress } = {}) {
  const pdfs = [];
  const errors = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.(i + 1, files.length, file.name);
    let id = null;
    try {
      id = await upload(file, accessToken);
      const blob = await exportPdf(id, accessToken);
      const name = file.name.replace(/\.[^.]+$/, '') + '.pdf';
      pdfs.push({ source: file, pdf: new File([blob], name, { type: 'application/pdf' }) });
    } catch (e) {
      errors.push(`${file.name}: ${e.message}`);
    } finally {
      if (id) await remove(id, accessToken);
    }
  }
  return { pdfs, errors };
}
