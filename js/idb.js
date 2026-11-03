// IndexedDB: 사용자가 추가한 폰트, PC에서 불러온 시스템 폰트, 자주 쓰는 템플릿을 브라우저에 보관

const DB_NAME = 'pdf-editor';
const STORES = ['userFonts', 'systemFonts', 'templates'];
let dbPromise = null;

function request(version) {
  return new Promise((resolve, reject) => {
    const req = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
    req.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // 다른 탭이 저장소를 추가하려 하면 연결을 닫아 막지 않는다
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('편집기가 열린 다른 탭을 닫은 뒤 새로고침해 주세요'));
  });
}

// 이전 버전 편집기가 만든 DB에 없는 저장소가 있으면 버전을 올려 추가한다
function open() {
  dbPromise ||= request().then(db => {
    if (STORES.every(name => db.objectStoreNames.contains(name))) return db;
    const next = db.version + 1;
    db.close();
    return request(next);
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const idbGet = (store, key) => run(store, 'readonly', s => s.get(key));
export const idbPut = (store, key, value) => run(store, 'readwrite', s => s.put(value, key));
export const idbDelete = (store, key) => run(store, 'readwrite', s => s.delete(key));
export const idbAll = store => run(store, 'readonly', s => s.getAll());
