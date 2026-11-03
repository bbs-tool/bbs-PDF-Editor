// 처음 사용 안내: 화면을 어둡게 덮고 버튼을 묶음별로 밝혀 사용법을 보여 준다.
// 한 번 보면 다시 뜨지 않고, 상단 '튜토리얼' 버튼으로 언제든 다시 볼 수 있다.

const SEEN_KEY = 'pdf-editor.tourSeen';

// target: CSS 선택자(여러 개면 묶어서 밝힘). 없거나 화면에 안 보이면 가운데에 안내만 띄운다.
// text: 이 파일에 적은 고정 문구만 넣는다 (HTML 허용: <b>, <em class="em-red">, <ul>)
// extra: 같은 단계에서 따로 띄우는 말풍선 { target, title, text }
const STEPS = [
  {
    title: 'PDF 편집기에 오신 것을 환영합니다',
    text: '주요 기능을 차례로 안내합니다. 파일은 서버로 보내지 않고 이 브라우저 안에서만 처리합니다.',
  },
  {
    target: ['#btnOpen', '#btnInsertImage'], title: '파일 열기 · 이미지 삽입',
    text: `<ul>
      <li><b>파일 열기</b> — PDF나 이미지를 새 페이지로 추가합니다. 여러 파일을 한 번에 고를 수 있고, 화면으로 끌어다 놓아도 됩니다. 아주 긴 파일(5080mm 초과)은 페이지를 나눠서 불러올 수 있습니다.</li>
      <li><b>이미지 삽입</b> — 현재 페이지 위에 올릴지, 새 페이지로 추가할지 골라서 넣습니다. 도장·로고·서명 등에 씁니다. 복사한 이미지는 Ctrl+V로 바로 붙여 넣을 수 있습니다.</li>
    </ul>`,
  },
  {
    target: ['#btnText', '#btnRect', '#btnEllipse', '#btnUndo', '#btnRedo', '.toolbar .zoom'], title: '편집 도구',
    text: `<ul>
      <li><b>텍스트</b> — 상자를 더블클릭해 글자를 고치고, 폰트·크기·색은 오른쪽 패널에서 바꿉니다.</li>
      <li><b>네모·동그라미</b> — 채우기·테두리를 바꿀 수 있고, 흰 네모로 원본 글자를 가릴 때도 씁니다.</li>
      <li><b>↶ ↷</b> — 실행 취소·다시 실행 (Ctrl+Z / Ctrl+Y)</li>
      <li><b>− + 맞춤</b> — 화면 확대·축소. 저장 품질과는 관계없습니다.</li>
    </ul>`,
  },
  {
    target: '#pagesPane', title: '페이지 목록',
    text: '썸네일을 끌어서 순서를 바꿉니다. 각 페이지의 복제·회전·삭제 버튼과 [+ 빈 페이지]도 여기 있습니다. 편집 중인 요소를 다른 페이지 썸네일 위로 끌어다 놓으면 그 페이지로 옮겨집니다.',
  },
  {
    target: '#stage', title: '편집 화면',
    text: '불러온 PDF·이미지와 추가한 요소를 클릭해 선택하고 끌어서 옮깁니다. 모서리로 크기, 위쪽 동그라미로 회전합니다. 선택하면 오른쪽에 위치·투명도·레이어 순서·잠금 메뉴가 나타납니다.',
  },
  {
    target: '#stage', title: '우클릭 메뉴 · 자르기',
    text: 'PDF·이미지를 마우스 <em class="em-red">우클릭</em>하면 [자르기]가 있습니다. 파란 점선 상자를 조절한 뒤 Enter를 누르면 필요한 부분만 남습니다. [자르기 원래대로]로 언제든 되돌릴 수 있습니다.',
  },
  {
    target: ['#pagePanel', '#templatePanel', '#fontPanel'], title: '오른쪽 설정 패널', place: 'end',
    text: `<ul>
      <li><b>페이지 설정</b> — A4·원본 크기·이미지 크기에 맞춤·영역 직접 지정 중에서 규격을 고르고, 원본을 왼쪽/가운데/오른쪽, 위/가운데/아래로 정렬합니다.</li>
      <li><b>자주 쓰는 템플릿</b> — 자주 넣는 텍스트·도형·이미지 배치를 여러 페이지 단위로 저장해 두고 한 번에 불러옵니다.</li>
      <li><b>폰트</b> — Pretendard·맑은 고딕을 기본으로 쓰고, TTF·OTF를 추가할 수 있습니다. 원본 PDF 글자에는 영향이 없습니다.</li>
    </ul>`,
    extra: {
      target: '#pageSizeMode', title: '여백이 필요할 때',
      text: '페이지 여백이 필요할 경우 규격 - <b>영역 직접 지정</b>으로 필요한 영역을 추가해 보세요!',
    },
  },
  {
    target: ['#btnExportImage', '#btnExport'], title: '저장',
    text: '저장되는 파일의 형식을 설정할 수 있습니다. <b>PDF 저장</b>은 원본 화질 그대로, <b>이미지 저장</b>은 PNG·JPG(투명 배경 가능)로 원하는 페이지만 골라 저장합니다.',
  },
  {
    target: '#btnHelp', title: '다시 보기',
    text: '이 안내는 언제든 [튜토리얼] 버튼으로 다시 볼 수 있습니다.',
  },
];

let root = null;
let index = 0;

export function shouldAutoStart() {
  try { return !localStorage.getItem(SEEN_KEY); } catch { return false; }
}

