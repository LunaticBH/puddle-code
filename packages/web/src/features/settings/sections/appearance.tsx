import { useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select';
import { Switch } from '../../../components/ui/switch';
import { updateClientSettings, useClientSettings } from '../../../lib/settings/client-settings';
import { CURSOR_PACKAGES, type CursorPackageId } from '../../../lib/appearance/cursor-packages';
import { applyTheme, storedPreference, type ThemePreference } from '../../../lib/appearance/theme';
import { NumberField, SectionTitle, SettingRow } from '../parts';

export function AppearanceSection() {
  const settings = useClientSettings();
  const [themePref, setThemePref] = useState<ThemePreference>(storedPreference());

  return (
    <div>
      <SectionTitle>Appearance</SectionTitle>
      <SettingRow label="Theme">
        <Select
          value={themePref}
          onValueChange={(value) => {
            setThemePref(value as ThemePreference);
            applyTheme(value as ThemePreference);
          }}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="dark">Dark</SelectItem>
            <SelectItem value="light">Light</SelectItem>
            <SelectItem value="system">System</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow label="Cursor style">
        <Select
          value={settings.cursorPackage}
          onValueChange={(value) =>
            updateClientSettings({ cursorPackage: value as CursorPackageId })
          }
        >
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CURSOR_PACKAGES.map((cursorPackage) => (
              <SelectItem key={cursorPackage.id} value={cursorPackage.id}>
                {cursorPackage.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow label="UI font size" htmlFor="ui-font-size">
        <NumberField
          id="ui-font-size"
          min={12}
          max={24}
          step={0.5}
          className="w-20 tabular-nums"
          value={settings.uiFontSize}
          onCommit={(uiFontSize) => updateClientSettings({ uiFontSize })}
        />
      </SettingRow>
      <SettingRow label="Terminal font size" htmlFor="terminal-font-size">
        <NumberField
          id="terminal-font-size"
          min={9}
          max={24}
          className="w-20 tabular-nums"
          value={settings.terminalFontSize}
          onCommit={(terminalFontSize) => updateClientSettings({ terminalFontSize })}
        />
      </SettingRow>
      <SettingRow label="Editor font size" htmlFor="editor-font-size">
        <NumberField
          id="editor-font-size"
          min={9}
          max={32}
          step={0.5}
          className="w-20 tabular-nums"
          value={settings.editorFontSize}
          onCommit={(editorFontSize) => updateClientSettings({ editorFontSize })}
        />
      </SettingRow>
      <SettingRow label="Density">
        <Select
          value={settings.density}
          onValueChange={(value) =>
            updateClientSettings({ density: value as 'compact' | 'comfortable' })
          }
        >
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="compact">Compact</SelectItem>
            <SelectItem value="comfortable">Comfortable</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        label="Project-based layout"
        description="Editor layouts are separated across projects."
        htmlFor="project-based-layout"
      >
        <Switch
          id="project-based-layout"
          checked={settings.projectBasedLayout}
          onCheckedChange={(checked) => updateClientSettings({ projectBasedLayout: checked })}
        />
      </SettingRow>
      <SettingRow
        label="All projects in the session list"
        description="Right sidebar displays sessions from all projects."
        htmlFor="show-all-project-sessions"
      >
        <Switch
          id="show-all-project-sessions"
          checked={settings.showAllProjectSessions}
          onCheckedChange={(checked) => updateClientSettings({ showAllProjectSessions: checked })}
        />
      </SettingRow>
    </div>
  );
}
