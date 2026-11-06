// 관리자 화면: 이용 현황(일·주·월·연별 이용자 수와 명단), 이용자 목록, 입장 코드 변경, 공지사항 등록·수정·삭제
// 데이터는 모두 Apps Script 서버에 관리자 토큰(메일 인증으로 받음)을 보내 받아 온다. 이 페이지에는 아무 데이터도 들어 있지 않다.

import { TRACKING_URL } from './config.js';
import { callServer } from './gate.js';
import { bindAdminAuth, getAdminToken, clearAdminToken } from './adminAuth.js';

const $ = s => document.querySelector(s);

let token = '';
let data = null;
let period = 'day';

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

async function withBusy(msg, fn) {
  $('#busyMsg').textContent = msg;
  $('#busy').hidden = false;
  try { return await fn(); } finally { $('#busy').hidden = true; }
}

const adminCall = (op, extra = {}) => callServer({ action: 'admin', token, op, ...extra });

const ERRORS = { missing: '값을 입력해 주세요.' };
const errorText = r => ERRORS[r.error] || `처리하지 못했습니다 (${r.error || '알 수 없는 오류'})`;

// ── 인증 ──────────────────────────────────────────────

function showAuth(message) {
  clearAdminToken();
  token = '';
  $('#dashboard').hidden = true;
  $('#btnLogout').hidden = true;
  $('#loginCard').hidden = false;
  bindAdminAuth($('#loginCard'), t => open(t).catch(err => toast(`서버에 연결할 수 없습니다 (${err.message})`)));
  if (message) {
    $('#loginCard .auth-error').textContent = message;
    $('#loginCard .auth-error').hidden = false;
  }
}

/** 토큰으로 이용 현황을 받아 대시보드를 연다. 토큰이 만료됐으면 인증 화면으로 */
async function open(t) {
  token = t;
  const r = await withBusy('불러오는 중…', () => adminCall('stats'));
  if (!r.ok) return showAuth(r.error === 'not-authorized' ? '인증 시간이 지났습니다. 다시 인증해 주세요.' : errorText(r));
  data = r;
  $('#loginCard').hidden = true;
  $('#dashboard').hidden = false;
  $('#btnLogout').hidden = false;
  render();
}

async function refresh() {
  const r = await withBusy('불러오는 중…', () => adminCall('stats'));
  if (!r.ok) return r.error === 'not-authorized' ? showAuth('인증 시간이 지났습니다. 다시 인증해 주세요.') : toast(errorText(r));
  data = r;
  render();
  toast('최신 내용으로 바꿨습니다');
}

// ── 기간 묶기 (이 PC의 시간대 기준) ───────────────────

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];

