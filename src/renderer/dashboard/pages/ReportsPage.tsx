import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import type { PracticeStats, SessionListItem } from '@shared/types';
import { durationMs, fmtHours } from '../../lib/format';
import { Card, Page } from '../../components/ui';
import { useProfileStore } from '../../store/useProfileStore';

/** Insights: the aggregate view — practice progress and overall usage. The
 *  per-session history (and its coaching reports) lives on the Sessions page. */
export default function ReportsPage() {
  const profileId = useProfileStore((s) => s.activeId);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [practice, setPractice] = useState<PracticeStats | null>(null);
  const [loading, setLoading] = useState(true);

  // Insights are a view of the ACTIVE profile. They used to aggregate every
  // profile in the database, so the practice averages described nobody.
  useEffect(() => {
    void (async () => {
      if (!profileId) {
        setSessions([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        setSessions((await api.session.list(profileId)) as SessionListItem[]);
        setPractice((await api.session.practiceStats(profileId)) as PracticeStats);
      } finally {
        setLoading(false);
      }
    })();
  }, [profileId]);

  const totalMs = useMemo(() => sessions.reduce((n, s) => n + durationMs(s), 0), [sessions]);
  const liveCount = sessions.filter((s) => s.kind === 'live').length;
  const practiceCount = sessions.length - liveCount;

  return (
    <Page title="Insights" subtitle="How it's going — practice progress and overall usage.">
      {!loading && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Sessions" value={String(sessions.length)} />
          <Stat label="Live" value={String(liveCount)} />
          <Stat label="Practice" value={String(practiceCount)} />
          <Stat label="Time in session" value={fmtHours(totalMs)} />
        </div>
      )}

      {practice && practice.answers > 0 ? (
        <PracticeCard stats={practice} />
      ) : (
        !loading && (
          <Card>
            <p className="text-sm text-neutral-400">
              No coached practice yet — run a{' '}
              <Link to="/sparring" className="text-indigo-300 underline hover:text-indigo-200">
                Sparring drill
              </Link>{' '}
              and your per-competency progress shows up here.
            </p>
          </Card>
        )
      )}

      <p className="mt-6 text-sm text-neutral-500">
        Looking for a specific session's report? They live in{' '}
        <Link to="/sessions" className="text-indigo-300 underline hover:text-indigo-200">
          Sessions
        </Link>
        .
      </p>
    </Page>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="!py-4">
      <div className="text-2xl font-semibold tracking-tight text-neutral-100">{value}</div>
      <div className="mt-0.5 text-xs uppercase tracking-wide text-neutral-500">{label}</div>
    </Card>
  );
}

/** The Practice Loop summary: overall average, a per-drill trend, and the
 *  per-competency averages — all from persisted sparring coaching. Single-hue
 *  magnitude visuals (indigo accent on the app surface); values are shown as
 *  text so nothing depends on color alone. */
function PracticeCard({ stats }: { stats: PracticeStats }) {
  const trend = stats.recent;
  // Fixed, honest 0–5 domain for both the sparkline and the bar lengths.
  const W = 220;
  const H = 48;
  const PAD = 6;
  const x = (i: number) => (trend.length === 1 ? W / 2 : PAD + (i * (W - PAD * 2)) / (trend.length - 1));
  const y = (v: number) => H - PAD - ((v / 5) * (H - PAD * 2));
  const points = trend.map((d, i) => `${x(i).toFixed(1)},${y(d.avgRating).toFixed(1)}`).join(' ');

  return (
    <Card className="mb-5">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <h3 className="font-medium text-neutral-100">Practice</h3>
          <p className="mt-0.5 text-xs text-neutral-500">
            {stats.sessions} drill{stats.sessions === 1 ? '' : 's'} · {stats.answers} answer
            {stats.answers === 1 ? '' : 's'} coached
          </p>
          <p className="mt-3 text-3xl font-semibold tracking-tight text-neutral-100">
            {stats.avgRating.toFixed(1)}
            <span className="ml-1 text-base font-normal text-neutral-500">/ 5 average</span>
          </p>
          {trend.length > 1 && (
            <div className="mt-3">
              <p className="mb-1 text-[11px] uppercase tracking-wide text-neutral-500">
                Per-drill average
              </p>
              <svg width={W} height={H} role="img" aria-label="Average rating per practice drill">
                <polyline
                  points={points}
                  fill="none"
                  stroke="#818cf8"
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {trend.map((d, i) => (
                  <circle key={d.sessionId} cx={x(i)} cy={y(d.avgRating)} r="3" fill="#818cf8">
                    <title>
                      {new Date(d.createdAt).toLocaleDateString()} — {d.avgRating.toFixed(1)}/5 (
                      {d.answers} answer{d.answers === 1 ? '' : 's'})
                    </title>
                  </circle>
                ))}
              </svg>
            </div>
          )}
        </div>

        {stats.byCompetency.length > 0 && (
          <div className="min-w-[16rem] flex-1">
            <p className="mb-2 text-[11px] uppercase tracking-wide text-neutral-500">
              By competency
            </p>
            <ul className="space-y-1.5">
              {stats.byCompetency.slice(0, 6).map((c) => (
                <li key={c.competency} className="flex items-center gap-2 text-xs">
                  <span className="w-32 shrink-0 truncate text-neutral-300">
                    {c.competency.replace(/_/g, ' ')}
                  </span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-800">
                    <span
                      className="block h-full rounded-full bg-indigo-400"
                      style={{ width: `${(c.avgRating / 5) * 100}%` }}
                    />
                  </span>
                  <span className="w-14 shrink-0 text-right tabular-nums text-neutral-300">
                    {c.avgRating.toFixed(1)}
                    <span className="text-neutral-600"> ×{c.count}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
