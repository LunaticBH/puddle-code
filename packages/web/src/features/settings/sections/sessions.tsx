import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { toastError } from '../../../lib/transport/errors';
import {
  DEFAULT_CONCURRENT_TEMPLATE,
  DEFAULT_ONBOARDING_TEMPLATE,
  DEFAULT_RESTART_TEMPLATE,
  DEFAULT_TAB_TITLE_TEMPLATE,
  TAB_TITLE_VARIABLES,
  type ProfileSettings,
  type SessionDefaults,
  type SessionKind,
} from '@puddle/shared';
import { renderSessionTitle, type TitleSession } from '../../../lib/session-display';
import { Button } from '../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { Input, Textarea } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Switch } from '../../../components/ui/switch';
import { updateClientSettings, useClientSettings } from '../../../lib/settings/client-settings';
import {
  useConfig,
  usePatchConfig,
  usePatchProfileSettings,
  useProfileSettings,
  useProfiles,
} from '../../../lib/queries/queries';
import { useCurrentProfileId } from '../../profile/profile-store';
import { resolveSessionSeed } from '../../workspace/sessions/session-seed';
import { NumberField, SectionTitle, SettingRow } from '../parts';

/**
 * The daemon's agent-search PATH (host-wide, config.json): colon-separated dirs
 * prepended to PATH so the daemon can find agent CLIs like `claude`. Saved on
 * blur; a daemon restart applies it. Distinct from the browser-scoped rows here.
 */
function AgentPathRow() {
  const config = useConfig();
  const patch = usePatchConfig();
  const [value, setValue] = useState('');
  useEffect(() => {
    if (config.data) setValue(config.data.agentPath);
  }, [config.data]);
  return (
    <SettingRow
      label="Agent search path (host-wide)"
      description="Colon-separated dirs the daemon prepends to PATH; helps find agent CLIs like claude (e.g. ~/.local/bin)."
      htmlFor="agent-path"
    >
      <Input
        id="agent-path"
        type="text"
        className="w-64 text-2xs"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (config.data && value !== config.data.agentPath) patch.mutate({ agentPath: value });
        }}
      />
    </SettingRow>
  );
}

/**
 * One kind's new-session seed defaults (SPEC §11): what the modal OPENS with —
 * every value stays editable per session in the modal itself. The base branch
 * saves on blur; a separate branch always implies its own directory, so that
 * switch pins on (matching the modal). Writes the WHOLE `sessionDefaults`
 * object each time — the daemon's settings patch merges top-level keys only.
 */
function SessionSeedRows({
  kind,
  heading,
  settings,
  onSave,
  pending,
}: {
  kind: SessionKind;
  heading: string;
  settings: ProfileSettings;
  onSave: (next: SessionDefaults) => void;
  pending: boolean;
}) {
  const seed = resolveSessionSeed(kind, settings);
  const stored = settings.sessionDefaults ?? {};
  const [branch, setBranch] = useState(seed.baseBranch);
  const save = (change: SessionDefaults[SessionKind]) =>
    onSave({ ...stored, [kind]: { ...stored[kind], ...change } });
  return (
    <>
      <p className="mb-1 mt-4 text-xs font-medium uppercase tracking-wide text-fg-gold">
        {heading}
      </p>
      <SettingRow
        label="Base branch"
        description="Blank = the repository's default base branch."
        htmlFor={`${kind}-default-base`}
      >
        <Input
          id={`${kind}-default-base`}
          type="text"
          placeholder="repository default"
          className="w-48"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          onBlur={() => {
            if (branch.trim() !== seed.baseBranch) save({ baseBranch: branch.trim() });
          }}
        />
      </SettingRow>
      <SettingRow
        label="Separate branch"
        description="Start on a fresh branch off the base, in its own directory."
        htmlFor={`${kind}-default-branch`}
      >
        <Switch
          id={`${kind}-default-branch`}
          checked={seed.separateBranch}
          disabled={pending}
          onCheckedChange={(v) => save({ separateBranch: v })}
        />
      </SettingRow>
      <SettingRow
        label="Separate directory"
        description={
          seed.separateBranch
            ? 'Always on while a separate branch is used.'
            : 'Start on working copy of the selected branch instead of sharing one directory.'
        }
        htmlFor={`${kind}-default-dir`}
      >
        <Switch
          id={`${kind}-default-dir`}
          checked={seed.separateWorktree}
          disabled={pending || seed.separateBranch}
          onCheckedChange={(v) => save({ separateWorktree: v })}
        />
      </SettingRow>
    </>
  );
}

/** Terminal scrollback (client scope) — lives with the session knobs. */
function ScrollbackRow() {
  const settings = useClientSettings();
  return (
    <SettingRow label="Terminal scrollback" htmlFor="scrollback">
      <NumberField
        id="scrollback"
        min={500}
        max={100000}
        step={500}
        className="w-28 tabular-nums"
        value={settings.terminalScrollback}
        onCommit={(terminalScrollback) => updateClientSettings({ terminalScrollback })}
      />
    </SettingRow>
  );
}