function periodOf(date, kind) {
  const d = new Date(date);
  if (kind === 'day') return { key: ymd(d), label: `${ymd(d)} (${DAYS[d.getDay()]})` };
  if (kind === 'week') {
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    return { key: ymd(monday), label: `${ymd(monday)} ~ ${pad(sunday.getMonth() + 1)}-${pad(sunday.getDate())}` };
  }
  if (kind === 'month') return { key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`, label: `${d.getFullYear()}년 ${d.getMonth() + 1}월` };
  return { key: String(d.getFullYear()), label: `${d.getFullYear()}년` };
}

/** 저장 기록 → 기간별 이용자 (같은 사람은 한 번만) */
function groupByPeriod(events, kind) {
  const groups = new Map();
  for (const ev of events) {
    const t = new Date(ev.time);
    if (Number.isNaN(t.getTime())) continue;
    const { key, label } = periodOf(t, kind);
    if (!groups.has(key)) groups.set(key, { key, label, users: new Map() });
    groups.get(key).users.set(ev.clientId || ev.name, ev.name);
  }
  return [...groups.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
}

function fmt(time) {
  if (!time) return '-';
  const d = new Date(time);
  return Number.isNaN(d.getTime()) ? '-' : `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── 화면 ──────────────────────────────────────────────

function cell(text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;
  return td;
}

function emptyRow(cols, text) {
  const tr = document.createElement('tr');
  tr.className = 'empty';
  const td = cell(text);
  td.colSpan = cols;
  tr.append(td);
  return tr;
}

function render() {
  $('#currentCode').textContent = data.code;
  $('#codeVersion').textContent = `(버전 ${data.codeVersion})`;
  for (const b of document.querySelectorAll('#periodTabs button')) b.classList.toggle('active', b.dataset.period === period);

  const groups = groupByPeriod(data.events, period);
  $('#periodRows').replaceChildren(...(groups.length ? groups.map(g => {
    const tr = document.createElement('tr');
    const names = document.createElement('td');
    const wrap = document.createElement('div');
    wrap.className = 'names';
    wrap.append(...[...g.users.values()].sort().map(n => Object.assign(document.createElement('span'), { textContent: n })));
    names.append(wrap);
    tr.append(cell(g.label), cell(`${g.users.size}명`, 'num-col'), names);
    return tr;
  }) : [emptyRow(3, '아직 PDF·이미지를 저장한 기록이 없습니다')]));

  // 이용자 목록: 같은 사람(브라우저)은 한 줄로, 이름·한마디는 가장 최근 입장 기준
  const users = new Map();
  for (const en of data.entries) {
    const id = en.clientId || en.name;
    const u = users.get(id) || { first: en.time, entries: 0 };
    Object.assign(u, { name: en.name, message: en.message, last: en.time, entries: u.entries + 1 });
    users.set(id, u);
  }
  for (const ev of data.events) {
    const id = ev.clientId || ev.name;
    // 입장 기록이 시트에서 지워진 사람도 저장 기록이 있으면 목록에 보인다
    if (!users.has(id)) users.set(id, { name: ev.name, message: '', first: '', last: '' });
    const u = users.get(id);
    if (!u.lastUse || ev.time > u.lastUse) u.lastUse = ev.time;
  }
  const list = [...users.values()].sort((a, b) => ((b.lastUse || b.last) > (a.lastUse || a.last) ? 1 : -1));
  $('#userCount').textContent = `${list.length}명`;
  $('#userRows').replaceChildren(...(list.length
    ? list.map(u => {
      const tr = document.createElement('tr');
      tr.append(cell(u.name), cell(u.message), cell(fmt(u.first)), cell(fmt(u.last)), cell(fmt(u.lastUse)));
      return tr;
    })
    : [emptyRow(5, '아직 입장한 이용자가 없습니다')]));

  renderNotices();
}

// ── 공지사항 ──────────────────────────────────────────

let editingId = null; // 수정 중인 공지 (없으면 새로 등록)

function renderNotices() {
  const notices = data.notices;
  const ready = Array.isArray(notices);
  $('#noticeForm').querySelectorAll('input, textarea, button').forEach(el => { el.disabled = !ready; });
  if (!ready) {
    $('#noticeCount').textContent = '';
    $('#noticeRows').replaceChildren(emptyRow(3, '기록 서버(Apps Script)를 새 버전으로 다시 배포해야 공지사항을 쓸 수 있습니다'));
    return;
  }
  $('#noticeCount').textContent = `${notices.length}개`;
  $('#noticeRows').replaceChildren(...(notices.length ? notices.map(n => {
    const tr = document.createElement('tr');
    if (n.id === editingId) tr.className = 'editing';
    const title = cell(n.title);
    title.append(Object.assign(document.createElement('div'), { className: 'notice-preview', textContent: n.body }));
    const acts = cell('', 'act-col');
    const edit = Object.assign(document.createElement('button'), { className: 'small', textContent: '수정' });
    edit.onclick = () => startEdit(n);
    const del = Object.assign(document.createElement('button'), { className: 'small danger', textContent: '삭제' });
    del.onclick = () => deleteNotice(n);
    acts.append(edit, del);
    tr.append(title, cell(fmt(n.time).slice(0, 10), 'date-col'), acts);
    return tr;
  }) : [emptyRow(3, '등록된 공지사항이 없습니다')]));
}

function updateNoticeCount() {
  $('#noticeBodyCount').textContent = `${$('#noticeBodyInput').value.length}/3000`;
}

function startEdit(n) {
  editingId = n.id;
  $('#noticeTitleInput').value = n.title;
  $('#noticeBodyInput').value = n.body;
  $('#noticeFormTitle').textContent = '공지사항 수정';
  $('#noticeSubmit').textContent = '수정 저장';
  $('#noticeCancel').hidden = false;
  updateNoticeCount();
  renderNotices();
  $('#noticeTitleInput').focus();
  $('#noticeForm').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function resetNoticeForm() {
  editingId = null;
  $('#noticeForm').reset();
  $('#noticeFormTitle').textContent = '공지사항 등록';
  $('#noticeSubmit').textContent = '등록';
  $('#noticeCancel').hidden = true;
  updateNoticeCount();
}

/** 공지 저장·삭제 공통: 서버 응답의 최신 목록으로 바꾼다 */
async function noticeCall(op, extra, busyMsg) {
  try {
    const r = await withBusy(busyMsg, () => adminCall(op, extra));
    if (!r.ok) {
      if (r.error === 'not-authorized') showAuth('인증 시간이 지났습니다. 다시 인증해 주세요.');
      else toast(r.error === 'not-found' ? '이미 삭제된 공지입니다. 새로고침해 주세요.' : errorText(r));
      return false;
    }
    data.notices = r.notices;
    return true;
  } catch (err) {
    toast(`서버에 연결할 수 없습니다 (${err.message})`);
    return false;
  }
}

async function deleteNotice(n) {
  if (!confirm(`'${n.title}' 공지를 삭제할까요?\n편집기에서도 바로 사라집니다.`)) return;
  if (!(await noticeCall('noticeDelete', { id: n.id }, '삭제하는 중…'))) return;
  if (editingId === n.id) resetNoticeForm();
  renderNotices();
  toast('공지를 삭제했습니다');
}

function bindNotices() {
  $('#noticeBodyInput').oninput = updateNoticeCount;
  $('#noticeCancel').onclick = () => { resetNoticeForm(); renderNotices(); };
  $('#noticeForm').onsubmit = async e => {
    e.preventDefault();
    const title = $('#noticeTitleInput').value.trim();
    const body = $('#noticeBodyInput').value.trim();
    if (!title || !body) return toast('제목과 내용을 입력해 주세요');
    const editing = !!editingId;
    if (!(await noticeCall('noticeSave', { id: editingId || '', title, body }, editing ? '수정하는 중…' : '등록하는 중…'))) return;
    resetNoticeForm();
    renderNotices();
    toast(editing ? '공지를 수정했습니다' : '공지를 등록했습니다. 편집기 오른쪽 아래 공지 버튼에 바로 보입니다');
  };
}

// ── 연결 ──────────────────────────────────────────────

function bind() {
  bindNotices();
  $('#btnLogout').onclick = async () => {
    await adminCall('logout').catch(() => {});
    showAuth();
    toast('로그아웃했습니다');
  };
  $('#periodTabs').onclick = e => {
    const p = e.target.closest('button')?.dataset.period;
    if (!p) return;
    period = p;
    render();
  };
  $('#btnRefresh').onclick = () => refresh().catch(err => toast(`서버에 연결할 수 없습니다 (${err.message})`));
  $('#codeForm').onsubmit = async e => {
    e.preventDefault();
    const code = $('#newCode').value.trim();
    if (!code) return;
    if (!confirm(`입장 코드를 '${code}'(으)로 바꿀까요?\n모든 이용자가 다음 접속 때 새 코드를 입력해야 합니다.`)) return;
    try {
      const r = await withBusy('바꾸는 중…', () => adminCall('setCode', { code }));
      if (!r.ok) return r.error === 'not-authorized' ? showAuth('인증 시간이 지났습니다. 다시 인증해 주세요.') : toast(errorText(r));
      data.code = r.code;
      data.codeVersion = r.codeVersion;
      $('#newCode').value = '';
      render();
      toast('입장 코드를 바꿨습니다');
    } catch (err) {
      toast(`서버에 연결할 수 없습니다 (${err.message})`);
    }
  };
}

bind();
if (!TRACKING_URL) {
  $('#notConfigured').hidden = false;
  $('#loginCard').hidden = true;
} else {
  const saved = getAdminToken();
  if (saved) open(saved).catch(() => showAuth());
  else showAuth();
}
