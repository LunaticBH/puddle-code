import { toastError } from '../../../lib/errors';
import type { DaemonConfig } from '@puddle/shared';
import { Input } from '../../../components/ui/input';
import { Switch } from '../../../components/ui/switch';
import { useConfig, useDaemonVersion, useHostInfo, usePatchConfig } from '../../../lib/queries';
import { SectionTitle, SettingRow } from '../parts';

function NumberSetting({
  label,
  description,
  field,
  config,
  min,
  step = 1,
}: {
  label: string;
  description?: string;
  field: keyof DaemonConfig &
    (
      | 'fetchIntervalMinutes'
      | 'logMaxBytes'
      | 'logRetentionDays'
      | 'replayBytes'
      | 'uiStateRetentionDays'
    );
  config: DaemonConfig;
  min: number;
  step?: number;
}) {
  const patch = usePatchConfig();
  return (
    <SettingRow label={label} description={description} htmlFor={`host-${field}`}>
      <Input
        id={`host-${field}`}
        type="number"
        min={min}
        step={step}
        className="w-32 tabular-nums"
        defaultValue={config[field]}
        onBlur={(e) => {
          // A cleared field is not a request for 0 — restore the stored value.
          if (e.target.value.trim() === '') {
            e.target.value = String(config[field]);
            return;
          }
          const value = Number(e.target.value);
          if (Number.isFinite(value) && value !== config[field]) {
            patch.mutate({ [field]: value }, { onError: (err) => toastError(err) });
          }
        }}
      />
    </SettingRow>
  );
}

/** Daemon scope — one config.json for the whole box. */
export function HostSection() {
  const config = useConfig();
  const patch = usePatchConfig();
  const host = useHostInfo();
  const protocol = useDaemonVersion().data?.protocol;
  const retentionSupported =
    protocol && (protocol.major > 25 || (protocol.major === 25 && protocol.minor >= 6));
  if (!config.data) return null;

  return (
    <div>
      {/* The port is deliberately absent: transport is the CLI's business
          (--port / config.json), never the UI's (decision 2026-07-13). */}
      <SectionTitle note="Affects all profiles on this host">Host</SectionTitle>
      <SettingRow
        label="Display name"
        description="Shown in place of the hostname across the UI. Leave blank for the hostname."
        htmlFor="host-displayName"
      >
        <Input
          id="host-displayName"
          type="text"
          maxLength={64}
          className="w-48"
          // The fallback an empty field means — the actual hostname, not a
          // generic hint.
          placeholder={host.data?.hostname}
          defaultValue={config.data.displayName}
          onBlur={(e) => {
            const value = e.target.value.trim();
            if (value !== config.data.displayName) {
              patch.mutate({ displayName: value }, { onError: (err) => toastError(err) });
            }
          }}
        />
      </SettingRow>
      <NumberSetting
        label="Fetch interval (minutes)"
        description="Periodic git fetch for repos with active sessions."
        field="fetchIntervalMinutes"
        config={config.data}
        min={1}
      />
      <NumberSetting
        label="Log size cap (bytes)"
        description="Per-terminal on-disk log cap."
        field="logMaxBytes"
        config={config.data}
        min={65536}
        step={1048576}
      />
      {retentionSupported && (
        <NumberSetting
          label="Bulk log retention (days)"
          description="Older inactive terminal logs keep only their replay tail. Archived restoration and shell history are preserved. Set 0 to disable age-based cleanup."
          field="logRetentionDays"
          config={config.data}
          min={0}
        />
      )}
      <NumberSetting
        label="Replay size (bytes)"
        description="Log tail sent to a terminal on attach."
        field="replayBytes"
        config={config.data}
        min={1024}
        step={65536}
      />
      <NumberSetting
        label="UI-state retention (days)"
        description="Stale workspace snapshots are swept at boot."
        field="uiStateRetentionDays"
        config={config.data}
        min={1}
      />
      <SettingRow
        label="Auto-resume"
        description="Resume interrupted sessions automatically after a daemon restart."
        htmlFor="host-autoResume"
      >
        <Switch
          id="host-autoResume"
          checked={config.data.autoResume}
          onCheckedChange={(checked) =>
            patch.mutate({ autoResume: checked }, { onError: (e) => toastError(e) })
          }
        />
      </SettingRow>
    </div>
  );
}
