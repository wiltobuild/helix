import { useState, type FormEvent } from 'react';
import type { HelixClient } from '@helix/api-client';
import type { AgentKind, Project } from '@helix/contracts';
import { AgentBadge, Button, Dialog, Segmented, Switch, TextArea, TextField } from '@helix/ui';
import s from './NewTaskDialog.module.css';

/** Claude Code plans every orchestrated goal; the plan assigns each task to Codex or Claude Code. */
const ORCHESTRATOR_AGENT: AgentKind = 'claude-code';

interface NewTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client?: HelixClient;
  project?: Project;
  onCreated: (sessionId: string) => void;
}

export function NewTaskDialog({
  open,
  onOpenChange,
  client,
  project,
  onCreated,
}: NewTaskDialogProps) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState<AgentKind>(project?.defaultAgent ?? 'codex');
  const [plan, setPlan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const demo = !client || !project;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (demo || !title.trim() || !prompt.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const session = await client.createSession(
        project.id,
        {
          title: title.trim(),
          prompt: prompt.trim(),
          agent: plan ? ORCHESTRATOR_AGENT : agent,
          interface: 'chat',
          planWithOrchestrator: plan,
        },
        { idempotencyKey: crypto.randomUUID() },
      );
      setTitle('');
      setPrompt('');
      onOpenChange(false);
      onCreated(session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the task.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New task"
      description={
        demo
          ? 'Demo mode replays a recorded run. Start helixd to delegate real work.'
          : `Delegate work in ${project.name}. The agent gets its own branch; your checkout is never touched.`
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            shortcut="⌘↵"
            loading={busy}
            disabled={demo || !title.trim() || !prompt.trim()}
            onClick={() => void submit()}
          >
            {plan ? 'Plan and start' : 'Start task'}
          </Button>
        </>
      }
    >
      <form
        className={s.form}
        onSubmit={(e) => void submit(e)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
        }}
      >
        <TextField
          id="task-title"
          label="Task"
          placeholder="Add password reset to the login flow"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
        <TextArea
          id="task-prompt"
          label="What should the agent do?"
          hint="Describe the outcome and how you'll know it's done. ⌘/Ctrl + Enter to start."
          placeholder="Users can request a reset link by email. Tokens expire after 30 minutes and work once."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <Switch
          id="task-plan"
          checked={plan}
          onCheckedChange={setPlan}
          label="Let the orchestrator plan it"
          description="Claude Code splits the goal into tasks with dependencies and assigns each to Codex or Claude Code."
        />
        {plan ? (
          <div className={s.row}>
            <span className={s.label}>Planner</span>
            <AgentBadge agent={ORCHESTRATOR_AGENT} variant="full" />
          </div>
        ) : (
          <div className={s.row}>
            <span className={s.label}>Agent</span>
            <Segmented
              label="Agent"
              value={agent}
              onValueChange={(v) => setAgent(v)}
              items={[
                { value: 'codex', label: <AgentBadge agent="codex" variant="full" /> },
                { value: 'claude-code', label: <AgentBadge agent="claude-code" variant="full" /> },
              ]}
            />
          </div>
        )}
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
