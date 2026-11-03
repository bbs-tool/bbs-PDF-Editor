// 확장 기능 등록 목록.
// 각 확장은 { id, install({ api, slot }) } 형태의 모듈이다.
//   api  : window.PDFEditor 와 같은 객체 (js/api.js)
//   slot : 오른쪽 패널 아래에 확장 전용으로 비워 둔 영역 (HTMLElement)
// 예) AI 연결 확장을 만들면 아래 배열에 import 해서 추가한다. docs/EXTENSION.md 참고.

export const extensions = [];
