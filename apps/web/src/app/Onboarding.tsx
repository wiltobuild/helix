import { useState, type FormEvent } from 'react';
import { FolderGit2 } from 'lucide-react';
import { Button, EmptyState, TextField } from '@helix/ui';
import s from './Onboarding.module.css';

/** First run against a real daemon with no projects yet. */
export function Onboarding({
  onAdd,
  error,
}: {
  onAdd: (repoPath: string) => Promise<void>;
  error?: string | undefined;
}) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!path.trim()) return;
    setBusy(true);
    try {
      await onAdd(path.trim());
    } catch {
      /* error is shown by the source */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.wrap}>
      <span className={s.wordmark}>helix</span>
      <EmptyState
        icon={<FolderGit2 size={18} />}
        title="Add your first project"
        description="Point Helix at a local git repository. Agents work in their own branches, never in your checkout."
      />
      <form className={s.form} onSubmit={(e) => void submit(e)}>
        <TextField
          id="repo-path"
          label="Repository path"
          placeholder="C:\Users\you\code\my-app"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          error={error}
          autoFocus
        />
        <Button type="submit" variant="primary" loading={busy} disabled={!path.trim()}>
          Add repository
        </Button>
      </form>
      <a className={s.demo} href="?demo">
        Or explore a recorded demo run
      </a>
    </div>
  );
}
