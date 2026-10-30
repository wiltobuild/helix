import type { PlanId, SessionId } from './ids.js';
import type { PlanStatus } from './entities.js';
import type { ProjectState, SessionState } from './projection.js';
import type { VisualDesign } from './visual-design.js';
import { deriveStatus } from './status.js';

/** A build is a user outcome within a project, rooted in an existing agent session.
 * This read model adds no persisted IDs, events or approval authority. */
export interface BuildView {
  projectId: ProjectState['project']['id'];
  rootSessionId: SessionId;
  title: string;
  /** Original request, never replaced by a generated plan goal or design brief. */
  goal: string;
  planId?: PlanId;
  sessionIds: SessionId[];
  stages: BuildStage[];
}

/** Evidence summaries may overlap (independent implementation can run during design).
 * No global completion is inferred from an exited agent, CI, or a static render. */
export type BuildStage =
  | { kind: 'planning'; status: PlanStatus | 'preparing'; planId?: PlanId }
  | {
      kind: 'design';
      status: VisualDesign['status'];
      revision: number;
      approvedRevision?: number;
      checkpointHeadSha?: string;
    }
  | { kind: 'implementation'; tasks: number; started: number; merged: number }
  | {
      kind: 'review';
      pullRequests: number;
      readyToMerge: number;
      merged: number;
      currentApprovals: number;
      staleReviews: number;
    };

/** Consume a projection at the desired replay cursor, never a mixture of live and past facts. */
export function projectBuilds(state: ProjectState): BuildView[] {
  const sessions = Object.values(state.sessions);
  const attached = new Set(
    Object.values(state.plans).flatMap((p) =>
      p.nodes.flatMap((n) => (n.sessionId ? [n.sessionId] : [])),
    ),
  );
  return sessions
    .filter(
      ({ session: s }) =>
        s.role !== 'reviewer' && !s.parentSessionId && !s.planNodeId && !attached.has(s.id),
    )
    .map((root) => {
      const plans = Object.values(state.plans).filter(
        (p) => p.orchestratorSessionId === root.session.id,
      );
      const plan = plans.at(-1);
      const ids = new Set<SessionId>([root.session.id]);
      // Include all plan revisions for ownership/history, but stage counts use the latest plan.
      for (const p of plans)
        for (const node of p.nodes) if (node.sessionId) ids.add(node.sessionId);
      let previousSize = -1;
      while (previousSize !== ids.size) {
        previousSize = ids.size;
        for (const { session } of sessions)
          if (session.parentSessionId && ids.has(session.parentSessionId)) ids.add(session.id);
        for (const s of sessions)
          if (ids.has(s.session.id) && s.agentReview) ids.add(s.agentReview.reviewerSessionId);
      }
      const workers: SessionState[] = plan
        ? plan.nodes.flatMap((n) =>
            n.sessionId && state.sessions[n.sessionId] ? [state.sessions[n.sessionId]!] : [],
          )
        : root.session.role === 'worker'
          ? [root]
          : [];
      const stages: BuildStage[] = [];
      if (root.session.role === 'orchestrator')
        stages.push({
          kind: 'planning',
          status: plan?.status ?? 'preparing',
          ...(plan ? { planId: plan.id } : {}),
        });
      const design = root.design;
      if (design)
        stages.push({
          kind: 'design',
          status: design.status,
          revision: design.revision,
          ...(design.status === 'approved' && design.decision?.revision === design.revision
            ? { approvedRevision: design.decision.revision }
            : {}),
          ...(design.checkpoint ? { checkpointHeadSha: design.checkpoint.headSha } : {}),
        });
      if (plan || workers.length)
        stages.push({
          kind: 'implementation',
          tasks: plan?.nodes.length ?? workers.length,
          started: workers.filter((w) => w.worktree !== undefined).length,
          merged: workers.filter((w) => w.pr?.state === 'merged').length,
        });
      const prs = workers.filter((w) => w.pr);
      if (prs.length)
        stages.push({
          kind: 'review',
          pullRequests: prs.length,
          readyToMerge: prs.filter((w) => deriveStatus(w) === 'ready_to_merge').length,
          merged: prs.filter((w) => w.pr?.state === 'merged').length,
          currentApprovals: prs.filter(
            (w) => w.agentReview?.status === 'approved' && w.agentReview.headSha === w.pr!.headSha,
          ).length,
          staleReviews: prs.filter((w) => w.agentReview && w.agentReview.headSha !== w.pr!.headSha)
            .length,
        });
      return {
        projectId: state.project.id,
        rootSessionId: root.session.id,
        title: root.session.title,
        goal: root.session.prompt,
        ...(plan ? { planId: plan.id } : {}),
        sessionIds: [...ids].filter((id) => Object.hasOwn(state.sessions, id)),
        stages,
      };
    });
}
