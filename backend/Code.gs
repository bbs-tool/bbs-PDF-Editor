/**
 * PDF 편집기 입장·이용 기록 서버 (Google Apps Script)
 *
 * 구글 시트에 붙여서 '웹 앱'으로 배포한다. 설정 방법은 backend/README.md 참고.
 * - 입장: 이름 / 입장 코드 / 관리자에게 한마디 → '입장기록' 시트
 * - 이용: PDF·이미지 저장 완료 → '이용기록' 시트
 * - 관리자: 이 스크립트를 배포한 구글 계정의 메일로 인증 코드를 받아 인증 → 이용 현황 조회, 입장 코드 변경, 공지사항 등록
 * - 공지사항: '공지사항' 시트. 편집기 오른쪽 아래 공지 버튼에서 누구나 볼 수 있다
 *
 * 입장 코드는 이 스크립트의 '스크립트 속성'에 저장되어 웹에 공개되지 않는다.
 * 관리자 메일 주소도 코드에 적지 않는다 (배포한 계정을 자동으로 쓴다).
 * 아래 값은 처음 한 번만 쓰이고, 이후에는 관리자 화면에서 바꾼다.
 */
const INITIAL_ENTRY_CODE = '0000';

const OTP_TTL = 600; // 인증 코드 유효 시간(초)
const OTP_TRIES = 5; // 인증 코드 입력 기회
const OTP_COOLDOWN = 60; // 인증 코드 다시 받기 대기(초)
const ADMIN_SESSION = 21600; // 인증 후 관리자 화면 이용 시간(초, 최대 6시간)

const ENTRY_SHEET = '입장기록';
const EVENT_SHEET = '이용기록';
const CODE_SHEET = '코드로그';
const NOTICE_SHEET = '공지사항';
const NOTICE_HEADER = ['등록 시각', '공지 ID', '제목', '내용', '수정 시각'];
const NOTICE_TITLE_MAX = 60;
const NOTICE_BODY_MAX = 3000;
const ENTRY_HEADER = ['입장 시각', '사용자 ID', '이름', '관리자에게 한마디', '코드 버전'];
const EVENT_HEADER = ['저장 시각', '사용자 ID', '이름', '종류'];
const CODE_HEADER = ['변경 시각', '입장 코드', '코드 버전'];
const NAME_MAX = 20;
const MESSAGE_MAX = 50;

