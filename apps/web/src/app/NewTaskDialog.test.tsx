import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { fixtures, type IntakeDraft } from '@helix/contracts';
import { TooltipProvider } from '@helix/ui';
import {
  DiscoveryDestination,
  IntakeStart,
  IntakeWorkspace,
  ProjectContext,
} from './NewTaskDialog';
import { approvalBlockers, intakeScopeSwitchHeld, type IntakeStage } from './intakeModel';

// Static render tests: they prove content and gating attributes, not click behaviour.
const project = fixtures.passwordResetProject;
const html = (node: ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const buttonTag = (markup: string, label: string) => {
  const before = markup.slice(0, markup.indexOf(label));
  return before.slice(before.lastIndexOf('<button'));
};
const noop = () => {};

describe('start', () => {
  test.each(['generating', 'launching', 'uncertain'] as const)(
    'repository controls preserve the current draft during %s',
    (state) => {
      const markup = html(
        <ProjectContext
          project={project}
          projects={[project, { ...project, id: 'other' as typeof project.id }]}
          disabled={intakeScopeSwitchHeld({
            busy: false,
            loaded: true,
            approvalUnknown: state === 'uncertain',
            status: state === 'uncertain' ? 'review' : state,
          })}
          demo={false}
          onSelect={noop}
          onAdd={noop}
        />,
      );
      expect(markup).toMatch(/<select[^>]*disabled/);
      expect(markup).toMatch(/<button[^>]*disabled/);
    },
  );
  const start = (over: Partial<Parameters<typeof IntakeStart>[0]> = {}) =>
    html(
      <IntakeStart
        context={
          <ProjectContext project={project} projects={[project]} disabled={false} demo={false} />
        }
        intent="new"
        onIntent={noop}
        idea=""
        onIdea={noop}
        disabled={false}
        composerLocked={false}
        demo={false}
        readiness="unknown"
        onBegin={noop}
        {...over}
      />,
    );

  test('composer and examples are locked while a start request is in flight', () => {
    const markup = start({ idea: 'A CSV export', disabled: true, composerLocked: true });
    const composer = markup.match(/<textarea[^>]*id="build-idea"[^>]*>/)?.[0] ?? '';
    expect(composer).toContain('disabled=""');
    expect(buttonTag(markup, 'A new project')).toContain('disabled');
    const idle = start({ idea: 'A CSV export' });
    expect(buttonTag(idle, 'A new project')).not.toContain('disabled');
  });

  test('leads with the question and a single composer, no name field or approval', () => {
    const markup = start();
    expect(markup).toContain('A spark is enough.');
    expect(markup).toContain('Let&#x27;s give it shape.');
    expect(markup).toContain('id="build-idea"');
    expect(markup).not.toContain('Build name');
    expect(markup).not.toContain('Approve');
    expect(markup).not.toContain('What do you want to achieve');
  });

  test('repository is context, never interpolated as the product to build', () => {
    const markup = start();
    expect(markup).toContain(project.name);
    expect(markup).toContain('It doesn’t decide what you build.');
    expect(markup).not.toContain(`Shape the outcome for ${project.name}`);
    expect(markup).not.toMatch(new RegExp(`placeholder="[^"]*${project.name}`));
  });

  test('examples are offered but nothing is prefilled', () => {
    const markup = start();
    expect(markup).toContain('A new project');
    expect(markup).toContain('An existing project');
    expect(markup).toContain('Choosing a context creates nothing.');
    expect(markup).toMatch(/<textarea[^>]*id="build-idea"[^>]*><\/textarea>/);
  });

  test('both paths need words first; typed words enable them', () => {
    expect(buttonTag(start(), 'Let’s talk')).toContain('disabled');
    expect(buttonTag(start(), 'Review as written')).toContain('disabled');
    const typed = start({ idea: 'A CSV export' });
    expect(buttonTag(typed, 'Let’s talk')).not.toContain('disabled');
    expect(typed).toContain('A CSV export</textarea>');
  });

  test('agent availability copy follows detection only', () => {
    expect(start({ readiness: 'missing' })).toContain('did not detect');
    expect(start({ readiness: 'ready' })).toContain('detected as installed and signed in');
    expect(start({ readiness: 'unknown' })).not.toContain('detected as installed');
  });

  test('no repository is stated plainly with a setup path', () => {
    const markup = html(<ProjectContext projects={[]} disabled={false} demo={true} />);
    expect(markup).toContain('No repository connected');
    expect(markup).toContain('Start helixd');
  });

  test('switching repository uses the existing project list and is locked while busy', () => {
    const other = { ...project, id: 'project_other' as typeof project.id, name: 'Other repo' };
    const markup = html(
      <ProjectContext
        project={project}
        projects={[project, other]}
        disabled={true}
        demo={false}
        onSelect={noop}
        onAdd={noop}
      />,
    );
    expect(markup).toContain('Other repo');
    expect(markup).toMatch(/<select[^>]*disabled/);
  });
});

describe('workspace', () => {
  const synthesis = {
    brief: 'Customers reset passwords via an emailed link.',
    question: 'How long should a reset link stay valid?',
    choices: [
      { label: '15 minutes', tradeoff: 'Safer, but slow inboxes may expire it.' },
      { label: '24 hours', tradeoff: 'Forgiving, but a leaked link lives longer.' },
    ],
    unknowns: ['Reset link lifetime'],
    assumptions: ['Email is the only delivery channel'],
    confirmed: [{ statement: 'Customers start from sign-in', answerIds: ['original-goal'] }],
  };
  const draft: IntakeDraft = {
    id: 'd1',
    revision: 4,
    title: 'Password reset',
    originalGoal: 'Let customers reset a forgotten password',
    mode: 'interview',
    answers: [{ id: 'a1', question: 'Who can reset?', answer: 'Any customer', source: 'user' }],
    synthesis,
    versions: [{ revision: 4, text: synthesis.brief, source: 'agent' }],
    status: 'review',
  };
  const actions = {
    respond: noop,
    generate: noop,
    useAsWritten: noop,
    saveInputs: noop,
    discardInputs: noop,
    rename: noop,
    cancel: noop,
    saveBrief: noop,
    discardBrief: noop,
    approve: noop,
    checkApproval: noop,
    close: noop,
    startOver: noop,
  };
  const render = (
    d: IntakeDraft,
    stage: Exclude<IntakeStage, 'start'>,
    extra: {
      dirty?: boolean;
      briefEdited?: boolean;
      brief?: string;
      title?: string;
      answer?: string;
      answerNote?: string;
      approvalUnknown?: boolean;
      locked?: boolean;
      pendingIdea?: string;
    } = {},
  ) => {
    const props = {
      context: null,
      draft: d,
      stage,
      title: d.title,
      onTitle: noop,
      goal: d.originalGoal,
      onGoal: noop,
      answers: d.answers,
      onAnswers: noop,
      answer: '',
      onAnswer: noop,
      brief: d.synthesis?.brief ?? '',
      onBrief: noop,
      dirty: false,
      briefEdited: false,
      locked: stage === 'generating' || stage === 'launching',
      busy: false,
      demo: false,
      pendingIdea: '',
      onDiscardPendingIdea: noop,
      actions,
      ...extra,
    };
    return html(
      <IntakeWorkspace
        {...props}
        blockers={approvalBlockers({
          draft: d,
          dirty: props.dirty,
          briefEdited: props.briefEdited,
          title: props.title,
          goal: props.goal,
        })}
      />,
    );
  };

  test('shows one current question with recommended choices and tradeoffs', () => {
    const markup = render(draft, 'review');
    expect(markup).toContain('How long should a reset link stay valid?');
    expect(markup).toContain('Safer, but slow inboxes may expire it.');
    expect(markup).toContain('Recommend something');
    expect(markup).toContain('Your answers so far (1)');
  });

  test('keeps the actual conversation visible and progressively reveals the concept', () => {
    const conversational = {
      ...draft,
      answers: [
        { ...draft.answers[0]!, assistantMessage: 'A simple recovery flow keeps people moving.' },
      ],
      synthesis: {
        ...synthesis,
        message: 'A shorter expiry reduces the risk of a forwarded link.',
      },
    };
    const markup = render(conversational, 'review');
    expect(markup).toContain('Conversation so far');
    expect(markup).toContain('A simple recovery flow keeps people moving.');
    expect(markup).toContain('A shorter expiry reduces the risk of a forwarded link.');
    expect(markup).toContain('What we know');
    expect(markup).toContain('Still exploring');
    expect(markup).toContain('Next step');
    expect(markup).toMatch(/<details[^>]*><summary>Review &amp; edit full concept/);
    expect(
      render(
        {
          ...conversational,
          synthesis: { ...conversational.synthesis, unknowns: [], question: '' },
        },
        'review',
      ),
    ).toMatch(/<details[^>]*open=""[^>]*><summary>Review &amp; edit full concept/);
  });

  test('separates confirmed answers from assumptions and blocks on open decisions', () => {
    const markup = render(draft, 'review');
    expect(markup).toContain('Confirmed by you');
    expect(markup).toContain('From Your original idea');
    expect(markup).toContain('Assumed — approve or correct');
    expect(markup).toContain('Still to decide');
    expect(markup).toContain('1 decision still needs your answer.');
    expect(buttonTag(markup, 'Approve brief &amp; create plan')).toContain('disabled');
  });

  test('a resolved, unedited review is approvable', () => {
    const ready = {
      ...draft,
      synthesis: { ...synthesis, question: '', choices: [], unknowns: [] },
    };
    const markup = render(ready, 'review');
    expect(buttonTag(markup, 'Approve brief &amp; create plan')).not.toContain('disabled');
    expect(render(ready, 'review', { dirty: true })).toContain('Save or discard your edits first');
  });

  test('approval is absent before review and retry-only while launching', () => {
    expect(render({ ...draft, status: 'generating' }, 'generating')).not.toContain('Approve brief');
    expect(render({ ...draft, status: 'generating' }, 'generating')).toContain('Stop writing');
    expect(
      render({ ...draft, status: 'editing', synthesis: null, versions: [] }, 'compose'),
    ).not.toContain('Approve brief');
    const launching = render(
      { ...draft, status: 'launching', synthesis: { ...synthesis, unknowns: [] } },
      'launching',
    );
    expect(launching).toContain('Retry approved launch');
    expect(launching).not.toContain('Stop writing');
  });

  test('failed generation is explained with retry and keep-my-words paths', () => {
    const error = 'The brief writer could not complete a valid response.';
    const markup = render({ ...draft, status: 'failed', error }, 'failed');
    expect(markup).toContain('The brief writer could not complete a valid response.');
    expect(markup).toContain('Try again');
    expect(markup).toContain('Use my idea as the brief');
    expect(markup).toContain('Last written revision, for reference');
  });

  const fieldTag = (markup: string, id: string) =>
    markup.match(new RegExp(`<(?:input|textarea)[^>]*id="${id}"[^>]*>`))?.[0] ?? '';
  const ready = {
    ...draft,
    synthesis: { ...synthesis, question: '', choices: [], unknowns: [] },
  };

  test('unsaved brief prose holds input edits and answering, so neither discards the other', () => {
    const markup = render(ready, 'review', { briefEdited: true, brief: 'My own wording.' });
    expect(markup).toContain('Your brief has unsaved edits');
    expect(fieldTag(markup, 'build-name')).toContain('disabled');
    expect(fieldTag(markup, 'build-goal')).toContain('disabled');
    expect(fieldTag(markup, 'reviewed-brief')).not.toContain('disabled');
    expect(markup).toContain('Save brief revision');
  });

  test('an emptied brief keeps the empty text and explains how to proceed', () => {
    const markup = render(ready, 'review', { briefEdited: true, brief: '' });
    expect(markup).toContain('A brief can’t be empty');
    expect(buttonTag(markup, 'Save brief revision')).toContain('disabled');
    expect(buttonTag(markup, 'Discard edits')).not.toContain('disabled');
    expect(fieldTag(markup, 'reviewed-brief')).not.toContain('disabled');
  });

  test('unsaved input edits hold the brief prose instead', () => {
    const markup = render(ready, 'review', { dirty: true, title: 'Renamed' });
    expect(fieldTag(markup, 'reviewed-brief')).toContain('disabled');
    expect(fieldTag(markup, 'build-name')).not.toContain('disabled');
  });

  test('an unsent answer typed for an earlier question says so instead of re-targeting', () => {
    const markup = render(draft, 'review', {
      answer: 'About an hour',
      answerNote: 'You started this for an earlier question: “Who can reset?”',
    });
    expect(markup).toContain('About an hour</textarea>');
    expect(markup).toContain('You started this for an earlier question');
  });

  test('an unconfirmed approval freezes editing and only offers the same approval again', () => {
    const markup = render(ready, 'review', { approvalUnknown: true, locked: true });
    expect(markup).toContain('couldn’t confirm whether your approval was recorded');
    expect(markup).toContain('Retry approval');
    expect(markup).toContain('Check again');
    expect(markup).not.toContain('Approve brief &amp; create plan');
    expect(fieldTag(markup, 'reviewed-brief')).toContain('disabled');
    expect(fieldTag(markup, 'build-name')).toContain('disabled');
  });

  test('an unsent idea for another build is kept visible, not silently dropped', () => {
    const markup = render(draft, 'review', { pendingIdea: 'A CSV export' });
    expect(markup).toContain('A CSV export');
    expect(markup).toContain('Start it instead');
  });
});

test('destination controls appear only when useful and never launch or fabricate a repository', () => {
  const draft: IntakeDraft = {
    id: 'independent',
    revision: 1,
    title: 'Idea',
    originalGoal: 'Develop an idea',
    mode: 'interview',
    answers: [],
    synthesis: null,
    versions: [],
    status: 'editing',
  };
  expect(
    html(<DiscoveryDestination draft={draft} projects={[]} disabled={false} onBind={noop} />),
  ).toBe('');
  const ready: IntakeDraft = {
    ...draft,
    status: 'review',
    synthesis: {
      brief: 'Concept',
      question: '',
      choices: [],
      unknowns: [],
      assumptions: [],
      confirmed: [],
    },
  };
  const empty = html(
    <DiscoveryDestination draft={ready} projects={[]} disabled={false} onBind={noop} />,
  );
  expect(empty).toContain('No repository is registered yet');
  expect(empty).not.toContain('<select');
  const available = html(
    <DiscoveryDestination draft={ready} projects={[project]} disabled={false} onBind={noop} />,
  );
  expect(available).toContain('does not launch work or inspect files');
  expect(buttonTag(available, 'Use this destination')).toContain('disabled');
});
