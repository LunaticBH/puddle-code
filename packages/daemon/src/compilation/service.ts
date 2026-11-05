import {
  compilationFailureDetailsSchema,
  type CompilationFailure,
  type CompilationDefaultsRequest,
  type CompilationDefaultsResponse,
  type UpdateCompilationDefaultsRequest,
  type CompilationCapabilitiesResponse,
  type CompilationFileTarget,
  type CompilationModeRequest,
  type CompilationRunRequest,
  type CompilationRunResponse,
  type CompilationSettingsRequest,
  type CompilationSettingsResponse,
  type CompilationStatusResponse,
  type CompilationTargetRequest,
  type CompilationMode,
  type UpdateCompilationSettingsRequest,
} from '@puddle/shared';
import type { CompilationSettingsStore } from '../db/stores/compilation-settings.js';
import type { ProfileStore } from '../db/stores/profiles.js';
import type { ProjectStore } from '../db/stores/projects.js';
import { ApiError } from '../http/errors.js';
import {
  descriptorOf,
  extensionOf,
  type CompilationProvider,
  type CompilationProviderResult,
} from './provider.js';
import { disposeCompilationCommands } from './process.js';
import { DependencyWatcher } from './dependency-watcher.js';

const WATCH_IDLE_TTL_MS = 6 * 60 * 60 * 1_000;
/** How long dispose waits for running commands' stops (a few table reads on Windows). */
const COMMAND_STOP_WAIT_MS = 5_000;

export type CompilationEvent =
  | { type: 'started'; key: string; status: CompilationStatusResponse }
  | { type: 'completed'; key: string; status: CompilationStatusResponse }
  | { type: 'failed'; key: string; status: CompilationStatusResponse };

interface TargetState {
  key: string;
  provider: CompilationProvider;
  source: CompilationFileTarget;
  status: CompilationStatusResponse;
  watcher: DependencyWatcher;
  running: Promise<CompilationRunResponse> | null;
  dirty: boolean;
  lastTouched: number;
  profileId: string | null;
  projectId: string | null;
}

interface CompilationServiceDeps {
  settings: CompilationSettingsStore;
  projects: ProjectStore;
  profiles: ProfileStore;
}

/**
 * Provider-neutral on-demand/eager orchestration. Eager sources observe their
 * dependency directories, which catches both in-place writes and the atomic
 * replacement used by editors and coding agents.
 */
export class CompilationService {
  private readonly providers = new Map<string, CompilationProvider>();
  private readonly targets = new Map<string, TargetState>();
  private readonly listeners = new Set<(event: CompilationEvent) => void>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(
    providers: readonly CompilationProvider[],
    private readonly deps?: CompilationServiceDeps,
  ) {
    for (const provider of providers) {
      if (this.providers.has(provider.id))
        throw new Error(`duplicate compiler provider ${provider.id}`);
      this.providers.set(provider.id, provider);
    }
    this.sweepTimer = setInterval(() => this.sweepIdleWatches(), 30 * 60 * 1_000);
    this.sweepTimer.unref();
  }

  capabilities(): CompilationCapabilitiesResponse {
    return { providers: [...this.providers.values()].map(descriptorOf) };
  }

  async run(request: CompilationRunRequest): Promise<CompilationRunResponse> {
    const state = this.target(request);
    state.lastTouched = Date.now();
    return this.execute(state, 'on_demand');
  }

  async setMode(request: CompilationModeRequest): Promise<CompilationStatusResponse> {
    const state = this.target(request);
    state.lastTouched = Date.now();
    if (request.mode === 'on_demand') {
      state.status = { ...state.status, mode: 'on_demand' };
      state.watcher.close();
      return state.status;
    }
    if (!state.provider.eager) {
      throw ApiError.badRequest(
        'eager_compilation_unsupported',
        `${state.provider.displayName} does not support eager compilation`,
      );
    }
    state.status = { ...state.status, mode: 'eager' };
    // Install the provider's entry-point watchers before compiling: a broken
    // first build must remain live and retry when an editor or agent fixes it.
    state.watcher.replace(state.provider.watchInputs(state.source));
    // Registration includes an initial build, so restoring an eager tab never
    // waits for another filesystem event before it has a preview.
    await this.execute(state, 'eager');
    return state.status;
  }

  defaults(request: CompilationDefaultsRequest): CompilationDefaultsResponse {
    this.requireDeps().profiles.get(request.profile_id);
    const provider = this.defaultProvider(request.provider);
    const configuration = provider.languageConfiguration();
    const modes: CompilationMode[] = provider.eager ? ['on_demand', 'eager'] : ['on_demand'];
    return {
      provider: provider.id,
      display_name: provider.displayName,
      variables: configuration.variables,
      commands: modes.map((mode) => ({
        mode,
        run_when: mode === 'on_demand' ? 'when_clicked' : 'upon_file_change',
        default_command: configuration.defaults[mode] ?? null,
        override_command: this.requireSettings().getDefault(request.profile_id, provider.id, mode),
      })),
    };
  }

