import { useState } from 'react';
import { OctagonX } from 'lucide-react';
import type { HelixClient } from '@helix/api-client';
import type { ProjectId, ProjectState } from '@helix/contracts';
import { Button, Dialog } from '@helix/ui';
import s from './App.module.css';

/** Sessions with a live agent: started, not exited and not archived. */
export function runningAgents(state: ProjectState): number {
  return Object.values(state.sessions).filter(
    (x) => !x.session.archivedAt && x.activity !== 'exited' && x.session.branch !== undefined,
  ).length;
}

/**
 * The #9 kill switch. Stops every agent in the project and pauses scheduling until a new plan
 * is approved or a task is created. Live mode only, while viewing the present.
 */
export function StopAll({
  client,
  projectId,
  running,
  canAct,
}: {
  client: HelixClient;
  projectId: ProjectId;
  running: number;
  canAct: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<number>();
  const [error, setError] = useState<string>();

  const stop = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { stopped } = await client.stopProjectAgents(projectId);
      setResult(stopped.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Stopping the agents failed.');
    } finally {
      setBusy(false);
    }
  };
  const close = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setResult(undefined);
      setError(undefined);
    }
  };

  return (
    <>
      <Button
        variant="stop"
        icon={<OctagonX size={14} />}
        disabled={!canAct || running === 0}
        title={
          !canAct
            ? 'Available in live mode'
            : running === 0
              ? 'No agents are running'
              : 'Stop every agent in this project'
        }
        onClick={() => setOpen(true)}
      >
        Stop all
      </Button>
      <Dialog
        open={open}
        onOpenChange={close}
        title={result === undefined ? 'Stop all agents?' : 'Agents stopped'}
        description={
          result === undefined
            ? `This stops ${running} running ${running === 1 ? 'agent' : 'agents'} in this project, including the orchestrator. Branches and work so far are kept.`
            : `Stopped ${result} ${result === 1 ? 'agent' : 'agents'}. Helix won’t start new tasks until you approve a new plan or create a task.`
        }
        footer={
          result === undefined ? (
            <>
              <Button variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                icon={<OctagonX size={14} />}
                loading={busy}
                onClick={() => void stop()}
              >
                Stop all agents
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => close(false)}>
              Done
            </Button>
          )
        }
      >
        {error && (
          <p className={s.stopError} role="alert">
            {error}
          </p>
        )}
      </Dialog>
    </>
  );
}
