import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { MeetingReport, SessionListItem } from '@shared/types';
import { Button, Modal, Spinner, TextInput } from '../components/ui';
import { Markdown } from '../components/Markdown';

/** Render the structured report as the markdown body persisted on the
 *  contribution — mirrors main's renderMeetingReport so edits keep the stored
 *  body and meta consistent. */
function renderReportMarkdown(r: MeetingReport): string {
  const lines: string[] = [r.summary.trim()];
  if (r.decisions.length) {
    lines.push('', '## Decisions');
    for (const d of r.decisions) lines.push(`- ${d.text}${d.owner ? ` — ${d.owner}` : ''}`);
  }
  if (r.actionItems.length) {
    lines.push('', '## Action items');
    for (const a of r.actionItems) {
      const extra = [a.owner, a.deadline].filter(Boolean).join(' · ');
      lines.push(`- ${a.text}${extra ? ` — ${extra}` : ''}`);
    }
  }
  if (r.openQuestions.length) {
    lines.push('', '## Open questions');
    for (const q of r.openQuestions) lines.push(`- ${q}`);
  }
  return lines.join('\n');
}

/** The end-of-meeting report: summary, decisions, action items, and open
 *  questions — with the action items and open questions editable in place
 *  (edits update the persisted report contribution). Owners/deadlines shown
 *  only when the transcript stated them; blank means "not said". */
export function MeetingReportModal(props: {
  session: SessionListItem | null;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contributionId, setContributionId] = useState<string | null>(null);
  const [report, setReport] = useState<MeetingReport | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!props.session) return;
    setLoading(true);
    setError(null);
    setReport(null);
    setDirty(false);
    void api.session
      .meetingReport(props.session.id)
      .then((r) => {
        setContributionId(r.contributionId);
        setReport(r.report);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [props.session]);

  const patch = (next: MeetingReport) => {
    setReport(next);
    setDirty(true);
  };

  const save = async () => {
    if (!report || !contributionId) return;
    setSaving(true);
    try {
      await api.contributions.update(contributionId, {
        body: renderReportMarkdown(report),
        meta: { reportType: 'meeting', report },
      });
      setDirty(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!props.session}
      onClose={props.onClose}
      title={
        props.session
          ? `Meeting report · ${props.session.jobCompany || props.session.jobTitle || 'General'}`
          : 'Meeting report'
      }
    >
      {loading ? (
        <div className="flex items-center gap-2 py-6 text-neutral-400">
          <Spinner className="h-4 w-4" /> Generating report…
        </div>
      ) : error ? (
        <p className="text-sm text-red-300">{error}</p>
      ) : report ? (
        <div className="space-y-5 text-sm">
          <Markdown>{report.summary}</Markdown>

          {report.decisions.length > 0 && (
            <div>
              <p className="mb-1.5 font-medium text-fuchsia-300">Decisions</p>
              <ul className="list-disc space-y-0.5 pl-5 text-neutral-300">
                {report.decisions.map((d, i) => (
                  <li key={i}>
                    {d.text}
                    {d.owner && <span className="text-neutral-500"> — {d.owner}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <p className="mb-1.5 font-medium text-emerald-300">Action items</p>
            {report.actionItems.length === 0 ? (
              <p className="text-neutral-500">None captured.</p>
            ) : (
              <ul className="space-y-2">
                {report.actionItems.map((a, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <TextInput
                      value={a.text}
                      aria-label={`Action item ${i + 1}`}
                      onChange={(e) =>
                        patch({
                          ...report,
                          actionItems: report.actionItems.map((x, j) =>
                            j === i ? { ...x, text: e.target.value } : x,
                          ),
                        })
                      }
                    />
                    <span className="shrink-0 text-xs text-neutral-500">
                      {[a.owner, a.deadline].filter(Boolean).join(' · ') || '—'}
                    </span>
                    <button
                      onClick={() =>
                        patch({
                          ...report,
                          actionItems: report.actionItems.filter((_, j) => j !== i),
                        })
                      }
                      className="shrink-0 text-neutral-600 hover:text-red-300"
                      aria-label={`Remove action item ${i + 1}`}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <p className="mb-1.5 font-medium text-violet-300">Open questions</p>
            {report.openQuestions.length === 0 ? (
              <p className="text-neutral-500">None left unanswered.</p>
            ) : (
              <ul className="space-y-2">
                {report.openQuestions.map((q, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <TextInput
                      value={q}
                      aria-label={`Open question ${i + 1}`}
                      onChange={(e) =>
                        patch({
                          ...report,
                          openQuestions: report.openQuestions.map((x, j) =>
                            j === i ? e.target.value : x,
                          ),
                        })
                      }
                    />
                    <button
                      onClick={() =>
                        patch({
                          ...report,
                          openQuestions: report.openQuestions.filter((_, j) => j !== i),
                        })
                      }
                      className="shrink-0 text-neutral-600 hover:text-red-300"
                      aria-label={`Remove open question ${i + 1}`}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {dirty && (
            <div className="flex justify-end">
              <Button variant="primary" loading={saving} onClick={() => void save()}>
                Save changes
              </Button>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-neutral-500">No report available.</p>
      )}
    </Modal>
  );
}