/** One launch-text editor: save any text (empty is allowed) or reset to default. */
function TemplateEditor({
  id,
  label,
  description,
  initial,
  defaultText,
  onSave,
  pending,
}: {
  id: string;
  label: string;
  description: string;
  initial: string;
  defaultText: string;
  onSave: (text: string) => void;
  pending: boolean;
}) {
  const [text, setText] = useState(initial);
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <label htmlFor={id} className="flex flex-col gap-0.5 text-sm text-fg">
        {label}
        <span className="text-xs text-fg-muted">{description}</span>
      </label>
      <Textarea
        id={id}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        className="font-mono"
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={text === initial || pending}
          onClick={() => onSave(text)}
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={text === defaultText || pending}
          onClick={() => {
            setText(defaultText);
            onSave(defaultText);
          }}
        >
          Reset to default
        </Button>
      </div>
    </div>
  );
}

/** A representative session for the tab-title live preview (SPEC §4). */
const PREVIEW_SESSION: TitleSession = {
  id: '4f3c2b1a-7e6d-5c4b-3a2f-1e0d9c8b7a6f',
  title: null,
  agent_title: 'Refactor the auth flow',
  osc_title: 'claude',
  branch: 'alice/refactor-auth',
  worktree_path: '/home/alice/code/app--refactor-auth',
  status: 'waiting_input',
  agent_type: 'claude-code',
};

/**
 * Tab-title template editor (SPEC §4): edit the `${…}` template the profile
 * composes session labels from, with a live preview and a variable reference.
 */
function TabTitleEditor({
  initial,
  onSave,
  pending,
}: {
  initial: string;
  onSave: (text: string) => void;
  pending: boolean;
}) {
  const [text, setText] = useState(initial);
  const effective = text.length > 0 ? text : DEFAULT_TAB_TITLE_TEMPLATE;
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <label htmlFor="tab-title-template" className="flex flex-col gap-0.5 text-sm text-fg">
        Template
        <span className="text-xs text-fg-muted">
          Compose the label from the parts below. Empty falls back to the default.
        </span>
      </label>
      <Input
        id="tab-title-template"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="font-mono"
        placeholder={DEFAULT_TAB_TITLE_TEMPLATE}
      />
      <p className="text-xs text-fg-muted">
        Preview{' '}
        <span className="ml-1 font-sans text-fg">
          {renderSessionTitle(PREVIEW_SESSION, effective)}
        </span>
      </p>
      <dl className="mt-1 flex flex-col gap-0.5 text-xs">
        {TAB_TITLE_VARIABLES.map(([name, desc]) => (
          <div key={name} className="flex gap-2">
            <dt className="w-24 shrink-0 font-mono text-fg-secondary">{`\${${name}}`}</dt>
            <dd className="text-fg-muted">{desc}</dd>
          </div>
        ))}
      </dl>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={text === initial || pending}
          onClick={() => onSave(text)}
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={text === DEFAULT_TAB_TITLE_TEMPLATE || pending}
          onClick={() => {
            setText(DEFAULT_TAB_TITLE_TEMPLATE);
            onSave(DEFAULT_TAB_TITLE_TEMPLATE);
          }}
        >
          Reset to default
        </Button>
      </div>
    </div>
  );
}

/**
 * Session behaviour (SPEC §4, §11): the permission-skip gate, the launch text
 * templates sent to an agent when it starts a fresh worktree or joins an
 * existing one, and the tab-title template. Enabling the gate demands a typed
 * profile name; disabling is immediate. The daemon enforces the gate
 * server-side regardless of this UI.
 */
