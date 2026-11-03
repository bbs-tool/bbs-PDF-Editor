// 입장 팝업과 이용 기록
// - 처음 들어오면 이름 / 입장 코드를 입력해야 편집기를 쓸 수 있다. 관리자에게 한마디는 선택.
// - 관리자가 입장 코드를 바꾸면 다음 접속 때 입장 팝업이 다시 뜬다.
// - PDF·이미지 저장이 끝날 때마다 '누가 언제 저장했는지'만 기록한다. 파일 내용은 보내지 않는다.

import { TRACKING_URL } from './config.js';

const KEY = 'pdf-editor.entry'; // { clientId, name, codeVersion }

export const NAME_MAX = 20;
export const MESSAGE_MAX = 50;

export async function callServer(body, { keepalive = false } = {}) {
  // Content-Type을 지정하지 않아야(text/plain) Apps Script가 사전 요청 없이 받는다
  const res = await fetch(TRACKING_URL, { method: 'POST', body: JSON.stringify(body), keepalive, redirect: 'follow' });
  if (!res.ok) throw new Error(`서버 응답 ${res.status}`);
  return res.json();
}

function readEntry() {
  try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
}

function saveEntry(entry) {
  try { localStorage.setItem(KEY, JSON.stringify(entry)); } catch { /* 저장 못 하면 다음에 다시 입장 */ }
}

const newClientId = () => (crypto.randomUUID ? crypto.randomUUID() : `c${Date.now()}${Math.random().toString(16).slice(2)}`);

/**
 * 입장 확인. 통과할 때까지 기다린다 (입장 팝업은 닫을 수 없다).
 * 이미 입장했던 사람은 코드가 그대로인지만 서버에 확인하고, 서버에 연결할 수 없으면 그대로 쓰게 한다.
 */
export async function ensureEntry() {
  if (!TRACKING_URL) return;
  const saved = readEntry();
  let notice = '';
  if (saved?.codeVersion) {
    try {
      const r = await callServer({ action: 'check', codeVersion: saved.codeVersion });
      if (r.ok) return;
      notice = r.error === 'code-changed' ? '입장 코드가 바뀌었습니다. 관리자에게 받은 새 코드를 입력해 주세요.' : '';
    } catch {
      return; // 서버 문제로 이미 입장했던 사람의 작업을 막지 않는다
    }
  }
  await showEntryDialog(saved, notice);
}

function showEntryDialog(saved, notice) {
  const dialog = document.querySelector('#entryDialog');
  const form = dialog.querySelector('form');
  const name = form.querySelector('#entryName');
  const code = form.querySelector('#entryCode');
  const message = form.querySelector('#entryMessage');
  const error = form.querySelector('#entryError');
  const submit = form.querySelector('button[type=submit]');
  const count = form.querySelector('#entryCount');
  name.maxLength = NAME_MAX;
  message.maxLength = MESSAGE_MAX;
  name.value = saved?.name || '';
  code.value = '';
  error.textContent = notice;
  error.hidden = !notice;
  const updateCount = () => { count.textContent = `${message.value.length}/${MESSAGE_MAX}`; };
  message.oninput = updateCount;
  updateCount();

  return new Promise(resolve => {
    dialog.addEventListener('cancel', e => e.preventDefault()); // Esc로 닫지 못하게
    form.onsubmit = async e => {
      e.preventDefault();
      const entry = { clientId: saved?.clientId || newClientId(), name: name.value.trim() };
      if (!entry.name || !code.value.trim()) return;
      submit.disabled = true;
      error.hidden = true;
      try {
        // 한마디는 선택. 비우면 '(없음)'으로 기록한다 (서버는 빈 값을 받지 않음)
        const r = await callServer({ action: 'enter', ...entry, code: code.value.trim(), message: message.value.trim() || '(없음)' });
        if (r.ok) {
          saveEntry({ ...entry, codeVersion: r.codeVersion });
          dialog.close();
          resolve();
          return;
        }
        error.textContent = r.error === 'wrong-code' ? '입장 코드가 맞지 않습니다. 관리자에게 받은 코드를 확인해 주세요.' : '입력한 내용을 확인해 주세요.';
        if (r.error === 'wrong-code') code.select();
      } catch {
        error.textContent = '서버에 연결할 수 없습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.';
      } finally {
        submit.disabled = false;
      }
      error.hidden = false;
    };
    dialog.showModal();
    (saved?.name ? code : name).focus();
  });
}

/** PDF·이미지 저장 완료 기록 (실패해도 작업에는 영향 없음) */
export function trackExport(type) {
  if (!TRACKING_URL) return;
  const entry = readEntry();
  if (!entry) return;
  callServer({ action: 'track', type, clientId: entry.clientId, name: entry.name, codeVersion: entry.codeVersion }, { keepalive: true }).catch(() => {});
}
