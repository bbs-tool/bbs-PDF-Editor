# 확장 가이드 — 개인 AI 연결

편집기의 모든 동작은 `js/commands.js`를 거치고, 같은 기능이 `window.PDFEditor` API로 공개되어 있습니다.
AI는 이 API를 "도구(tool)"로 호출하면 화면 버튼과 똑같이 문서를 편집할 수 있습니다. 실행 취소 기록에도 그대로 남습니다.

## 1. API 요약

좌표·크기 단위는 **pt**(1mm = 2.835pt), 위치는 **요소 중심** 기준입니다. 페이지 번호는 0부터 셉니다.
모든 편집 함수는 Promise를 돌려줍니다.

### 읽기

| 함수 | 설명 |
|---|---|
| `getDocument()` | 문서 구조(바이너리 제외) — `{ current, pages: [{ id, width, height, sizeMode, orientation, fitMode, objects: [...] }] }` |
| `listFonts()` | 사용 가능한 폰트 `[{ key, label, source, hasBold }]` |
| `getSelection()` | 선택된 요소 id 배열 |
| `on('change', fn)` | 문서가 바뀔 때마다 호출. 해제 함수를 돌려줌 |

### 페이지

| 함수 | 설명 |
|---|---|
| `openFiles(files, at?)` | File/Blob 배열을 페이지로 추가 |
| `goToPage(i)` | 페이지 이동 |
| `addBlankPage(after?)`, `duplicatePage(i?)`, `deletePage(i?)`, `rotatePage(i?)` | 페이지 조작 |
| `movePage(from, to)` | 순서 변경 |
| `setPageSettings(settings, indexes?)` | `{ sizeMode: 'a4'│'original'│'fit'│'custom', orientation: 'portrait'│'landscape', fitMode: 'contain'│'cover'│'stretch', customW, customH(mm), margin: { top, right, bottom, left }(mm, 'fit'·'custom'에서 더하는 영역), align: { h: 'left'│'center'│'right', v: 'top'│'middle'│'bottom' } }` |

### 요소

| 함수 | 설명 |
|---|---|
| `addText({ text, cx, cy, w, fontFamily, bold, fontSize, color, align, lineHeight, angle, opacity, pageIndex })` | 텍스트 추가 → id |
| `addShape('rect'│'ellipse', { cx, cy, w, h, fill, stroke, strokeWidth, angle, opacity, pageIndex })` | 도형 추가 → id (`fill: null`이면 채우기 없음) |
| `insertImages(blobs, { pageIndex })` | 이미지 올리기 → id 배열 |
| `updateObject(id, props)` / `updateObjects(ids, props)` | 속성 변경 (위 속성 + `locked`) |
| `deleteObjects(ids)` | 삭제 |
| `arrange(ids, 'front'│'back'│'forward'│'backward')` | 레이어 순서 (현재 페이지) |
| `select(ids)` | 화면에서 선택 |

### 템플릿

| 함수 | 설명 |
|---|---|
| `listTemplates()` | 저장된 템플릿 `[{ id, name, createdAt, pages, count }]` |
| `saveTemplate(name, indexes?)` | 고른 페이지들의 설정 + 원본 배경을 뺀 요소를 템플릿으로 저장 → id |
| `applyTemplate(id, { indexes, settings })` | 대상 페이지에 템플릿 페이지를 차례로(모자라면 반복) 추가. `settings: false`면 페이지 설정은 그대로 둔다 → 적용한 페이지 수 |
| `deleteTemplate(id)` | 삭제 |

### 기록·저장

| 함수 | 설명 |
|---|---|
| `undo()`, `redo()` | 실행 취소 / 다시 실행 |
| `exportPdf()` | 저장 결과 `Uint8Array` (다운로드는 하지 않음) |
| `exportImages({ indexes, format: 'png'│'jpg', dpi, background: 'white'│'page'│'all' })` | 페이지별 이미지 `[{ pageIndex, bytes, width, height }]`. background는 PNG만 (page: 빈 곳 투명, all: 흰색 부분 모두 투명) |
| `cropObject(id, { crop: { l, t, r, b }, cx, cy, w, h })`, `resetCrop(id)` | PDF·이미지 자르기 (crop은 원본 대비 잘라낸 비율 0~1) / 원래대로 |

### 콘솔에서 바로 써 보기

브라우저 개발자 도구(F12) 콘솔에서:

```js
await PDFEditor.addText({ text: '검토 완료', fontSize: 28, color: '#c00000', cx: 450, cy: 60, w: 180, bold: true });
await PDFEditor.addShape('ellipse', { cx: 450, cy: 60, w: 200, h: 70, fill: null, stroke: '#c00000', strokeWidth: 3 });
```

## 2. 확장 모듈 만들기

`js/extensions/` 아래에 파일을 만들고 `js/extensions/index.js`의 배열에 추가합니다.

```js
// js/extensions/hello.js
export default {
  id: 'hello',
  install({ api, slot }) {
    const btn = document.createElement('button');
    btn.textContent = '첫 페이지에 도장 찍기';
    btn.onclick = () => api.addText({ text: '확인', pageIndex: 0, cx: 520, cy: 40, w: 80, color: '#c00000', bold: true });
    slot.append(btn);
  },
};
```

```js
// js/extensions/index.js
import hello from './hello.js';
export const extensions = [hello];
```

`slot`은 오른쪽 패널 맨 아래에 확장 전용으로 비워 둔 영역입니다.

## 3. 개인 AI 연결 방식 (다음 단계 설계)

| 방식 | 구성 | 장점 | 주의 |
|---|---|---|---|
| A. 브라우저에서 AI API 직접 호출 | 확장 패널에 채팅 입력창 → 사용자의 API 키로 AI 제공사 API 호출 → 응답의 도구 호출을 `PDFEditor` 함수로 실행 | 서버 불필요, GitHub Pages 그대로 사용 | API 키는 사용자 브라우저(localStorage)에만 저장. **AI 사용료는 해당 AI 요금제 기준으로 발생** |
| B. 데스크톱 AI 앱에서 브라우저 조작 | Claude 데스크톱·Chrome 확장 등 브라우저를 조작할 수 있는 AI가 페이지의 `PDFEditor` API를 호출 | 편집기 코드 수정이 거의 없음 | AI 쪽 도구 지원 여부에 따라 다름 |
| C. 로컬 브리지 | PC에서 작은 서버(MCP 등)를 띄우고 편집기와 WebSocket으로 연결 | 여러 AI 도구에서 공통 사용 | 로컬 실행 필요 |

A 방식을 추천합니다. AI에게 넘길 도구 정의 예시는 다음과 같습니다.

```json
[
  {
    "name": "get_document",
    "description": "현재 PDF 편집 문서의 페이지와 요소 목록을 가져온다. 단위 pt, 위치는 요소 중심.",
    "input_schema": { "type": "object", "properties": {} }
  },
  {
    "name": "add_text",
    "description": "페이지에 텍스트 상자를 추가한다.",
    "input_schema": {
      "type": "object",
      "properties": {
        "pageIndex": { "type": "integer" },
        "text": { "type": "string" },
        "cx": { "type": "number" }, "cy": { "type": "number" }, "w": { "type": "number" },
        "fontSize": { "type": "number" }, "color": { "type": "string" }, "bold": { "type": "boolean" }
      },
      "required": ["text"]
    }
  }
]
```

도구 이름과 `PDFEditor` 함수를 1:1로 연결하면 됩니다. 문서 구조(`getDocument()`)가 작은 JSON이므로 AI가 페이지 상태를 읽고 판단하기 쉽습니다.