export function SessionsSection() {
  const profileId = useCurrentProfileId();
  const profiles = useProfiles();
  const profile = profiles.data?.find((p) => p.id === profileId);
  const settings = useProfileSettings(profileId ?? undefined);
  const patch = usePatchProfileSettings(profileId ?? '');
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');

  const gateOpen = settings.data?.allowSkipPermissions === true;

  const setGate = (value: boolean) =>
    patch.mutate(
      { allowSkipPermissions: value },
      {
        onSuccess: () => {
          setConfirming(false);
          setTyped('');
        },
        onError: (e) => toastError(e),
      },
    );

  const saveTemplate =
    (key: 'onboardingTemplate' | 'concurrentTemplate' | 'restartTemplate' | 'tabTitleTemplate') =>
    (text: string) =>
      patch.mutate({ [key]: text }, { onError: (e) => toastError(e) });

  return (
    <div>
      <SectionTitle>Sessions</SectionTitle>
      <SettingRow label="Skip permission prompts" htmlFor="gate">
        <Switch
          id="gate"
          checked={gateOpen}
          onCheckedChange={(checked) => {
            if (checked) setConfirming(true);
            else setGate(false); // closing is immediate (SPEC §11)
          }}
        />
      </SettingRow>
      <SettingRow
        label="Capture exported env variables"
        description={
          settings.data?.captureSessionEnv !== false
            ? 'Variables exported in a session persist and are re-injected upon terminal and agent restarts.'
            : 'No variables are captured or injected; already-captured variabless are kept for when this is re-enabled.'
        }
        htmlFor="capture-env"
      >
        <Switch
          id="capture-env"
          checked={settings.data?.captureSessionEnv !== false}
          disabled={patch.isPending}
          onCheckedChange={(v) =>
            patch.mutate({ captureSessionEnv: v }, { onError: (e) => toastError(e) })
          }
        />
      </SettingRow>
      <AgentPathRow />
      <ScrollbackRow />

      <div className="mt-5">
        <SectionTitle>New session defaults</SectionTitle>
        {settings.data && (
          <>
            <SessionSeedRows
              key={`${profileId}:agent-seed`}
              kind="agent"
              heading="New agents"
              settings={settings.data}
              onSave={(next) =>
                patch.mutate({ sessionDefaults: next }, { onError: (e) => toastError(e) })
              }
              pending={patch.isPending}
            />
            <SessionSeedRows
              key={`${profileId}:terminal-seed`}
              kind="terminal"
              heading="New terminals"
              settings={settings.data}
              onSave={(next) =>
                patch.mutate({ sessionDefaults: next }, { onError: (e) => toastError(e) })
              }
              pending={patch.isPending}
            />
          </>
        )}
      </div>

      <div className="mt-5">
        <SectionTitle note="Sent to agent as opening message when a session (re)starts. You can make this empty.">
          Launch text
        </SectionTitle>
        {settings.data && (
          <>
            <TemplateEditor
              key={`${profileId}:onboarding`}
              id="onboarding-template"
              label="New worktree"
              description="Use {{rules}} where the repo's onboarding notes should appear."
              initial={settings.data.onboardingTemplate ?? DEFAULT_ONBOARDING_TEMPLATE}
              defaultText={DEFAULT_ONBOARDING_TEMPLATE}
              onSave={saveTemplate('onboardingTemplate')}
              pending={patch.isPending}
            />
            <TemplateEditor
              key={`${profileId}:concurrent`}
              id="concurrent-template"
              label="Existing / shared worktree"
              description="For a session joining a worktree other agents may already be working in."
              initial={settings.data.concurrentTemplate ?? DEFAULT_CONCURRENT_TEMPLATE}
              defaultText={DEFAULT_CONCURRENT_TEMPLATE}
              onSave={saveTemplate('concurrentTemplate')}
              pending={patch.isPending}
            />
            <TemplateEditor
              key={`${profileId}:restart`}
              id="restart-template"
              label="Resume after restart"
              description="Sent when a session resumes after a daemon restart or machine reboot."
              initial={settings.data.restartTemplate ?? DEFAULT_RESTART_TEMPLATE}
              defaultText={DEFAULT_RESTART_TEMPLATE}
              onSave={saveTemplate('restartTemplate')}
              pending={patch.isPending}
            />
          </>
        )}
      </div>

      <div className="mt-5">
        <SectionTitle>Tab title</SectionTitle>
        {settings.data && (
          <TabTitleEditor
            key={`${profileId}:tab-title`}
            // `||`, not `??`: a stored '' also renders as the default, so the
            // field must show the template actually in effect.
            initial={settings.data.tabTitleTemplate || DEFAULT_TAB_TITLE_TEMPLATE}
            onSave={saveTemplate('tabTitleTemplate')}
            pending={patch.isPending}
          />
        )}
      </div>

      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) {
            setConfirming(false);
            setTyped('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-5 text-danger" />
              Run agents without permission prompts?
            </DialogTitle>
            <DialogDescription asChild>
              <div className="flex flex-col gap-2 text-sm">
                <p>
                  A prompt-free agent acts unattended, with your credentials, inside its worktree —
                  and nothing technically stops a shell command from reaching outside it. It can:
                </p>
                <ul className="list-disc pl-5 text-fg-secondary">
                  <li>run any shell command without asking first,</li>
                  <li>modify, delete, or exfiltrate files your user can reach,</li>
                  <li>install dependencies and execute the network requests they make,</li>
                  <li>push branches or call remote APIs with the credentials it finds.</li>
                </ul>
                <p>
                  Only open this gate if every account you opt in runs work you would trust a
                  colleague to run unsupervised on this machine.
                </p>
                <p className="text-fg-muted">
                  Opening it also records the agent&rsquo;s own bypass-permissions acceptance for
                  this profile&rsquo;s accounts, so the skip actually takes effect.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm-name">
              Type <span className="text-fg">{profile?.name}</span> to confirm
            </Label>
            <Input
              id="confirm-name"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirming(false);
                setTyped('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={typed !== profile?.name || patch.isPending}
              onClick={() => setGate(true)}
            >
              Open the gate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