export function startTour() {
  close();
  index = 0;
  root = document.createElement('div');
  root.className = 'tour';
  root.innerHTML = `
    <div class="tour-hole"></div>
    <div class="tour-ring" hidden></div>
    <div class="tour-bubble tour-extra" hidden><h4 class="tour-title"></h4><p class="tour-text"></p></div>
    <div class="tour-bubble tour-main" role="dialog" aria-live="polite">
      <div class="tour-step muted"></div>
      <h4 class="tour-title"></h4>
      <div class="tour-text"></div>
      <div class="tour-actions">
        <button class="tour-skip small">건너뛰기</button>
        <span class="spacer"></span>
        <button class="tour-prev small">이전</button>
        <button class="tour-next small primary">다음</button>
      </div>
    </div>`;
  document.body.append(root);
  root.querySelector('.tour-skip').onclick = close;
  root.querySelector('.tour-prev').onclick = () => go(index - 1);
  root.querySelector('.tour-next').onclick = () => (index === STEPS.length - 1 ? close() : go(index + 1));
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  go(0);
}

function close() {
  if (!root) return;
  root.remove();
  root = null;
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', place);
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* 저장 못 해도 안내는 동작 */ }
}

function onKey(e) {
  const next = () => root.querySelector('.tour-next').click();
  const keys = { Escape: close, ArrowRight: next, Enter: next, ArrowLeft: () => index > 0 && go(index - 1) };
  if (!keys[e.key]) return;
  e.preventDefault();
  e.stopPropagation(); // 편집기 단축키(Delete, 화살표 이동 등)가 함께 동작하지 않게
  keys[e.key]();
}

function targets(target) {
  return [target || []].flat()
    .map(sel => document.querySelector(sel))
    .filter(el => el && el.offsetParent !== null);
}

function go(i) {
  index = Math.max(0, Math.min(i, STEPS.length - 1));
  const step = STEPS[index];
  targets(step.extra?.target || step.target)[0]?.scrollIntoView({ block: 'nearest' });
  const main = root.querySelector('.tour-main');
  main.querySelector('.tour-step').textContent = `${index + 1} / ${STEPS.length}`;
  main.querySelector('.tour-title').textContent = step.title;
  main.querySelector('.tour-text').innerHTML = step.text;
  main.querySelector('.tour-prev').disabled = index === 0;
  main.querySelector('.tour-next').textContent = index === STEPS.length - 1 ? '시작하기' : '다음';
  const extra = root.querySelector('.tour-extra');
  extra.hidden = !step.extra;
  if (step.extra) {
    extra.querySelector('.tour-title').textContent = step.extra.title;
    extra.querySelector('.tour-text').innerHTML = step.extra.text;
  }
  place();
  main.querySelector('.tour-next').focus();
}

/** 여러 요소를 감싸는 사각형 (화면 밖은 잘라냄) */
function boundsOf(els, pad) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rects = els.map(el => el.getBoundingClientRect());
  return {
    left: Math.max(4, Math.min(...rects.map(x => x.left)) - pad),
    top: Math.max(4, Math.min(...rects.map(x => x.top)) - pad),
    right: Math.min(vw - 4, Math.max(...rects.map(x => x.right)) + pad),
    bottom: Math.min(vh - 4, Math.max(...rects.map(x => x.bottom)) + pad),
  };
}

const boxStyle = r => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` });

/**
 * 말풍선을 대상 옆 빈자리에 놓는다 (아래 → 위 → 왼쪽 → 오른쪽 순).
 * end: 왼쪽·오른쪽에 놓을 때 대상의 아래쪽 끝에 맞춘다 (위쪽은 다른 말풍선 자리)
 * leftFirst: 왼쪽 자리를 먼저 본다 (오른쪽 패널 안의 대상을 가리지 않게)
 */
function placeBubble(bubble, r, end = false, leftFirst = false) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;
  const gap = 12;
  const clampX = x => Math.max(8, Math.min(x, vw - bw - 8));
  const clampY = y => Math.max(8, Math.min(y, vh - bh - 8));
  const sideY = end ? clampY(r.bottom - bh) : clampY(r.top);
  let left;
  let top;
  if (leftFirst && r.left - gap - bw > 0) { left = r.left - gap - bw; top = sideY; }
  else if (r.bottom + gap + bh < vh) { left = clampX(r.left); top = r.bottom + gap; }
  else if (r.top - gap - bh > 0) { left = clampX(r.left); top = r.top - gap - bh; }
  else if (r.left - gap - bw > 0) { left = r.left - gap - bw; top = sideY; }
  else if (r.right + gap + bw < vw) { left = r.right + gap; top = sideY; }
  else { left = (vw - bw) / 2; top = (vh - bh) / 2; }
  Object.assign(bubble.style, { left: `${left}px`, top: `${top}px` });
}

function place() {
  if (!root) return;
  const step = STEPS[index];
  const hole = root.querySelector('.tour-hole');
  const ring = root.querySelector('.tour-ring');
  const main = root.querySelector('.tour-main');
  const extra = root.querySelector('.tour-extra');
  const els = targets(step.target);

  if (!els.length) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    Object.assign(hole.style, { left: `${vw / 2}px`, top: `${vh / 2}px`, width: '0px', height: '0px' });
    Object.assign(main.style, { left: `${(vw - main.offsetWidth) / 2}px`, top: `${(vh - main.offsetHeight) / 2}px` });
  } else {
    const r = boundsOf(els, 6);
    Object.assign(hole.style, boxStyle(r));
    placeBubble(main, r, step.place === 'end');
  }

  const extraEls = step.extra ? targets(step.extra.target) : [];
  ring.hidden = !extraEls.length;
  if (extraEls.length) {
    const r = boundsOf(extraEls, 4);
    Object.assign(ring.style, boxStyle(r));
    placeBubble(extra, r, false, true);
  }
}
