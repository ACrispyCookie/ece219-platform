import { api, download, id, json, labPath } from './api';
import { LoadState, useResource } from './ui';
import type { Page, StoredFile } from './types';
export async function uploadFile(labId: string, file: File, teamId?: string) {
  const form = new FormData();
  form.append('file', file);
  if (teamId) form.append('team_id', teamId);
  const saved = await api<StoredFile>(`${labPath(labId)}/files`, { method: 'POST', body: form });
  return api<StoredFile>(`/files/${id(saved.id)}`);
}
export async function findSaved<T extends { id: string }>(path: string, target: string) {
  for (let offset = 0; ;) {
    const page = await api<Page<T>>(
      `${path}${path.includes('?') ? '&' : '?'}limit=200&offset=${offset}`,
    );
    const item = page.items.find((x) => x.id === target);
    if (item) return item;
    offset += page.items.length;
    if (!page.items.length || offset >= page.total)
      throw new Error(
        'Η αποθήκευση δεν επιβεβαιώθηκε από τον διακομιστή. Ανανεώστε πριν δοκιμάσετε ξανά.',
      );
  }
}
export async function removeConfirmed(path: string, collection: string, target: string) {
  await api(path, { method: 'DELETE' });
  let offset = 0;
  for (;;) {
    const page = await api<Page<{ id: string }>>(
      `${collection}${collection.includes('?') ? '&' : '?'}limit=200&offset=${offset}`,
    );
    if (page.items.some((x) => x.id === target)) throw new Error('Η διαγραφή δεν επιβεβαιώθηκε.');
    offset += page.items.length;
    if (!page.items.length || offset >= page.total) return;
  }
}
export function FileMetadata({ fileId }: { fileId: string }) {
  const file = useResource<StoredFile>(`/files/${id(fileId)}`);
  return (
    <LoadState {...file} retry={file.reload}>
      {file.value && (
        <div className="file-metadata">
          <a href={download(fileId)} download>
            {file.value.filename}
          </a>
          <div className="small muted">
            {file.value.size} bytes · {file.value.media_type}
          </div>
          <details>
            <summary>Μεταδεδομένα αρχείου</summary>
            <dl>
              <dt>ID</dt>
              <dd>{file.value.id}</dd>
              <dt>SHA-256</dt>
              <dd className="mono">{file.value.sha256}</dd>
              <dt>Αποθηκεύτηκε</dt>
              <dd>{file.value.created_at}</dd>
            </dl>
          </details>
        </div>
      )}
    </LoadState>
  );
}
export function safeURL(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
