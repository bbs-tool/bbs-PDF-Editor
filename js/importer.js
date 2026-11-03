// 파일 가져오기: PDF → 페이지마다 원본 요소, 이미지 → 이미지 요소

import { assets, uid, PX_TO_PT } from './state.js';
import { getPdfDocument } from './pdfRender.js';

export const ACCEPT_FILES = 'application/pdf,.pdf,image/png,image/jpeg,image/webp,image/gif,image/bmp';
export const ACCEPT_IMAGES = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';

export const isPdf = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
export const isImage = f => /^image\/(png|jpeg|webp|gif|bmp)$/.test(f.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name || '');

export function baseElement(props) {
  // 원본도 처음부터 끌어서 옮길 수 있다. 고정하려면 속성 패널·우클릭 메뉴에서 잠근다.
  return { id: uid(), cx: 0, cy: 0, w: props.natW, h: props.natH, angle: 0, opacity: 1, locked: false, ...props };
}

/** PDF 파일 → 페이지별 원본 요소 목록 */
export async function importPdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const assetId = uid('a');
  const asset = { kind: 'pdf', name: file.name, bytes };
  assets.set(assetId, asset);
  try {
    // 저장 단계(pdf-lib)에서 열 수 없는 PDF는 미리 걸러낸다
    asset.libDoc = await window.PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
    const pdf = await getPdfDocument(assetId);
    const items = [];
    for (let i = 0; i < pdf.numPages; i++) {
      const page = await pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      items.push(baseElement({ type: 'pdfpage', assetId, pageIndex: i, natW: vp.width, natH: vp.height }));
    }
    return items;
  } catch (e) {
    assets.delete(assetId);
    if (/encrypt/i.test(e.message) || e.name === 'PasswordException') {
      throw new Error(`${file.name}: 암호가 걸린 PDF는 편집할 수 없습니다. 암호를 해제한 뒤 다시 열어 주세요.`);
    }
    if (/Cannot load script|Failed to fetch|NetworkError/i.test(e.message)) {
      throw new Error(`${file.name}: 편집기 파일을 불러오지 못했습니다. run-local.bat 검은 창이 닫혔다면 다시 실행한 뒤 새로고침해 주세요.`);
    }
    throw new Error(`${file.name}: PDF를 열 수 없습니다 (${e.message})`);
  }
}

/** 이미지 파일 → 에셋 등록. PNG/JPEG는 원본 그대로, 그 외 형식과 회전 정보가 있는 JPEG는 PNG로 변환 */
export async function importImageAsset(blob) {
  let bytes = new Uint8Array(await blob.arrayBuffer());
  let mime = sniffMime(bytes);
  if (!mime || (mime === 'image/jpeg' && jpegOrientation(bytes) > 1)) {
    bytes = await reencodePng(blob);
    mime = 'image/png';
  }
  const el = await loadImage(new Blob([bytes], { type: mime }));
  const assetId = uid('a');
  assets.set(assetId, { kind: 'image', name: blob.name || 'image', bytes, mime, el });
  return { assetId, natW: el.naturalWidth * PX_TO_PT, natH: el.naturalHeight * PX_TO_PT };
}

export async function importImage(file) {
  try {
    const a = await importImageAsset(file);
    return [baseElement({ type: 'image', ...a })];
  } catch (e) {
    throw new Error(`${file.name}: 이미지를 열 수 없습니다`);
  }
}

function sniffMime(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  return null;
}

function loadImage(blob) {
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  return img.decode().then(() => img);
}

async function reencodePng(blob) {
  const img = await loadImage(blob); // 브라우저가 EXIF 회전을 적용해서 그린다
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  URL.revokeObjectURL(img.src);
  const png = await new Promise(r => c.toBlob(r, 'image/png'));
  return new Uint8Array(await png.arrayBuffer());
}

// JPEG EXIF의 Orientation 값 (1 = 회전 없음)
function jpegOrientation(bytes) {
  try {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 2;
    while (off + 10 < v.byteLength) {
      const marker = v.getUint16(off);
      if ((marker & 0xff00) !== 0xff00) break;
      const len = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) {
        const tiff = off + 10;
        const little = v.getUint16(tiff) === 0x4949;
        const ifd = tiff + v.getUint32(tiff + 4, little);
        const count = v.getUint16(ifd, little);
        for (let i = 0; i < count; i++) {
          const entry = ifd + 2 + i * 12;
          if (v.getUint16(entry, little) === 0x0112) return v.getUint16(entry + 8, little);
        }
        return 1;
      }
      off += 2 + len;
    }
  } catch { /* 손상된 EXIF는 무시 */ }
  return 1;
}
