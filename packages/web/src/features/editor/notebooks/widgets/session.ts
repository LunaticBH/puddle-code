import {
  mergeWidgetMessage,
  notebookWidgetsResponseSchema,
  type CompilationFileTarget,
  type NotebookWidgetComm,
  type NotebookWidgetState,
  type NotebookWidgetsResponse,
} from '@puddle/shared';
import { api } from '../../../../lib/transport/api';

export const emptyWidgets = (): NotebookWidgetState => ({
  version_major: 2,
  version_minor: 0,
  state: {},
});

/** One observer per notebook pane; writes are explicit and are never queued across reconnects. */
export class WidgetSession {
  state = emptyWidgets();
  current: NotebookWidgetsResponse = { generation: null, revision: 0, events: [] };
  private listeners = new Set<(update: NotebookWidgetsResponse) => void>();
  private stopped = false;
  private epoch = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly source: CompilationFileTarget,
    private readonly save: (state: NotebookWidgetState) => void,
  ) {}

  subscribe = (listener: (update: NotebookWidgetsResponse) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.current;
  start(): void {
    this.stopped = false;
    void this.poll(++this.epoch);
  }
  stop(): void {
    this.stopped = true;
    this.epoch++;
    clearTimeout(this.timer);
  }

  private publish(update: NotebookWidgetsResponse): void {
    this.current = update;
    for (const listener of this.listeners) listener(update);
  }

  private async poll(epoch: number): Promise<void> {
    try {
      const value = notebookWidgetsResponseSchema.parse(
        await api('POST', '/api/notebooks/widgets', {
          source: this.source,
          ...(this.current.generation
            ? { generation: this.current.generation, after: this.current.revision }
            : {}),
        }),
      );
      if (this.stopped || this.epoch !== epoch) return;
      if (value.generation !== this.current.generation) this.state = emptyWidgets();
      if (value.snapshot) this.state = value.snapshot;
      for (const event of value.events)
        this.state = { ...this.state, state: mergeWidgetMessage(this.state.state, event) };
      if (
        value.snapshot ||
        value.generation !== this.current.generation ||
        value.revision !== this.current.revision ||
        value.error !== this.current.error
      ) {
        this.publish(value);
        if (!value.error && Object.keys(this.state.state).length) this.save(this.state);
      }
    } catch (error) {
      if (!this.stopped && this.epoch === epoch)
        this.publish({
          generation: null,
          revision: 0,
          events: [],
          error: error instanceof Error ? error.message : 'Widget connection failed',
        });
    } finally {
      if (!this.stopped && this.epoch === epoch)
        this.timer = setTimeout(
          () => void this.poll(epoch),
          this.listeners.size && !document.hidden ? 250 : 1500,
        );
    }
  }

  async send(generation: string, message: NotebookWidgetComm['message']): Promise<void> {
    if (this.stopped || this.current.error || this.current.generation !== generation)
      throw new Error('The widget connection changed. This action was not sent.');
    await api('POST', '/api/notebooks/widgets/comm', { source: this.source, generation, message });
  }
}
