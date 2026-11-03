# 외부 라이브러리

CDN 변경에 영향을 받지 않도록 npm 배포본을 그대로 복사해 버전을 고정했습니다. 직접 수정하지 마세요.

| 파일 | 라이브러리 | 버전 | 라이선스 |
|---|---|---|---|
| pdfjs/pdf.min.js, pdfjs/pdf.worker.min.js, pdfjs/cmaps/, pdfjs/standard_fonts/ | pdf.js (pdfjs-dist) | 3.11.174 | Apache-2.0 |
| pdf-lib.min.js | pdf-lib | 1.17.1 | MIT |
| fontkit.umd.min.js | @pdf-lib/fontkit | 1.1.1 | MIT |
| fabric.min.js | Fabric.js | 5.3.0 | MIT |
| Sortable.min.js | SortableJS | 1.15.2 | MIT |
| hb-subset.wasm | harfbuzzjs (HarfBuzz) | 0.4.2 | MIT / Old MIT |

`js/exporter.js`의 `trackGlyphWidths`는 pdf-lib 1.17.1의 내부 구조에 맞춰 작성되었습니다. pdf-lib 버전을 바꾸면 이 부분을 다시 확인해야 합니다.
