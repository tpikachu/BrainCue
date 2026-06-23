import { Badge, Card, Page } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { RELEASES, APP_VERSION } from '../changelog';

/** "What's New" — renders the repo's changelog/*.md release notes in-app, newest
 *  first. Content comes from changelog.ts (build-time glob of changelog/*.md), so
 *  this view never drifts from the source-of-truth changelog files. */
export default function WhatsNewPage() {
  return (
    <Page
      title="What's New"
      subtitle="Release notes for AI Interview Assistant"
      actions={<Badge tone="blue">v{APP_VERSION}</Badge>}
    >
      {RELEASES.length === 0 ? (
        <Card>
          <p className="text-sm text-neutral-400">No release notes yet.</p>
        </Card>
      ) : (
        <div className="space-y-5">
          {RELEASES.map((r, i) => (
            <Card key={r.version}>
              {i === 0 && (
                <div className="mb-3">
                  <Badge tone="green">Latest</Badge>
                </div>
              )}
              <Markdown>{r.body}</Markdown>
            </Card>
          ))}
        </div>
      )}
    </Page>
  );
}