function doGet() {
  return out({ ok: true, service: 'pdf-editor-tracking' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return out({ ok: false, error: 'bad-request' });
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return out(handle(req));
  } catch (err) {
    return out({ ok: false, error: 'server-error', detail: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function handle(req) {
  const conf = settings();
  switch (req.action) {
    case 'enter': {
      const name = clean(req.name, NAME_MAX);
      const message = clean(req.message, MESSAGE_MAX);
      const clientId = clean(req.clientId, 64);
      if (!name || !message || !clientId) return { ok: false, error: 'missing' };
      if (String(req.code || '').trim() !== conf.code) return { ok: false, error: 'wrong-code' };
      sheet(ENTRY_SHEET, ENTRY_HEADER).appendRow([new Date(), clientId, safe(name), safe(message), conf.version]);
      return { ok: true, codeVersion: conf.version };
    }
    case 'check':
      // 입장 코드가 바뀌었으면 다시 입장해야 한다
      return String(req.codeVersion) === conf.version ? { ok: true } : { ok: false, error: 'code-changed' };
    case 'track': {
      // 쓰는 도중 코드가 바뀌었어도 이미 입장한 사람의 저장은 기록한다 (다음 접속 때 다시 입장)
      const type = req.type === 'image' ? 'image' : 'pdf';
      sheet(EVENT_SHEET, EVENT_HEADER).appendRow([new Date(), clean(req.clientId, 64), safe(clean(req.name, NAME_MAX)), type]);
      return { ok: true };
    }
    case 'notices':
      // 공지사항은 누구나 볼 수 있다 (편집기 오른쪽 아래 공지 버튼)
      return { ok: true, notices: listNotices() };
    case 'adminRequestCode':
      return requestAdminCode();
    case 'adminVerify':
      return verifyAdminCode(req.code);
    case 'admin':
      return admin(req, conf);
    default:
      return { ok: false, error: 'unknown-action' };
  }
}

// ── 관리자 메일 인증 ───────────────────────────────────

function ownerEmail() {
  return Session.getEffectiveUser().getEmail(); // '나'로 실행되는 웹 앱이므로 배포한 계정
}

function requestAdminCode() {
  const cache = CacheService.getScriptCache();
  if (cache.get('otp-cooldown')) return { ok: false, error: 'too-soon' };
  const code = String(Math.floor(100000 + Math.random() * 900000));
  cache.putAll({ otp: code, 'otp-tries': '0' }, OTP_TTL);
  cache.put('otp-cooldown', '1', OTP_COOLDOWN);
  MailApp.sendEmail(ownerEmail(), "[BB's PDF Editor] 관리자 인증 코드",
    `관리자 인증 코드: ${code}\n\n${OTP_TTL / 60}분 동안 유효합니다.\n직접 요청하지 않았다면 이 메일은 무시하세요.`);
  return { ok: true, sentTo: mask(ownerEmail()) };
}

function verifyAdminCode(code) {
  const cache = CacheService.getScriptCache();
  const otp = cache.get('otp');
  if (!otp) return { ok: false, error: 'code-expired' };
  const tries = Number(cache.get('otp-tries') || 0) + 1;
  if (tries > OTP_TRIES) {
    cache.remove('otp');
    return { ok: false, error: 'too-many-tries' };
  }
  cache.put('otp-tries', String(tries), OTP_TTL);
  if (String(code || '').trim() !== otp) return { ok: false, error: 'wrong-code', left: OTP_TRIES - tries };
  cache.remove('otp');
  const token = Utilities.getUuid();
  cache.put(`admin:${token}`, '1', ADMIN_SESSION);
  return { ok: true, token, expiresIn: ADMIN_SESSION };
}

// abcd1234@gmail.com → ab******@gmail.com
function mask(email) {
  const [id, domain] = String(email).split('@');
  return `${id.slice(0, 2)}${'*'.repeat(Math.max(2, id.length - 2))}@${domain}`;
}

function admin(req, conf) {
  if (!req.token || !CacheService.getScriptCache().get(`admin:${req.token}`)) return { ok: false, error: 'not-authorized' };
  const props = PropertiesService.getScriptProperties();
  switch (req.op) {
    case 'stats':
      return {
        ok: true,
        code: conf.code,
        codeVersion: conf.version,
        entries: rows(ENTRY_SHEET, ENTRY_HEADER).map(r => ({ time: iso(r[0]), clientId: r[1], name: r[2], message: r[3], codeVersion: String(r[4]) })),
        events: rows(EVENT_SHEET, EVENT_HEADER).map(r => ({ time: iso(r[0]), clientId: r[1], name: r[2], type: r[3] })),
        notices: listNotices(),
      };
    case 'noticeSave': {
      // id가 있으면 수정, 없으면 새로 등록
      const title = clean(req.title, NOTICE_TITLE_MAX);
      const body = cleanText(req.body, NOTICE_BODY_MAX);
      if (!title || !body) return { ok: false, error: 'missing' };
      const s = sheet(NOTICE_SHEET, NOTICE_HEADER);
      if (req.id) {
        const row = noticeRow(s, req.id);
        if (!row) return { ok: false, error: 'not-found' };
        s.getRange(row, 3, 1, 3).setValues([[asText(title), asText(body), new Date()]]);
      } else {
        s.appendRow([new Date(), Utilities.getUuid().slice(0, 8), asText(title), asText(body), '']);
      }
      return { ok: true, notices: listNotices() };
    }
    case 'noticeDelete': {
      const s = sheet(NOTICE_SHEET, NOTICE_HEADER);
      const row = noticeRow(s, req.id);
      if (!row) return { ok: false, error: 'not-found' };
      s.deleteRow(row);
      return { ok: true, notices: listNotices() };
    }
    case 'setCode': {
      const code = clean(req.code, 30);
      if (!code) return { ok: false, error: 'missing' };
      const version = String(Number(conf.version) + 1); // 버전이 바뀌면 모든 이용자가 다시 입장한다
      props.setProperties({ ENTRY_CODE: code, CODE_VERSION: version });
      logCode(code, version);
      return { ok: true, code, codeVersion: version };
    }
    case 'logout':
      CacheService.getScriptCache().remove(`admin:${req.token}`);
      return { ok: true };
    default:
      return { ok: false, error: 'unknown-op' };
  }
}

// ── 도우미 ─────────────────────────────────────────────

function settings() {
  const props = PropertiesService.getScriptProperties();
  let all = props.getProperties();
  if (!all.ENTRY_CODE) {
    props.setProperties({ ENTRY_CODE: INITIAL_ENTRY_CODE, CODE_VERSION: '1' });
    logCode(INITIAL_ENTRY_CODE, '1');
    all = props.getProperties();
  }
  return { code: all.ENTRY_CODE, version: all.CODE_VERSION };
}

// 입장 코드가 정해지거나 바뀔 때마다 '코드로그' 탭에 한 줄 남긴다
function logCode(code, version) {
  // 앞의 '는 '0001' 같은 코드가 숫자 1로 바뀌지 않게 글자로 저장하는 표시 (시트에는 보이지 않음)
  sheet(CODE_SHEET, CODE_HEADER).appendRow([new Date(), `'${code}`, version]);
}

function sheet(name, header) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const s = book.getSheetByName(name) || book.insertSheet(name);
  // 머리글이 없으면(탭을 직접 만들었거나 기본 시트 이름을 바꾼 경우) 맨 위에 끼워 넣는다
  if (s.getLastRow() === 0) {
    s.appendRow(header);
  } else if (String(s.getRange(1, 1).getValue()) !== header[0]) {
    s.insertRowBefore(1);
    s.getRange(1, 1, 1, header.length).setValues([header]);
  }
  if (s.getFrozenRows() !== 1) s.setFrozenRows(1);
  return s;
}

function rows(name, header) {
  const values = sheet(name, header).getDataRange().getValues();
  return values.slice(1).filter(r => r[0] !== '' && r[0] != null);
}

// 공지사항 목록 (최근 등록 순)
function listNotices() {
  return rows(NOTICE_SHEET, NOTICE_HEADER)
    .map(r => ({ time: iso(r[0]), id: String(r[1]), title: String(r[2]), body: String(r[3]), updated: r[4] ? iso(r[4]) : '' }))
    .filter(n => n.id && n.title)
    .reverse();
}

// 공지 ID가 있는 시트 줄 번호 (머리글이 1번 줄). 없으면 0
function noticeRow(s, id) {
  const ids = s.getRange(1, 2, s.getLastRow(), 1).getValues();
  for (let i = 1; i < ids.length; i++) if (String(ids[i][0]) === String(id || '')) return i + 1;
  return 0;
}

// 줄바꿈은 남기는 clean (공지 내용용)
function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').trim().slice(0, max);
}

function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

// 시트에서 수식으로 실행되지 않게 (=, +, -, @로 시작하는 글자)
function safe(v) {
  return /^[=+\-@]/.test(v) ? `'${v}` : v;
}

// 앞에 '를 붙여 날짜·숫자·수식으로 바뀌지 않고 글자 그대로 저장 (시트에는 '가 보이지 않음)
function asText(v) {
  return `'${v}`;
}

function iso(v) {
  return v instanceof Date ? v.toISOString() : String(v);
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
