import type { ClientInfo } from '@shared/ipc';
import { noDrag } from '../lib/style';

/** Client notes (toggled by the header's ⓘ button). */
export function ClientNotesPanel({ clientInfo }: { clientInfo: ClientInfo }) {
  return (
    <div
      className="mb-2 max-h-32 overflow-auto rounded-lg border border-neutral-700 bg-neutral-950/80 p-2 text-[11px]"
      style={noDrag}
    >
      <div className="mb-1 font-semibold text-neutral-200">
        {clientInfo.company || clientInfo.title || 'Client'}
        {clientInfo.company && clientInfo.title ? ` · ${clientInfo.title}` : ''}
      </div>
      {clientInfo.notes ? (
        <p className="whitespace-pre-wrap leading-relaxed text-neutral-300">{clientInfo.notes}</p>
      ) : (
        <p className="text-neutral-500">No notes saved for this client.</p>
      )}
    </div>
  );
}
