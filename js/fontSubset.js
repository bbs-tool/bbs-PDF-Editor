// HarfBuzz(hb-subset.wasm)로 실제로 쓴 글자만 남긴 작은 폰트를 만든다.
// pdf-lib 자체의 subset 기능은 한글 글자가 빠지는 버그가 있어 쓰지 않는다.

let hbPromise = null;

function loadHarfBuzz() {
  hbPromise ||= fetch('vendor/hb-subset.wasm')
    .then(res => res.arrayBuffer())
    .then(buf => WebAssembly.instantiate(buf))
    .then(({ instance }) => instance.exports);
  hbPromise.catch(() => { hbPromise = null; });
  return hbPromise;
}

/** fontBytes 중 text에 들어 있는 글자(와 그 대체 글자)만 남긴 TTF/OTF 바이트 */
export async function subsetFont(fontBytes, text) {
  const hb = await loadHarfBuzz();
  const src = new Uint8Array(fontBytes);
  const ptr = hb.malloc(src.byteLength);
  new Uint8Array(hb.memory.buffer).set(src, ptr);
  const blob = hb.hb_blob_create(ptr, src.byteLength, 2 /* HB_MEMORY_MODE_WRITABLE */, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  hb.hb_blob_destroy(blob);

  const input = hb.hb_subset_input_create_or_fail();
  const unicodes = hb.hb_subset_input_unicode_set(input);
  for (const ch of new Set(text)) hb.hb_set_add(unicodes, ch.codePointAt(0));
  const subset = hb.hb_subset_or_fail(face, input);
  hb.hb_subset_input_destroy(input);

  try {
    if (!subset) throw new Error('폰트를 줄이지 못했습니다');
    const result = hb.hb_face_reference_blob(subset);
    const offset = hb.hb_blob_get_data(result, 0);
    const length = hb.hb_blob_get_length(result);
    // 작업 중 메모리가 늘었을 수 있어 버퍼를 새로 잡는다
    const bytes = new Uint8Array(hb.memory.buffer).slice(offset, offset + length);
    hb.hb_blob_destroy(result);
    hb.hb_face_destroy(subset);
    if (!length) throw new Error('폰트를 줄이지 못했습니다');
    return bytes;
  } finally {
    hb.hb_face_destroy(face);
    hb.free(ptr);
  }
}
