// 공지사항: 오른쪽 아래 동그란 버튼 → 팝업(목록) → 항목을 누르면 내용
// 공지는 관리자 화면에서 등록하고, 기록 서버(Apps Script)의 '공지사항' 시트에 저장된다.
// 읽은 공지는 이 브라우저에 기억해 두고, 안 읽은 공지가 있으면 버튼에 빨간 점을 띄운다.

import { TRACKING_URL } from './config.js';
import { callServer } from './gate.js';

const SEEN_KEY = 'pdf-editor.noticeSeen';
const $ = s => document.querySelector(s);

let notices = [];

function readSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY)) || []); } catch { return new Set(); }
}

function markSeen(id) {
  const seen = readSeen();
  seen.add(id);
  // 지금 남아 있는 공지만 기억한다 (지운 공지가 계속 쌓이지 않게)
  const keep = [...seen].filter(x => notices.some(n => n.id === x));
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(keep)); } catch { /* 저장 못 하면 다음에도 새 공지로 보임 */ }
}

const pad = n => String(n).padStart(2, '0');
function fmtDate(time) {
  const d = new Date(time);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

async function load() {
  const r = await callServer({ action: 'notices' });
  if (!r.ok) throw new Error(r.error || 'notices');
  notices = Array.isArray(r.notices) ? r.notices : [];
}

function renderBadge() {
  const seen = readSeen();
  $('#btnNotice').classList.toggle('has-new', notices.some(n => !seen.has(n.id)));
}

function showList() {
  const seen = readSeen();
  $('#noticeDetail').hidden = true;
  $('#noticeList').hidden = false;
  $('#noticeBack').hidden = true;
  $('#noticeHeading').textContent = '공지사항';
  const list = $('#noticeList');
  if (!notices.length) {
    list.replaceChildren(Object.assign(document.createElement('li'), { className: 'notice-empty', textContent: '등록된 공지사항이 없습니다' }));
    return;
  }
  list.replaceChildren(...notices.map(n => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'notice-item';
    const title = Object.assign(document.createElement('span'), { className: 'notice-item-title', textContent: n.title });
    if (!seen.has(n.id)) title.prepend(Object.assign(document.createElement('em'), { className: 'notice-new', textContent: 'N' }));
    const date = Object.assign(document.createElement('span'), { className: 'notice-item-date', textContent: fmtDate(n.time) });
    b.append(title, date);
    b.onclick = () => showDetail(n);
    li.append(b);
    return li;
  }));
}

function showDetail(n) {
  markSeen(n.id);
  renderBadge();
  $('#noticeList').hidden = true;
  $('#noticeDetail').hidden = false;
  $('#noticeBack').hidden = false;
  $('#noticeHeading').textContent = '공지사항';
  $('#noticeTitle').textContent = n.title;
  $('#noticeDate').textContent = fmtDate(n.time) + (n.updated ? ` (수정 ${fmtDate(n.updated)})` : '');
  $('#noticeBody').textContent = n.body;
  $('#noticeDetail').scrollTop = 0;
}

function open() {
  $('#noticePanel').hidden = false;
  $('#btnNotice').setAttribute('aria-expanded', 'true');
  showList();
  // 열 때마다 최신 공지를 다시 받아 온다 (실패하면 갖고 있던 목록 그대로)
  load().then(() => {
    renderBadge();
    if (!$('#noticePanel').hidden && !$('#noticeList').hidden) showList();
  }, () => {});
}

function close() {
  $('#noticePanel').hidden = true;
  $('#btnNotice').setAttribute('aria-expanded', 'false');
}

export async function initNotices() {
  if (!TRACKING_URL) return;
  try {
    await load();
  } catch {
    return; // 서버가 아직 공지 기능을 모르면(Apps Script 재배포 전) 버튼을 숨긴 채 둔다
  }
  const btn = $('#btnNotice');
  btn.hidden = false;
  renderBadge();
  btn.onclick = () => ($('#noticePanel').hidden ? open() : close());
  $('#noticeClose').onclick = close;
  $('#noticeBack').onclick = showList;
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#noticePanel').hidden) close();
  });
  document.addEventListener('pointerdown', e => {
    if ($('#noticePanel').hidden) return;
    if (!e.target.closest('#noticePanel, #btnNotice')) close();
  });
}
