import { useRef } from 'react';
import { FileUp } from 'lucide-react';
import { Button, Segmented } from '@helix/ui';
import type { HelixSource } from '../data/useHelixSource';
import s from './App.module.css';

/** Demo-mode header control: what's being replayed, preset switcher, and opening a local .helixlog. */
export function RecordingControl({ source }: { source: HelixSource }) {
  const input = useRef<HTMLInputElement>(null);
  const recorded = source.recording
    ? new Date(source.recording.header.recordedAt).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : undefined;
  return (
    <div className={s.recording}>
      {source.selectDemoPreset && (
        <Segmented
          label="Demo scenario"
          size="sm"
          value={source.demoPreset === 'github-ci-repair' ? 'github-ci-repair' : 'multi-agent'}
          onValueChange={(v) =>
            source.selectDemoPreset?.(v === 'github-ci-repair' ? 'github-ci-repair' : 'multi-agent')
          }
          items={[
            { value: 'multi-agent', label: 'Multi-agent plan' },
            { value: 'github-ci-repair', label: 'GitHub CI loop' },
          ]}
        />
      )}
      <span className={s.recordingLabel} title={source.recording?.name}>
        {source.recording ? `Recorded · ${recorded}` : 'Replaying multi-agent run'}
      </span>
      {source.recordingError && (
        <span className={s.recordingError} role="alert">
          {source.recordingError}
        </span>
      )}
      <input
        ref={input}
        type="file"
        accept=".helixlog"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void source.openRecording(file);
        }}
      />
      <Button size="sm" icon={<FileUp size={13} />} onClick={() => input.current?.click()}>
        Open recording
      </Button>
    </div>
  );
}
