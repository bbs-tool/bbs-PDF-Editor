// 입장·이용 기록 서버(Google Apps Script 웹 앱) 주소. 설정 방법은 backend/README.md 참고.
// 비워 두면 입장 팝업 없이 누구나 쓸 수 있다 (내 PC에서 시험할 때).
// 예: 'https://script.google.com/macros/s/AKfy.../exec'
export const TRACKING_URL = 'https://script.google.com/macros/s/AKfycbw6XpgOHyUs2lj0d5CnckPKQNwUTB7KxJCgxdXa8P7IxCab8eHViyY8RmUGj-y_pFx7/exec';

// 구글 계정 로그인용 OAuth 클라이언트 ID (Google Cloud에서 발급, backend/README.md 참고)
// 넣으면 입장 코드 대신 [Google 계정으로 로그인]으로 입장한다. backend/Code.gs의 GOOGLE_CLIENT_ID와 같은 값.
// 비워 두면 예전 입장 코드 방식. 예: '1234567890-abc...xyz.apps.googleusercontent.com'
export const GOOGLE_CLIENT_ID = '492685700328-4pfq0rjrvsq5ifrtgth8korer54lhkgg.apps.googleusercontent.com';

// 관리자 인증 화면에 보이는 관리자 호칭 (인증 코드는 서버를 배포한 구글 계정 메일로 간다)
export const ADMIN_NAME = 'BB';
