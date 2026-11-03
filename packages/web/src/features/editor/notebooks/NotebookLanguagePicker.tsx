import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { monaco } from '../monaco/monaco-setup';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
} from '../../../components/ui/command';

export function NotebookLanguagePicker({
  language,
  onChange,
}: {
  language: string;
  onChange: (language: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const languages = [
    'markdown',
    'raw',
    ...monaco.languages
      .getLanguages()
      .map((item) => item.id)
      .filter((id) => id !== 'markdown')
      .sort(),
  ];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Cell language: ${language}`}
          className="flex cursor-pointer items-center gap-1 font-mono text-xs text-fg-muted hover:text-fg"
        >
          {language}
          <ChevronDown className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <Command>
          <CommandInput placeholder="Find a language…" />
          <CommandList>
            <CommandEmpty>No matching languages</CommandEmpty>
            {languages.map((id) => (
              <CommandItem
                key={id}
                onSelect={() => {
                  onChange(id);
                  setOpen(false);
                }}
              >
                {id}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
        <p className="px-3 py-2 text-xs text-fg-muted">
          Code languages set highlighting. Execution uses the notebook kernel.
        </p>
      </PopoverContent>
    </Popover>
  );
}
