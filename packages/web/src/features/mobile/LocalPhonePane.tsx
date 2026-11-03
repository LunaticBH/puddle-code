import { useEffect, useState } from 'react';
import type { Session } from '@puddle/shared';
import { wsManager } from '../../lib/transport/ws';
import { useKeepAliveSlot } from '../workspace/keep-alive';
import { Composer } from './Composer';
import { PhoneReview } from './PhoneReview';
import '../remote/remote.css';

/** Adopts the existing terminal DOM; resizing back to desktop never recreates xterm. */
export function LocalPhonePane({
  sessions,
  selected,
  select,
}: {
  sessions: Session[];
  selected: string | null;
  select(id: string): void;
}) {
  const [review, setReview] = useState(false);
  const [connected, setConnected] = useState(wsManager.isConnected());
  const slot = useKeepAliveSlot(selected && !review ? `term:${selected}` : null);
  useEffect(() => wsManager.onConnectionChange(setConnected), []);
  return (
    <div className="phone-workspace">
      <nav className="phone-selectors">
        <select
          aria-label="Session"
          value={selected ?? ''}
          onChange={(event) => select(event.target.value)}
        >
          <option value="">Choose session</option>
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {session.title ?? session.agent_title ?? session.osc_title ?? session.id.slice(0, 8)}{' '}
              · {session.status}
            </option>
          ))}
        </select>
        <button onClick={() => setReview(!review)}>{review ? 'Terminal' : 'Review'}</button>
      </nav>
      {!connected && <p role="status">Reconnecting… Your draft will stay here.</p>}
      <div className="phone-view">
        {review && selected ? (
          <PhoneReview key={selected} session={selected} />
        ) : (
          <div ref={slot} className="size-full" />
        )}
      </div>
      {selected && !review && (
        <Composer key={selected} session={selected} term="agent" connected={connected} />
      )}
    </div>
  );
}
