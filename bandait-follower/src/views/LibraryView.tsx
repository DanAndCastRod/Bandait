import { useEffect, useState } from "react";
import { getAllSetlists, StoredSetlist } from "../db/indexedDb";

interface Props {
  onSelectSetlist: (id: string) => void;
  onBack: () => void;
}

export default function LibraryView({ onSelectSetlist, onBack }: Props) {
  const [setlists, setSetlists] = useState<StoredSetlist[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAllSetlists()
      .then((items) => {
        setSetlists(items);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="library-view">
      <div className="library-header">
        <button className="btn-back" onClick={onBack}>← Back</button>
        <h1 className="library-title">Library</h1>
      </div>

      {loading && <div className="library-loading">Loading...</div>}

      {!loading && setlists.length === 0 && (
        <div className="library-empty">
          <p>No setlists cached offline.</p>
          <p className="library-hint">
            Connect to a leader to download setlists.
          </p>
        </div>
      )}

      <div className="setlist-grid">
        {setlists.map((sl) => (
          <div
            key={sl.id}
            className="setlist-card"
            onClick={() => onSelectSetlist(sl.id)}
          >
            <div className="setlist-name">{sl.name}</div>
            <div className="setlist-meta">{sl.songs.length} songs</div>
          </div>
        ))}
      </div>
    </div>
  );
}
