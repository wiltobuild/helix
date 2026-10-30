import { FileText, GitCommitHorizontal, GitMerge } from 'lucide-react';
import type { HelixEvent, ProjectState } from '@helix/contracts';
import { ActorBadge, EmptyState, StatusPill } from '@helix/ui';
import { commits, type PlanTree } from '../data/observatory';
import { historicalActorName, identityFor, resolveProjectIdentities } from '../data/identity';
import s from './SessionViews.module.css';

/** Files tab: what each task claims and how much it has changed so far. */
export function FilesView({
  state,
  tree,
  onOpen,
}: {
  state: ProjectState;
  tree: PlanTree | undefined;
  onOpen: (sessionId: string) => void;
}) {
  const identities = resolveProjectIdentities(state);
  const rows = tree
    ? tree.tasks.map((t) => ({
        key: t.node.id,
        name: identities.nodes.get(t.node.id)!.name,
        title: `Task ${t.number} · ${t.node.title}`,
        agent: t.session?.session.agent ?? t.node.agent,
        status: t.status,
        files: t.node.files,
        diff: t.session?.worktree?.diff,
        sessionId: t.session?.session.id,
      }))
    : Object.values(state.sessions)
        .filter((x) => x.session.role === 'worker')
        .map((x) => ({
          key: x.session.id,
          name: identities.sessions.get(x.session.id)!.name,
          title: x.session.title,
          agent: x.session.agent,
          status: undefined,
          files: [] as string[],
          diff: x.worktree?.diff,
          sessionId: x.session.id,
        }));
  const total = rows.reduce(
    (a, r) => ({
      files: a.files + (r.diff?.filesChanged ?? 0),
      ins: a.ins + (r.diff?.insertions ?? 0),
      del: a.del + (r.diff?.deletions ?? 0),
    }),
    { files: 0, ins: 0, del: 0 },
  );
  if (rows.length === 0)
    return (
      <EmptyState
        icon={<FileText size={18} />}
        title="No files yet"
        description="When agents start working, the files each task claims and changes show up here."
      />
    );
  return (
    <div className={s.wrap}>
      <p className={s.summary}>
        {total.files} {total.files === 1 ? 'file' : 'files'} changed across {rows.length} tasks ·{' '}
        <span className={s.add}>+{total.ins}</span> <span className={s.del}>−{total.del}</span> ·
        each task owns the files it claimed in the plan, so parallel agents never edit the same
        file.
      </p>
      <div className={s.grid}>
        {rows.map((r) => (
          <button
            key={r.key}
            type="button"
            className={s.fileCard}
            disabled={!r.sessionId}
            onClick={() => r.sessionId && onOpen(r.sessionId)}
          >
            <span className={s.fileHead}>
              <ActorBadge
                name={r.name}
                role="author"
                agent={r.agent}
                title={r.sessionId ? `${r.sessionId} · ${r.key}` : r.key}
              />
              <strong>{r.title}</strong>
              {r.status && <StatusPill status={r.status} variant="inline" />}
            </span>
            {r.files.length > 0 ? (
              <ul className={s.paths}>
                {r.files.map((f) => (
                  <li key={f}>
                    <FileText size={12} aria-hidden /> {f}
                  </li>
                ))}
              </ul>
            ) : (
              <span className={s.muted}>No file claims recorded.</span>
            )}
            <span className={s.foot}>
              {r.diff ? (
                <>
                  {r.diff.filesChanged} {r.diff.filesChanged === 1 ? 'file' : 'files'} ·{' '}
                  <span className={s.add}>+{r.diff.insertions}</span>{' '}
                  <span className={s.del}>−{r.diff.deletions}</span>
                </>
              ) : (
                <span className={s.muted}>No changes yet</span>
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Commits tab: Helix commits at the end of every agent turn, plus merges. */
export function CommitsView({
  state,
  events,
  index,
  onOpen,
  onSeek,
}: {
  state: ProjectState;
  events: readonly HelixEvent[];
  index: number;
  onOpen: (sessionId: string) => void;
  onSeek: (index: number) => void;
}) {
  const list = commits(state);
  const commitActor = (sha: string, sessionId: string) => {
    const event = events
      .slice(0, index + 1)
      .find(
        (e) =>
          e.sessionId === sessionId &&
          e.type === 'chat.item' &&
          e.payload.item.kind === 'message' &&
          e.payload.item.role === 'system' &&
          e.payload.item.text.startsWith(`Committed ${sha}:`),
      );
    return (event && historicalActorName(state, event)) ?? identityFor(state, sessionId)!.name;
  };
  const merges = events
    .slice(0, index + 1)
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.type === 'pr.merged');
  if (list.length === 0 && merges.length === 0)
    return (
      <EmptyState
        icon={<GitCommitHorizontal size={18} />}
        title="No commits yet"
        description="Agents only edit files. Helix commits their work at the end of each turn, and those commits appear here."
      />
    );
  return (
    <div className={s.wrap}>
      <p className={s.summary}>
        Agents edit files; Helix makes every commit, at the end of each turn, on the task’s own
        branch.
      </p>
      <ol className={s.commits}>
        {merges.map(({ e, i }) => (
          <li key={`m${e.seq}`}>
            <button type="button" onClick={() => onSeek(i)}>
              <GitMerge size={15} className={s.merge} aria-hidden />
              <span className={s.grow}>
                {e.type === 'pr.merged' ? `PR #${e.payload.prNumber} merged into main` : ''}
              </span>
              <span className={s.muted}>#{e.seq}</span>
            </button>
          </li>
        ))}
        {list.map((c) => (
          <li key={c.sha}>
            <button type="button" onClick={() => onOpen(c.sessionId)}>
              <GitCommitHorizontal size={15} aria-hidden />
              <code className={s.sha}>{c.sha.slice(0, 7)}</code>
              <span className={s.grow}>{c.title}</span>
              <ActorBadge
                {...identityFor(state, c.sessionId)!}
                name={commitActor(c.sha, c.sessionId)}
                title={c.sessionId}
              />
              <span className={s.branch}>{c.branch}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
