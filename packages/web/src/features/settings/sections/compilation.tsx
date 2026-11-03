import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CompilationDefaultsRequest } from '@puddle/shared';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select';
import {
  updateCompilationDefaults,
  useCompilationCapabilities,
  useCompilationDefaults,
} from '../../../lib/queries/compilation-queries';
import { compilationDefaultsSupported } from '../../../lib/transport/protocol-support';
import { useDaemonVersion } from '../../../lib/queries/queries';
import { CompilationCommandForm } from '../../editor/compilation/CompilationCommandForm';
import { useCurrentProfileId } from '../../profile/profile-store';
import { SectionTitle, SettingRow } from '../parts';

/** Host-side defaults for the selected profile; file overrides use the same form. */
export function CompilationSection() {
  const profileId = useCurrentProfileId();
  const version = useDaemonVersion();
  const supported = compilationDefaultsSupported(version.data?.protocol);
  const capabilities = useCompilationCapabilities(supported && profileId !== null);
  const [selected, setSelected] = useState<string | null>(null);
  const providers = capabilities.data?.providers ?? [];
  const provider = providers.find((candidate) => candidate.id === selected) ?? providers[0];

  if (!supported || !profileId) return null;
  return (
    <div className="mt-8">
      <SectionTitle note="Defaults for this profile on the connected host. Individual files can override them from their tab menu.">
        Compilation & running code
      </SectionTitle>
      {capabilities.isLoading ? (
        <p className="text-sm text-fg-muted">Loading languages…</p>
      ) : capabilities.isError ? (
        <p role="alert" className="text-sm text-danger">
          Couldn’t load languages.
        </p>
      ) : provider ? (
        <>
          <SettingRow label="Language" htmlFor="compilation-language">
            <Select value={provider.id} onValueChange={setSelected}>
              <SelectTrigger id="compilation-language" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providers.map((candidate) => (
                  <SelectItem
                    key={candidate.id}
                    value={candidate.id}
                    detail={candidate.available ? undefined : 'Not installed'}
                  >
                    {candidate.display_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
          {!provider.available && (
            <p className="mb-4 text-xs text-fg-muted">
              No supported {provider.display_name} tool is installed on this host. Saved commands
              apply when a supported tool is available.
            </p>
          )}
          <LanguageCommands
            key={`${profileId}:${provider.id}`}
            request={{ profile_id: profileId, provider: provider.id }}
          />
        </>
      ) : (
        <p className="text-sm text-fg-muted">No languages advertised by this host.</p>
      )}
    </div>
  );
}

function LanguageCommands({ request }: { request: CompilationDefaultsRequest }) {
  const settings = useCompilationDefaults(request);
  const queryClient = useQueryClient();
  if (settings.isLoading) return <p className="text-sm text-fg-muted">Loading commands…</p>;
  if (settings.isError)
    return (
      <p role="alert" className="text-sm text-danger">
        {settings.error instanceof Error ? settings.error.message : 'Couldn’t load commands'}
      </p>
    );
  if (!settings.data) return null;
  return (
    <CompilationCommandForm
      settings={settings.data}
      onSave={async (changes) => {
        for (const change of changes) {
          const latest = await updateCompilationDefaults({ ...request, ...change });
          queryClient.setQueryData(['compilation-defaults', request], latest);
          // Open file settings must immediately reflect their new inherited default.
          await queryClient.invalidateQueries({ queryKey: ['compilation-settings'] });
        }
      }}
    />
  );
}
