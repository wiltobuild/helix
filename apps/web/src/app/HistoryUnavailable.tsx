import type { HelixEvent } from '@helix/contracts';
import type { HelixSource } from '../data/useHelixSource';
import { DEMO_SCENARIOS } from '../data/demoScenarios';
import s from './App.module.css';

/** No projected controls or API mutation callbacks are mounted in this state. */
export function HistoryUnavailable({
  error,
  events,
  source,
}: {
  error: string;
  events: readonly HelixEvent[];
  source: HelixSource;
}) {
  return (
    <main className={s.loading}>
      <section aria-label="History unavailable">
        <div role="alert">
          <h1>History cannot be projected safely</h1>
          <p>{error}</p>
          <p>
            Approval and project actions are unavailable. All received event variants are retained.
            This view retries automatically when history changes.
          </p>
        </div>
        {source.projects.map((project) => (
          <button key={project.id} type="button" onClick={() => source.selectProject(project.id)}>
            View {project.name}
          </button>
        ))}
        {source.mode !== 'live' &&
          source.selectDemoPreset &&
          DEMO_SCENARIOS.map((scenario) => (
            <button
              key={scenario.value}
              type="button"
              onClick={() => source.selectDemoPreset?.(scenario.value)}
            >
              View {scenario.label}
            </button>
          ))}
        <details>
          <summary>Retained event evidence ({events.length} variants)</summary>
          <pre style={{ maxHeight: '50vh', overflow: 'auto' }}>
            {JSON.stringify(events, null, 2)}
          </pre>
        </details>
      </section>
    </main>
  );
}
