// ============ 分片临时存储：IndexedDB（F-302 规则 2 / F-305 续传）============
// 后台 SW 写入分片，offscreen 读取合并；同源共享。任务结束/清理时删除。
const DB_NAME = 'ms-segments';
const STORE = 'seg';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function segKey(taskId: string, index: number): string {
  return `${taskId}#${String(index).padStart(8, '0')}`; // 补零对齐，字典序即顺序
}

export async function putSegment(taskId: string, index: number, data: ArrayBuffer): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(data, segKey(taskId, index));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getSegment(taskId: string, index: number): Promise<ArrayBuffer | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(segKey(taskId, index));
    req.onsuccess = () => resolve(req.result as ArrayBuffer | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteTaskSegments(taskId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const range = IDBKeyRange.bound(`${taskId}#`, `${taskId}#\uffff`);
    tx.objectStore(STORE).delete(range);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** E-013 / 6.5：启动时孤儿清理——扫描无对应任务的残留分片 */
export async function cleanupOrphans(aliveTaskIds: Set<string>): Promise<number> {
  const db = await openDb();
  const orphans: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).openKeyCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      const taskId = String(cur.key).split('#')[0]!;
      if (!aliveTaskIds.has(taskId)) orphans.push(String(cur.key));
      cur.continue();
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
  });
  if (!orphans.length) return 0;
  const tx2 = db.transaction(STORE, 'readwrite');
  const store = tx2.objectStore(STORE);
  for (const k of orphans) store.delete(k);
  return new Promise((resolve, reject) => {
    tx2.oncomplete = () => resolve(orphans.length);
    tx2.onerror = () => reject(tx2.error);
  });
}
