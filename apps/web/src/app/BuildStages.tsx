import type { BuildStage, BuildView } from '@helix/contracts';
import s from './BuildStages.module.css';

function describe(stage: BuildStage): string {
  switch (stage.kind) {
    case 'output':
      return `Output: ${stage.running}/${stage.previews} recorded previews running (live lease required)`;
    case 'planning':
      return `Planning: ${stage.status.replaceAll('_', ' ')}`;
    case 'design':
      return `Design: ${stage.status} · revision ${stage.revision}${stage.checkpointHeadSha ? ' · working preview checkpoint' : ''}`;
    case 'implementation':
      return `Implementation: ${stage.started}/${stage.tasks} tasks started · ${stage.merged} merged`;
    case 'review':
      return `Review: ${stage.pullRequests} PRs · ${stage.readyToMerge} ready to merge · ${stage.currentApprovals} current AI approvals${stage.staleReviews ? ` · ${stage.staleReviews} stale reviews` : ''}`;
  }
}

export function BuildStages({ build }: { build: BuildView }) {
  if (!build.stages.length) return null;
  return (
    <details className={s.stages}>
      <summary>Build stages</summary>
      <p className={s.goal}>
        <strong>Original goal:</strong> {build.goal || 'Not recorded'}
      </p>
      <ul aria-label="Build stage progress">
        {build.stages.map((stage) => (
          <li key={stage.kind}>{describe(stage)}</li>
        ))}
      </ul>
      <p>Stages can overlap. Design approval and plan approval are separate gates.</p>
    </details>
  );
}