  updateDefaults(request: UpdateCompilationDefaultsRequest): CompilationDefaultsResponse {
    this.requireDeps().profiles.get(request.profile_id);
    const provider = this.defaultProvider(request.provider);
    if (request.mode === 'eager' && !provider.eager) {
      throw ApiError.badRequest(
        'eager_compilation_unsupported',
        `${provider.displayName} does not support eager compilation`,
      );
    }
    if (request.command !== null) provider.validateCommand(null, request.command);
    this.requireSettings().setDefault(
      request.profile_id,
      provider.id,
      request.mode,
      request.command,
    );
    return this.defaults(request);
  }

  private defaultProvider(id: string): CompilationProvider {
    const provider = this.providers.get(id);
    if (!provider)
      throw ApiError.badRequest('compiler_not_supported', `Unknown compilation provider: ${id}`);
    return provider;
  }

  settings(request: CompilationSettingsRequest): CompilationSettingsResponse {
    const provider = this.selectProvider(request.source, request.provider);
    const configuration = provider.commandConfiguration(request.source);
    this.validateScope(request.profile_id, request.project_id);
    const modes: CompilationMode[] = provider.eager ? ['on_demand', 'eager'] : ['on_demand'];
    return {
      provider: provider.id,
      display_name: provider.displayName,
      file_type: configuration.fileType,
      file_path: configuration.filePath,
      variables: configuration.variables,
      commands: modes.map((mode) => ({
        mode,
        run_when: mode === 'on_demand' ? 'when_clicked' : 'upon_file_change',
        default_command: configuration.defaults[mode] ?? null,
        inherited_command: this.requireSettings().getDefault(request.profile_id, provider.id, mode),
        override_command: this.settingFor(
          request.profile_id,
          request.project_id,
          provider.id,
          configuration.fileType,
          configuration.filePath,
          mode,
        ),
      })),
    };
  }

  updateSettings(request: UpdateCompilationSettingsRequest): CompilationSettingsResponse {
    const provider = this.selectProvider(request.source, request.provider);
    if (request.mode === 'eager' && !provider.eager) {
      throw ApiError.badRequest(
        'eager_compilation_unsupported',
        `${provider.displayName} does not support eager compilation`,
      );
    }
    const configuration = provider.commandConfiguration(request.source);
    this.validateScope(request.profile_id, request.project_id);
    if (request.command !== null) provider.validateCommand(request.source, request.command);
    this.requireSettings().set(
      {
        profileId: request.profile_id,
        projectId: request.project_id,
        provider: provider.id,
        fileType: configuration.fileType,
        filePath: configuration.filePath,
        mode: request.mode,
      },
      request.command,
    );
    return this.settings(request);
  }

  status(request: CompilationTargetRequest): CompilationStatusResponse {
    const state = this.target(request);
    state.lastTouched = Date.now();
    return state.status;
  }

