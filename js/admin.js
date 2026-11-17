// 관리자 화면: 이용 현황(일·주·월·연별 이용자 수와 명단), 이용자 목록, 입장 코드 변경, 공지사항 등록·수정·삭제
// 데이터는 모두 Apps Script 서버에 관리자 토큰(메일 인증으로 받음)을 보내 받아 온다. 이 페이지에는 아무 데이터도 들어 있지 않다.

import { TRACKING_URL } from './config.js';
import { callServer } from './gate.js';
import { bindAdminAuth, getAdminToken, clearAdminToken } from './adminAuth.js';
import { googleMode, getSession, clearSession, renderGoogleButton } from './account.js';

const $ = s => document.querySelector(s);

let token = ''; // 예전 메일 인증 토큰 (구글 로그인에서는 쓰지 않음)
let data = null;
let period = 'day';
const GOOGLE = googleMode();
// 구글 로그인: 편집기와 같은 브라우저 저장소의 로그인 정보를 함께 쓴다 (관리자 계정일 때만 열림)
const adminSession = () => (GOOGLE ? getSession() : null);

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

const adminCall = (op, extra = {}) => callServer({ action: 'admin', token, session: adminSession()?.session || '', op, ...extra });

const ERRORS = { missing: '값을 입력해 주세요.', owner: '관리자 계정은 바꿀 수 없습니다.' };
const errorText = r => ERRORS[r.error] || `처리하지 못했습니다 (${r.error || '알 수 없는 오류'})`;

// ── 인증 ──────────────────────────────────────────────

function showAuth(message) {
  clearAdminToken();
  token = '';
  $('#dashboard').hidden = true;
  $('#btnLogout').hidden = true;
  if (GOOGLE) return showGoogleAuth(message);
  $('#loginCard').hidden = false;
  bindAdminAuth($('#loginCard'), t => open(t).catch(err => toast(`서버에 연결할 수 없습니다 (${err.message})`)));
  if (message) {
    $('#loginCard .auth-error').textContent = message;
    $('#loginCard .auth-error').hidden = false;
  }
}

/** 구글 로그인 화면: 관리자 계정으로 로그인하면 바로 대시보드를 연다 */
function showGoogleAuth(message) {
  $('#loginCard').hidden = true;
  $('#googleLoginCard').hidden = false;
  const err = $('#googleLoginError');
  const show = text => { err.textContent = text || ''; err.hidden = !text; };
  show(message);
  renderGoogleButton($('#adminGoogleButton'), {
    forAdmin: true,
    onDone: () => open('').catch(e => toast(`서버에 연결할 수 없습니다 (${e.message})`)),
    onError: show,
    onBusy: on => { if (on) show('확인하는 중…'); },
  });
}

