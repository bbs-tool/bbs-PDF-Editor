// 구글 계정 로그인 (config.js에 GOOGLE_CLIENT_ID가 있을 때만 사용)
// 1) 구글 로그인 버튼 → 구글이 준 확인증(ID 토큰)을 기록 서버로 보낸다
// 2) 서버가 구글에 확인하고, 입장을 허용하면 30일짜리 로그인 정보(session)를 준다 → 이 브라우저에 보관
// 3) 다음 방문 때는 로그인 정보가 아직 유효한지(허용이 취소되지 않았는지)만 서버에 묻는다
// 관리자 계정(서버를 배포한 계정)으로 로그인하면 admin: true → 관리자 화면을 바로 연다.

import { TRACKING_URL, GOOGLE_CLIENT_ID } from './config.js';

const KEY = 'pdf-editor.session'; // { session, email, name, picture, admin, expires }

export const googleMode = () => !!(TRACKING_URL && GOOGLE_CLIENT_ID);

async function callServer(body) {
  // Content-Type을 지정하지 않아야(text/plain) Apps Script가 사전 요청 없이 받는다
  const res = await fetch(TRACKING_URL, { method: 'POST', body: JSON.stringify(body), redirect: 'follow' });
  if (!res.ok) throw new Error(`서버 응답 ${res.status}`);
  return res.json();
}

export function getSession() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    return s && s.session && s.expires > Date.now() ? s : null;
  } catch {
    return null;
  }
}

function saveSession(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 저장 못 하면 다음에 다시 로그인 */ }
}

export function clearSession() {
  try { localStorage.removeItem(KEY); } catch { /* 무시 */ }
  try { window.google?.accounts?.id?.disableAutoSelect(); } catch { /* 무시 */ }
}

// 카카오톡·네이버·인스타그램 등 앱 안의 브라우저에서는 구글이 로그인을 막는다
export const inAppBrowser = () => /KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV|Line\/|DaumApps|everytimeApp|; wv\)/i.test(navigator.userAgent);

let gisLoading = null;
export function loadGoogle() {
  gisLoading ||= new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve(window.google);
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve(window.google);
    s.onerror = () => { gisLoading = null; reject(new Error('구글 로그인 화면을 불러오지 못했습니다')); };
    document.head.append(s);
  });
  return gisLoading;
}

export const LOGIN_ERRORS = {
  pending: '사용 요청을 보냈습니다. 관리자가 허용하면 사용할 수 있습니다.\n허용 연락을 받으면 아래 버튼으로 다시 로그인해 주세요.',
  blocked: '이 계정은 사용할 수 없습니다. 관리자에게 문의해 주세요.',
  'not-admin': '관리자 계정이 아닙니다. 관리자 구글 계정으로 로그인해 주세요.',
  'bad-credential': '구글 로그인을 확인하지 못했습니다. 다시 시도해 주세요.',
  'not-configured': '기록 서버에 구글 로그인 설정(GOOGLE_CLIENT_ID)이 아직 없습니다. 관리자에게 알려 주세요.',
  'signed-out': '로그인이 만료되었습니다. 다시 로그인해 주세요.',
};
const errorText = (code, email) => (LOGIN_ERRORS[code] || `로그인하지 못했습니다 (${code || '알 수 없는 오류'})`) + (email && code !== 'bad-credential' ? `\n(${email})` : '');

/**
 * box 안에 구글 로그인 버튼을 그린다. 로그인에 성공하면 onDone(session), 거절되면 onError(문구)
 * forAdmin: 관리자 화면용 — 관리자 계정이 아니면 승인 요청을 만들지 않고 거절
 */
export async function renderGoogleButton(box, { onDone, onError, onBusy, forAdmin = false }) {
  if (inAppBrowser()) {
    box.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'entry-error',
      textContent: '카카오톡 등 앱 안의 브라우저에서는 구글 로그인을 쓸 수 없습니다. 오른쪽 위(또는 아래) 메뉴에서 [다른 브라우저로 열기]를 눌러 Chrome·Edge·Safari로 열어 주세요.',
    }));
    return;
  }
  let google;
  try {
    google = await loadGoogle();
  } catch (e) {
    onError(`${e.message}. 인터넷 연결을 확인한 뒤 새로고침해 주세요.`);
    return;
  }
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    ux_mode: 'popup',
    callback: async ({ credential }) => {
      onBusy?.(true);
      try {
        const r = await callServer({ action: 'login', credential, purpose: forAdmin ? 'admin' : '' });
        if (!r.ok) return onError(errorText(r.error, r.email));
        const s = { session: r.session, ...r.user, admin: !!r.admin, expires: Date.now() + (r.expiresIn - 3600) * 1000 };
        saveSession(s);
        onDone(s);
      } catch {
        onError('서버에 연결할 수 없습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.');
      } finally {
        onBusy?.(false);
      }
    },
  });
  box.replaceChildren();
  google.accounts.id.renderButton(box, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', locale: 'ko', width: 280 });
}

/**
 * 편집기 입장: 로그인 정보가 유효하면 바로 통과, 아니면 로그인 창(닫을 수 없음)을 띄워 통과할 때까지 기다린다.
 * 서버에 연결할 수 없을 때 이미 로그인했던 사람은 그대로 쓰게 한다 (작업을 막지 않음).
 */
export async function ensureGoogleEntry() {
  const saved = getSession();
  let notice = '';
  if (saved) {
    try {
      const r = await callServer({ action: 'session', session: saved.session });
      if (r.ok) {
        saveSession({ ...saved, admin: !!r.admin });
        return;
      }
      if (r.error !== 'signed-out') notice = errorText(r.error, saved.email);
      clearSession();
    } catch {
      return;
    }
  }
  await showLoginDialog(notice);
}

function showLoginDialog(notice) {
  const dialog = document.querySelector('#loginDialog');
  const status = dialog.querySelector('#loginStatus');
  const show = text => {
    status.textContent = text;
    status.hidden = !text;
  };
  show(notice);
  return new Promise(resolve => {
    dialog.addEventListener('cancel', e => e.preventDefault()); // Esc로 닫지 못하게
    renderGoogleButton(dialog.querySelector('#googleButton'), {
      onDone: () => { dialog.close(); resolve(); },
      onError: show,
      onBusy: on => { if (on) show('확인하는 중…'); },
    });
    dialog.showModal();
  });
}

/** 저장 완료 기록 (실패해도 작업에는 영향 없음) */
export function trackWithSession(type) {
  const s = getSession();
  if (!s) return;
  fetch(TRACKING_URL, { method: 'POST', body: JSON.stringify({ action: 'track', type, session: s.session }), keepalive: true, redirect: 'follow' }).catch(() => {});
}
