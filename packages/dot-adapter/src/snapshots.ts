import { ReadError } from './errors.js';
import { object, validEvidencePayload } from './journey.js';
import type { Scope } from './types.js';

const count = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const reject = (): never => {
  throw new ReadError('invalid_response');
};
const freshness = { sourceTimestamp: null, freshness: 'unknown' } as const;

export function intakeSnapshot(response: unknown, scope: Scope) {
  const raw = object(response).draft;
  if (raw === null) return { state: 'absent', ...freshness };
  const d = object(raw);
  if (
    !['editing', 'generating', 'review', 'failed', 'launching', 'launched'].includes(
      String(d.status),
    ) ||
    !count(d.revision) ||
    d.revision < 1 ||
    !['direct', 'interview'].includes(String(d.mode)) ||
    !Array.isArray(d.answers) ||
    d.answers.length > 100 ||
    (d.destinationProjectId !== undefined && d.destinationProjectId !== scope.projectId)
  )
    return reject();
  if (d.sessionId !== undefined && d.sessionId !== scope.sessionId)
    return { state: 'outside-session-scope', ...freshness };
  let userAnswers = 0;
  let acceptedRecommendations = 0;
  for (const rawAnswer of d.answers as unknown[]) {
    const a = object(rawAnswer);
    if (typeof a.id !== 'string' || typeof a.question !== 'string' || typeof a.answer !== 'string')
      return reject();
    if (a.source === 'user') userAnswers++;
    else if (a.source === 'recommendation-accepted') acceptedRecommendations++;
    else return reject();
  }
  let acceptedBrief = false;
  if (d.approved !== undefined) {
    const approved = object(d.approved);
    if (approved.intakeId !== d.id || approved.revision !== d.revision) return reject();
    acceptedBrief = validEvidencePayload({
      ...scope,
      seq: 1,
      ts: '',
      type: 'session.created',
      payload: {
        session: { id: scope.sessionId, projectId: scope.projectId, reviewedBrief: d.approved },
      },
    });
    if (!acceptedBrief) return reject();
  }
  const synthesis = object(d.synthesis);
  if (
    d.synthesis !== null &&
    (!Array.isArray(synthesis.confirmed) ||
      !Array.isArray(synthesis.assumptions) ||
      !Array.isArray(synthesis.unknowns))
  )
    return reject();
  return {
    state: d.status,
    mode: d.mode,
    revision: d.revision,
    userAnswers,
    acceptedRecommendations,
    acceptedBrief,
    generatedConfirmedClaims: Array.isArray(synthesis.confirmed) ? synthesis.confirmed.length : 0,
    assumptions: Array.isArray(synthesis.assumptions) ? synthesis.assumptions.length : 0,
    unknowns: Array.isArray(synthesis.unknowns) ? synthesis.unknowns.length : 0,
    decisionNeeded: d.status === 'review',
    blocked: d.status === 'failed',
    ...freshness,
  };
}

export function designSnapshot(response: unknown, scope: Scope) {
  const raw = object(response).design;
  if (raw === null) return { state: 'absent', ...freshness };
  const d = object(raw);
  if (
    !validEvidencePayload({
      ...scope,
      seq: 1,
      ts: '',
      type: 'design.updated',
      payload: { design: d },
    }) ||
    !Array.isArray(d.rounds)
  )
    return reject();
  let concepts = 0;
  for (const rawRound of d.rounds as unknown[]) {
    const round = object(rawRound);
    if (!Array.isArray(round.concepts) || round.concepts.length > 3) return reject();
    concepts += round.concepts.length;
  }
  return {
    state: d.status,
    revision: d.revision,
    rounds: d.rounds.length,
    concepts,
    accepted: d.status === 'approved',
    decisionNeeded: d.status === 'ready',
    blocked: d.status === 'failed' || d.status === 'unavailable',
    preview: d.checkpoint ? 'recorded-unverified' : 'absent',
    ...freshness,
  };
}
