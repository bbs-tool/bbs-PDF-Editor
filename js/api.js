// 외부 연결용 API: window.PDFEditor
// 개인 AI(도구 호출, 브라우저 확장, 콘솔 스크립트 등)는 이 API로 편집기를 조작한다.
// 화면 버튼과 똑같은 명령(commands.js)을 쓰므로 실행 취소 기록에도 그대로 남는다.
// 자세한 사용법은 docs/EXTENSION.md 참고.

import * as cmd from './commands.js';
import { on, PT_PER_MM } from './state.js';
import { listFonts } from './fonts.js';
import { getSelectedIds, selectIds } from './canvas.js';
import { listTemplates, deleteTemplate } from './templates.js';

export const API_VERSION = '1.0.0';

export function createApi() {
  return Object.freeze({
    version: API_VERSION,
    units: { ptPerMm: PT_PER_MM }, // 모든 좌표·크기는 pt (1mm = 2.835pt), 기준점은 요소 중심

    // 읽기
    getDocument: cmd.getDocument,
    listFonts,
    getSelection: getSelectedIds,
    on, // on('change', fn) → 해제 함수 반환

    // 페이지
    openFiles: cmd.openFiles,
    goToPage: cmd.goToPage,
    addBlankPage: cmd.addBlankPage,
    duplicatePage: cmd.duplicatePage,
    deletePage: cmd.deletePage,
    deletePages: cmd.deletePages, // (indexes)
    rotatePage: cmd.rotatePage,
    movePage: cmd.movePage,
    setPageSettings: cmd.setPageSettings,

    // 요소
    addText: cmd.addText,
    addShape: cmd.addShape,
    addBlur: cmd.addBlur, // ({ shape: 'rect'|'ellipse', mode: 'mosaic'|'blur', strength: 10~100, cx, cy, w, h })
    insertImages: cmd.insertImages,
    updateObject: cmd.updateObject,
    updateObjects: cmd.updateObjects,
    deleteObjects: cmd.deleteObjects,
    moveObjectsToPage: cmd.moveObjectsToPage, // (ids, pageIndex) 현재 페이지 요소를 다른 페이지로
    arrange: cmd.arrange,
    select: selectIds,

    // 템플릿
    listTemplates,
    saveTemplate: cmd.saveTemplate, // (name, pageIndex?) → id
    applyTemplate: cmd.applyTemplate, // (id, { indexes, settings }) → 적용한 페이지 수
    deleteTemplate,

    // 기록·저장
    undo: cmd.undo,
    redo: cmd.redo,
    exportPdf: cmd.exportDocument, // Promise<Uint8Array>
    exportImages: cmd.exportImages, // ({ indexes, format: 'png'|'jpg', dpi }) → [{ pageIndex, bytes, width, height }]
    cropObject: cmd.cropObject, // (id, { crop: { l, t, r, b }, cx, cy, w, h })
    resetCrop: cmd.resetCrop,
  });
}
