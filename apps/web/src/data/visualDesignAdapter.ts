import type { VisualDesign, VisualDesignRequest } from '@helix/contracts';
import type { VisualCommand, VisualRoundView, VisualWorkspaceView } from './visualWorkspace';

/** UI-only projection: persisted server design is the sole source of decisions and assets. */
export function visualDesignView(
  design: VisualDesign,
  title: string,
  affectedTasks: readonly string[],
): VisualWorkspaceView {
  const currentRound = design.rounds.at(-1);
  const activeRoundId = currentRound?.jobId ?? `pending-${design.revision}`;
  const rounds: VisualRoundView[] = design.rounds.map((round, index) => {
    const current = index === design.rounds.length - 1;
    const recommended = round.concepts.find((concept) => concept.recommended);
    return {
      id: round.jobId,
      revision: round.revision,
      ...(round.palette ? { palette: round.palette } : {}),
      status: current ? design.status : round.concepts.length === 3 ? 'ready' : 'superseded',
      brief: design.brief,
      concepts: round.concepts.map((concept) => ({
        id: concept.id,
        title: concept.title,
        imageUrl: concept.imageUrl,
        alt: `${concept.title} — generated visual concept`,
        rationale: concept.rationale,
        tradeoffs: concept.tradeoffs,
      })),
      ...(recommended
        ? { recommendation: { conceptId: recommended.id, rationale: recommended.rationale } }
        : {}),
      ...(current && design.blocker ? { error: design.blocker } : {}),
      ...(current && design.status === 'unavailable'
        ? {
            setupHint:
              'Connect a supported Codex image-generation runtime to Helix, then retry. A coding CLI alone does not confirm image-generation capability.',
          }
        : {}),
    };
  });
  if (rounds.length === 0)
    rounds.push({
      id: activeRoundId,
      revision: design.revision,
      status: design.status,
      brief: design.brief,
      concepts: [],
      ...(design.blocker ? { error: design.blocker } : {}),
    });
  return {
    id: design.sessionId,
    revision: design.revision,
    title,
    activeRoundId,
    rounds,
    affectedTasks,
    conversation: design.conversation.map((message, index) => ({
      id: `${index}:${message.revision}`,
      revision: message.revision,
      role: message.role === 'helix' ? ('assistant' as const) : ('user' as const),
      text: message.text,
      references: message.references,
    })),
    decisions: design.decision
      ? [
          {
            id: `decision-${design.decision.revision}`,
            revision: design.decision.revision,
            text: `Approved ${design.decision.conceptIds.length > 1 ? 'combined direction' : 'direction'}: ${design.decision.conceptIds.map((id) => design.rounds.flatMap((round) => round.concepts).find((concept) => concept.id === id)?.title ?? id).join(' + ')}`,
            rationale: design.decision.rationale,
            ...(design.decision.palette ? { palette: design.decision.palette } : {}),
          },
        ]
      : [],
    ...(design.checkpoint
      ? {
          checkpoint: {
            id: design.checkpoint.headSha,
            revision: design.revision,
            title: 'Visual implementation checkpoint',
            summary: 'Review the working implementation before affected work continues.',
            recommendation: design.checkpoint.recommendation,
            status: 'ready' as const,
            previewUrl: design.checkpoint.previewUrl,
            commit: design.checkpoint.headSha,
            reducedMotion: design.checkpoint.reducedMotion,
          },
        }
      : {}),
  };
}

export function visualDesignRequest(command: VisualCommand): VisualDesignRequest {
  const approving = command.action === 'approve' || command.action === 'approve_checkpoint';
  return {
    requestId: command.requestId,
    ...(command.action === 'regenerate' && command.palette !== undefined
      ? { palette: command.palette }
      : {}),
    revision: command.revision,
    action:
      command.action === 'feedback'
        ? 'comment'
        : command.action === 'approve_checkpoint'
          ? 'approve'
          : command.action,
    ...(command.feedback
      ? { text: command.feedback }
      : approving
        ? {
            text:
              command.action === 'approve_checkpoint'
                ? 'Approve this working preview and continue with the selected visual direction.'
                : 'Use the selected visual direction.',
          }
        : {}),
    ...(approving ? { conceptIds: [...command.conceptIds] } : {}),
    ...(command.references.length > 0
      ? { references: command.references.map((url) => ({ url })) }
      : {}),
  };
}
