import { Button } from '@helix/ui';
import s from './App.module.css';

/** Keeps a pending Design decision reachable when intake opens the Plan workspace. */
export function DesignReturnBanner({ pending, onOpen }: { pending: boolean; onOpen: () => void }) {
  return (
    <div className={s.planBanner} role="status">
      <span>
        {pending
          ? 'A visual direction needs your input.'
          : 'The approved visual direction is available.'}
      </span>
      <Button size="sm" onClick={onOpen}>
        Open design workspace
      </Button>
    </div>
  );
}