  subscribe(listener: (event: CompilationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Closes the service and stops every running command. Resolves once those
   * stops have been carried out, or after COMMAND_STOP_WAIT_MS: on Windows a
   * stop reads the process table before it ends anything, and a daemon that
   * exited sooner would leave a command's descendants running
   * (disposeCompilationCommands). POSIX signals at once. Never rejects.
   */
  dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.sweepTimer);
    for (const state of this.targets.values()) {
      state.status = { ...state.status, mode: 'on_demand' };
      state.watcher.close();
    }
    for (const provider of this.providers.values()) provider.dispose?.();
    const stopping = disposeCompilationCommands();
    this.targets.clear();
    this.listeners.clear();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, COMMAND_STOP_WAIT_MS);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      stopping.then(done, done);
    });
  }

  private target(request: CompilationTargetRequest): TargetState {
    const provider = this.selectProvider(request.source, request.provider);
    const key = targetKey(provider.id, request);
    const existing = this.targets.get(key);
    if (existing) return existing;
    const watcher = new DependencyWatcher(() => {
      const current = this.targets.get(key);
      if (!current) return;
      current.lastTouched = Date.now();
      void this.execute(current, 'eager').catch(() => undefined);
    });
    const state: TargetState = {
      key,
      provider,
      source: request.source,
      status: {
        provider: provider.id,
        mode: 'on_demand',
        state: 'idle',
        revision: 0,
        result: null,
        error: null,
      },
      watcher,
      running: null,
      dirty: false,
      lastTouched: Date.now(),
      profileId: request.profile_id ?? null,
      projectId: request.project_id ?? null,
    };
    this.targets.set(key, state);
    return state;
  }

  private selectProvider(source: CompilationFileTarget, providerId?: string): CompilationProvider {
    const provider = providerId
      ? this.providers.get(providerId)
      : [...this.providers.values()].find((candidate) =>
          candidate.extensions.includes(extensionOf(source.path)),
        );
    if (!provider) {
      throw ApiError.badRequest(
        'compiler_not_supported',
        `No compiler provider supports ${source.path}`,
      );
    }
    return provider;
  }

  private execute(state: TargetState, mode: CompilationMode): Promise<CompilationRunResponse> {
    if (this.disposed)
      throw ApiError.conflict('compiler_disposed', 'Compilation service is closed');
    if (state.running) {
      if (state.status.mode === 'eager') state.dirty = true;
      return state.running;
    }
    if (!state.provider.capability().available) {
      throw new ApiError(
        424,
        'compiler_not_installed',
        `${state.provider.displayName} is not available on the daemon host`,
      );
    }
    const revision = state.status.revision + 1;
    state.status = {
      ...state.status,
      state: 'running',
      revision,
      error: null,
    };
    this.emit({ type: 'started', key: state.key, status: state.status });
    const command = this.commandOverride(state, mode);
    state.running = state.provider
      .run(state.source, {
        mode,
        command,
        ...(state.provider.terminal
          ? {
              ...(state.projectId ? { projectId: state.projectId } : {}),
              ...(state.profileId ? { profileId: state.profileId } : {}),
            }
          : {}),
      })
      .then((product) => {
        const result = responseOf(state.provider, product, revision);
        state.status = {
          ...state.status,
          state: 'succeeded',
          revision,
          result,
          error: null,
        };
        if (state.status.mode === 'eager') state.watcher.replace(product.dependencies);
        this.emit({ type: 'completed', key: state.key, status: state.status });
        return result;
      })
      .catch((error: unknown) => {
        const failure = failureOf(error);
        state.status = {
          ...state.status,
          state: 'failed',
          revision,
          error: failure,
        };
        this.emit({ type: 'failed', key: state.key, status: state.status });
        throw error;
      })
      .finally(() => {
        state.running = null;
        if (state.dirty && state.status.mode === 'eager') {
          state.dirty = false;
          void this.execute(state, 'eager').catch(() => undefined);
        }
      });
    return state.running;
  }

  private sweepIdleWatches(): void {
    const cutoff = Date.now() - WATCH_IDLE_TTL_MS;
    for (const [key, state] of this.targets) {
      if (state.running || state.lastTouched >= cutoff) continue;
      state.watcher.close();
      this.targets.delete(key);
    }
  }

  private emit(event: CompilationEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private commandOverride(state: TargetState, mode: CompilationMode): string | null {
    if (!state.profileId || !this.deps) return null;
    this.deps.profiles.get(state.profileId);
    if (!state.projectId)
      return this.requireSettings().getDefault(state.profileId, state.provider.id, mode);
    this.validateScope(state.profileId, state.projectId);
    const configuration = state.provider.commandConfiguration(state.source);
    return (
      this.settingFor(
        state.profileId,
        state.projectId,
        state.provider.id,
        configuration.fileType,
        configuration.filePath,
        mode,
      ) ?? this.requireSettings().getDefault(state.profileId, state.provider.id, mode)
    );
  }

  private settingFor(
    profileId: string,
    projectId: string,
    provider: string,
    fileType: string,
    filePath: string,
    mode: CompilationMode,
  ): string | null {
    return this.requireSettings().get({
      profileId,
      projectId,
      provider,
      fileType,
      filePath,
      mode,
    });
  }

  private validateScope(profileId: string, projectId: string): void {
    const project = this.requireDeps().projects.get(projectId);
    if (project.profile_id !== profileId) {
      throw ApiError.badRequest(
        'compilation_scope_mismatch',
        'Compilation project does not belong to the selected profile',
      );
    }
  }

  private requireSettings(): CompilationSettingsStore {
    return this.requireDeps().settings;
  }

  private requireDeps(): CompilationServiceDeps {
    if (!this.deps) {
      throw ApiError.conflict(
        'compilation_settings_unavailable',
        'Compilation settings are unavailable in this daemon',
      );
    }
    return this.deps;
  }
}

function failureOf(error: unknown): CompilationFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof ApiError)) return { message };
  const details = compilationFailureDetailsSchema.safeParse(error.details);
  return details.success ? { message, ...details.data } : { message };
}

function responseOf(
  provider: CompilationProvider,
  product: CompilationProviderResult,
  revision: number,
): CompilationRunResponse {
  return {
    provider: provider.id,
    executor: product.executor,
    revision,
    source: product.source,
    artifacts: product.artifacts,
    ...(product.terminal ? { terminal: product.terminal } : {}),
    ...(product.navigation ? { navigation: product.navigation } : {}),
  };
}

function targetKey(provider: string, request: CompilationTargetRequest): string {
  return JSON.stringify([
    provider,
    request.profile_id ?? null,
    request.project_id ?? null,
    request.source.session,
    request.source.root ?? null,
    request.source.path,
  ]);
}
