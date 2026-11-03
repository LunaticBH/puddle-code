import { CompilationSection } from './compilation';
import { Input } from '../../../components/ui/input';
import { Switch } from '../../../components/ui/switch';
import { updateClientSettings, useClientSettings } from '../../../lib/settings/client-settings';
import { hostParamStore } from '../../../lib/navigation/editor-links';
import { NumberField, SectionTitle, SettingRow } from '../parts';

/**
 * Editor settings (SPEC §11): client Monaco knobs plus the
 * vscode://`/`cursor:// deep-link host. Terminal and daemon knobs live under
 * Sessions. Compilation defaults belong to the selected profile on the host.
 */
export function EditorSection() {
  const settings = useClientSettings();

  return (
    <div>
      <SectionTitle>Editor</SectionTitle>
      <SettingRow label="Tab size" description="Spaces per indent level." htmlFor="tab-size">
        <NumberField
          id="tab-size"
          min={1}
          max={8}
          className="w-20 tabular-nums"
          value={settings.editorTabSize}
          onCommit={(editorTabSize) => updateClientSettings({ editorTabSize })}
        />
      </SettingRow>
      <SettingRow label="Word wrap" htmlFor="word-wrap">
        <Switch
          id="word-wrap"
          checked={settings.editorWordWrap}
          onCheckedChange={(checked) => updateClientSettings({ editorWordWrap: checked })}
        />
      </SettingRow>
      <SettingRow
        label="SSH host for editor links"
        description="Used for vscode:// and cursor:// remote links until the CLI supplies it automatically."
        htmlFor="editor-link-host"
      >
        <Input
          id="editor-link-host"
          type="text"
          // When a tunnelled host is already in effect (the ?host= boot param),
          // an empty field falls back to it — show that, not a generic hint.
          placeholder={hostParamStore.get() ?? 'user@host'}
          className="w-48"
          value={settings.editorLinkSshHost}
          onChange={(e) => updateClientSettings({ editorLinkSshHost: e.target.value })}
        />
      </SettingRow>
      <CompilationSection />
    </div>
  );
}