/** 토큰으로 이용 현황을 받아 대시보드를 연다. 토큰이 만료됐으면 인증 화면으로 */
async function open(t) {
  token = t;
  const r = await withBusy('불러오는 중…', () => adminCall('stats'));
  if (!r.ok) {
    if (GOOGLE && r.error === 'not-authorized') return showAuth(adminSession() ? '관리자 계정이 아닙니다. 관리자 구글 계정으로 로그인해 주세요.' : '');
    return showAuth(r.error === 'not-authorized' ? '인증 시간이 지났습니다. 다시 인증해 주세요.' : errorText(r));
  }
  data = r;
  $('#loginCard').hidden = true;
  $('#googleLoginCard').hidden = true;
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
  // 구글 로그인을 쓰면 입장 코드 대신 입장 방식·사용자 관리를 보인다
  $('#codeCard').hidden = $('#userSection').hidden = GOOGLE;
  $('#accessCard').hidden = $('#accountSection').hidden = !GOOGLE;
  if (GOOGLE) renderAccounts();
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

// ── 구글 계정 사용자 ──────────────────────────────────

const STATUS_LABEL = { allowed: '허용', pending: '승인 대기', blocked: '차단' };
const ACCESS_HINT = {
  list: '허용 목록에 있는 계정만 들어올 수 있습니다. 처음 로그인한 사람은 [승인 대기]로 올라오고, 관리자 메일로 알림이 갑니다.',
  open: '구글 계정만 있으면 누구나 들어옵니다 (차단한 계정 제외). 들어온 사람은 자동으로 [허용]이 되어, 나중에 [허용한 사람만]으로 바꿔도 계속 쓸 수 있습니다.',
};

function renderAccounts() {
  if (!Array.isArray(data.users)) {
    $('#accountRows').replaceChildren(emptyRow(6, '기록 서버(Apps Script)를 새 버전으로 다시 배포해야 사용자 관리를 쓸 수 있습니다'));
    return;
  }
  for (const b of document.querySelectorAll('#accessMode button')) b.classList.toggle('active', b.dataset.mode === data.accessMode);
  $('#accessHint').textContent = ACCESS_HINT[data.accessMode] || '';
  if (!data.google) $('#accessHint').textContent += ' ※ 기록 서버(Code.gs)의 GOOGLE_CLIENT_ID가 비어 있어 아직 구글 로그인이 동작하지 않습니다.';

  const lastSave = new Map();
  for (const ev of data.events) {
    const id = String(ev.clientId).toLowerCase();
    if (!lastSave.has(id) || ev.time > lastSave.get(id)) lastSave.set(id, ev.time);
  }
  const owner = String(data.owner || '').toLowerCase();
  const order = { pending: 0, allowed: 1, blocked: 2 };
  const users = [...data.users].sort((a, b) => order[a.status] - order[b.status] || ((b.last || '') > (a.last || '') ? 1 : -1));
  const pending = users.filter(u => u.status === 'pending').length;
  $('#accountCount').textContent = `${users.length}명${pending ? ` · 승인 대기 ${pending}명` : ''}`;
  $('#accountRows').replaceChildren(...(users.length ? users.map(u => {
    const tr = document.createElement('tr');
    if (u.status === 'pending') tr.className = 'pending';
    const who = cell(u.name || '(아직 로그인 전)');
    who.append(Object.assign(document.createElement('div'), { className: 'email-col', textContent: u.email }));
    const st = cell('');
    st.append(Object.assign(document.createElement('span'), { className: `status ${u.status}`, textContent: u.email === owner ? '관리자' : STATUS_LABEL[u.status] }));
    const acts = cell('', 'act-col');
    if (u.email !== owner) {
      const btn = (label, status, cls = '') => {
        const b = Object.assign(document.createElement('button'), { className: `small ${cls}`, textContent: label });
        b.onclick = () => setUser(u, status);
        acts.append(b);
      };
      if (u.status !== 'allowed') btn('허용', 'allowed', 'primary');
      if (u.status !== 'blocked') btn('차단', 'blocked', 'danger');
      btn('목록에서 삭제', 'remove');
    }
    tr.append(who, st, cell(fmt(u.first)), cell(fmt(u.last)), cell(fmt(lastSave.get(u.email))), acts);
    return tr;
  }) : [emptyRow(6, '아직 로그인한 사용자가 없습니다')]));
}

async function adminOp(op, extra, busyMsg) {
  try {
    const r = await withBusy(busyMsg, () => adminCall(op, extra));
    if (!r.ok) {
      if (r.error === 'not-authorized') showAuth('로그인이 만료되었습니다. 다시 로그인해 주세요.');
      else toast(errorText(r));
      return null;
    }
    return r;
  } catch (err) {
    toast(`서버에 연결할 수 없습니다 (${err.message})`);
    return null;
  }
}

async function setUser(u, status) {
  const label = u.name ? `${u.name}(${u.email})` : u.email;
  const ask = {
    blocked: `${label} 계정을 차단할까요?\n다음 접속부터 편집기에 들어올 수 없습니다.`,
    remove: `${label} 계정을 목록에서 지울까요?\n허용한 사람만 받는 중이면 다음에 로그인할 때 다시 승인 요청이 옵니다.`,
  }[status];
  if (ask && !confirm(ask)) return;
  const r = await adminOp('userSet', { email: u.email, status }, '바꾸는 중…');
  if (!r) return;
  data.users = r.users;
  renderAccounts();
  toast({ allowed: '허용했습니다. 이제 로그인하면 바로 쓸 수 있습니다', blocked: '차단했습니다', remove: '목록에서 지웠습니다' }[status]);
}

function bindAccounts() {
  $('#accessMode').onclick = async e => {
    const mode = e.target.closest('button')?.dataset.mode;
    if (!mode || mode === data.accessMode) return;
    if (mode === 'open' && !confirm('구글 계정만 있으면 누구나 들어올 수 있게 바꿀까요?\n(차단한 계정은 계속 막힙니다)')) return;
    const r = await adminOp('setAccess', { mode }, '바꾸는 중…');
    if (!r) return;
    data.accessMode = r.accessMode;
    renderAccounts();
    toast(r.accessMode === 'open' ? '이제 구글 계정이면 누구나 들어옵니다' : '이제 허용한 사람만 들어옵니다');
  };
  $('#userAddForm').onsubmit = async e => {
    e.preventDefault();
    const email = $('#userAddEmail').value.trim().toLowerCase();
    if (!email) return;
    const r = await adminOp('userSet', { email, status: 'allowed' }, '추가하는 중…');
    if (!r) return;
    data.users = r.users;
    $('#userAddEmail').value = '';
    renderAccounts();
    toast(`${email}을(를) 허용 목록에 넣었습니다`);
  };
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
  bindAccounts();
  $('#btnLogout').onclick = async () => {
    if (GOOGLE) {
      if (!confirm('로그아웃할까요?\n같은 브라우저의 편집기에서도 로그아웃됩니다.')) return;
      clearSession();
    } else {
      await adminCall('logout').catch(() => {});
    }
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
} else if (GOOGLE) {
  if (adminSession()?.admin) open('').catch(() => showAuth());
  else showAuth();
} else {
  const saved = getAdminToken();
  if (saved) open(saved).catch(() => showAuth());
  else showAuth();
}
