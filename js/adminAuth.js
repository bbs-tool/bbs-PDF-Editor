// 관리자 메일 인증: 서버가 배포한 구글 계정 메일로 6자리 코드를 보내고, 맞게 입력하면 관리자 토큰(최대 6시간)을 받는다.
// 편집기의 '관리자 모드' 팝업과 관리자 화면(admin.html)이 함께 쓴다.

import { ADMIN_NAME } from './config.js';
import { callServer } from './gate.js';

const TOKEN_KEY = 'pdf-editor.adminToken'; // { token, expires } — 같은 브라우저의 새 탭에서도 쓰도록 localStorage

export function getAdminToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY));
    return t && t.expires > Date.now() ? t.token : null;
  } catch {
    return null;
  }
}

export function clearAdminToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* 무시 */ }
}

function saveToken(token, seconds) {
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, expires: Date.now() + (seconds - 60) * 1000 })); } catch { /* 무시 */ }
}

const ERRORS = {
  'too-soon': '방금 인증 코드를 보냈습니다. 1분 뒤에 다시 받을 수 있습니다.',
  'code-expired': '인증 코드가 만료되었습니다. [인증 코드 받기]를 다시 눌러 주세요.',
  'too-many-tries': '입력 기회를 모두 썼습니다. [인증 코드 받기]를 다시 눌러 주세요.',
};

/**
 * 인증 화면 연결. root 안에 아래 요소가 있어야 한다.
 * .auth-greet, .auth-request(버튼), .auth-sent, .auth-code(입력), .auth-verify(버튼), .auth-error
 */
export function bindAdminAuth(root, onSuccess) {
  const q = s => root.querySelector(s);
  q('.auth-greet').innerHTML = '';
  q('.auth-greet').append(`안녕하세요, ${ADMIN_NAME}님 인증을 진행해 주세요`, document.createElement('br'), `${ADMIN_NAME}님이 아니라면 접근이 불가능합니다.`);
  const showError = text => {
    q('.auth-error').textContent = text;
    q('.auth-error').hidden = !text;
  };
  const step2 = on => {
    for (const el of root.querySelectorAll('.auth-step2')) el.hidden = !on;
  };
  step2(false);
  showError('');

  q('.auth-request').onclick = async () => {
    showError('');
    q('.auth-request').disabled = true;
    try {
      const r = await callServer({ action: 'adminRequestCode' });
      if (!r.ok) return showError(ERRORS[r.error] || `인증 코드를 보내지 못했습니다 (${r.error})`);
      q('.auth-sent').textContent = `${r.sentTo}(으)로 인증 코드를 보냈습니다. 메일에서 6자리 숫자를 확인해 입력해 주세요. (10분 동안 유효)`;
      q('.auth-request').textContent = '인증 코드 다시 받기';
      step2(true);
      q('.auth-code').value = '';
      q('.auth-code').focus();
    } catch {
      showError('서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.');
    } finally {
      q('.auth-request').disabled = false;
    }
  };

  const verify = async () => {
    const code = q('.auth-code').value.trim();
    if (!/^\d{6}$/.test(code)) return showError('메일로 받은 6자리 숫자를 입력해 주세요.');
    showError('');
    q('.auth-verify').disabled = true;
    try {
      const r = await callServer({ action: 'adminVerify', code });
      if (!r.ok) {
        return showError(r.error === 'wrong-code' ? `인증 코드가 맞지 않습니다. (남은 기회 ${r.left}번)` : ERRORS[r.error] || `인증하지 못했습니다 (${r.error})`);
      }
      saveToken(r.token, r.expiresIn);
      onSuccess(r.token);
    } catch {
      showError('서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.');
    } finally {
      q('.auth-verify').disabled = false;
    }
  };
  q('.auth-verify').onclick = verify;
  q('.auth-code').onkeydown = e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      verify();
    }
  };
}
