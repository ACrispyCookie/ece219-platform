import { download, id, labPath } from './api';
import { Empty, LoadState, More, fileSize, greekDate, usePaged } from './ui';
import { FilePreviewButton } from './FilePreview';
import type { StoredFile } from './types';
import Removal from './Removal';

export default function Uploads({
  labId,
  onRemoved,
}: {
  labId: string;
  onRemoved: (fileId: string) => void;
}) {
  const path = `${labPath(labId)}/files`;
  const list = usePaged<StoredFile>(path);
  return (
    <section className="uploads-section">
      <div className="section-heading">
        <div>
          <h2>Ανεβασμένα αρχεία</h2>
          <p className="muted small">
            Διαχείριση εκδόσεων ανεβασμάτων, μαζί με όσα δεν έχουν συνδεθεί ακόμη. Η διαγραφή
            αφαιρεί τις επιβεβαιωμένες συσχετίσεις και μεταδεδομένα, όχι τα κοινόχρηστα αποθηκευμένα
            bytes.
          </p>
        </div>
      </div>
      <LoadState {...list} retry={list.reload}>
        {!list.items.length ? (
          <Empty>Δεν υπάρχουν ανεβασμένα αρχεία.</Empty>
        ) : (
          <ul className="uploads-list">
            {list.items.map((file) => (
              <li key={file.id}>
                <div className="upload-info">
                  <strong>{file.filename}</strong>
                  <span className="small muted">
                    {fileSize(file.size)} · {greekDate(file.created_at)}
                  </span>
                </div>
                <div className="actions item-actions">
                  <FilePreviewButton
                    filename={file.filename}
                    url={download(file.id)}
                    size={file.size}
                  />
                  <a className="button" href={download(file.id)} download>
                    Λήψη
                  </a>
                  <Removal
                    path={`${path}/${id(file.id)}`}
                    readPath={`/files/${id(file.id)}`}
                    title={file.filename}
                    kind="αρχείου"
                    onRemoved={() => {
                      list.reload();
                      onRemoved(file.id);
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
        <More count={list.items.length} total={list.total} busy={list.busy} onMore={list.more} />
        {list.moreError && <p role="alert">{list.moreError.message}</p>}
      </LoadState>
    </section>
  );
}
