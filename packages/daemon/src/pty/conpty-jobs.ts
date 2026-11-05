import { spawn, type ChildProcess } from 'node:child_process';
import { win32 } from 'node:path';
import { createInterface } from 'node:readline';
import { system32Path } from '@puddle/shared/node/platform';

/**
 * A kill-on-close job object per ConPTY (docs/windows.md, decision 8).
 *
 * A Windows process stays in its job whatever happens to its parent, so a
 * job holds what the process table cannot follow: a server started through
 * `cmd /c start`, PowerShell's `Start-Process` or a short-lived detaching
 * process, whose parent has exited. Each PTY root is put in a job of its own
 * just after `pty.spawn`, and everything it starts from then on joins it.
 * Ending the job ends all of them at once; and the jobs are kill-on-close, so
 * when the daemon dies, however it dies, its job host dies with it (Node
 * ends its non-detached children with it) and Windows ends every process
 * still in any of the jobs.
 *
 * Node has no job object API, so the jobs live in one hidden Windows
 * PowerShell 5.1 process per daemon, running a small C# class (`Add-Type`,
 * compiled by the .NET Framework that ships with Windows) that answers
 * requests on stdin. It starts in about half a second; an assignment takes a
 * few milliseconds. What a root starts before its assignment, or with
 * CREATE_BREAKAWAY_FROM_JOB (which the jobs allow, so that no programme
 * asking for it fails), is outside the job: the process table's tree still
 * covers it (conpty-teardown.ts). A job never outlives the host's handle,
 * so the host is never restarted while it holds one, and never stopped by a
 * request that is slow to answer.
 */

export interface ConptyJob {
  /**
   * Ends every process still in the job at once and waits, up to a second,
   * until they have exited; resolves with how many were running, 0 when the
   * job was already ended. Never rejects.
   */
  end(): Promise<number>;
}

export interface ConptyJobs {
  /**
   * Puts process `pid` in a new kill-on-close job, provided it was created
   * between `fromMs` and `toMs` (Unix ms): a process created at any other
   * time holds a pid the PTY's root has given up. Resolves null when it
   * could not: the process has exited, the host is not available, or it did
   * not answer in time. Never rejects.
   */
  assign(pid: number, createdWithin: { fromMs: number; toMs: number }): Promise<ConptyJob | null>;
  /** Resolves once the host can take assignments, or cannot start; never rejects. */
  ready(): Promise<boolean>;
}

/** The C# side: one request per stdin line, `<seq> <verb> <args...>`, one reply line each. */
const JOBS_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PuddleConptyJobs
{
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Accounting
    {
        public long TotalUserTime, TotalKernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    const uint TERMINATE = 0x0001, SET_QUOTA = 0x0100, QUERY_LIMITED = 0x1000;
    const uint BREAKAWAY_OK = 0x0800, KILL_ON_JOB_CLOSE = 0x2000;
    const long UNIX_EPOCH = 116444736000000000L;

    static readonly Dictionary<string, IntPtr> jobs = new Dictionary<string, IntPtr>();

    public static void Serve()
    {
        var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        output.NewLine = "\n";
        output.AutoFlush = true;
        output.WriteLine("ready");
        string line;
        // End of input: the daemon has gone. Returning closes every job,
        // which ends whatever is still in them.
        while ((line = input.ReadLine()) != null)
        {
            var f = line.Split(' ');
            string reply;
            try { reply = Handle(f); }
            catch (Exception error) { reply = "error " + error.GetType().Name; }
            output.WriteLine(f[0] + " " + reply);
        }
    }

    static string Handle(string[] f)
    {
        if (f.Length == 5 && f[1] == "assign") return Assign(f[0], int.Parse(f[2]), long.Parse(f[3]), long.Parse(f[4]));
        if (f.Length == 3 && f[1] == "end") return End(f[2]);
        return "error usage";
    }

    static string Assign(string id, int pid, long fromMs, long toMs)
    {
        IntPtr process = OpenProcess(SET_QUOTA | TERMINATE | QUERY_LIMITED, false, pid);
        if (process == IntPtr.Zero) return "gone " + Marshal.GetLastWin32Error();
        try
        {
            long created, exited, kernel, user;
            if (!GetProcessTimes(process, out created, out exited, out kernel, out user)) return "gone " + Marshal.GetLastWin32Error();
            if (exited != 0) return "gone 0";
            long createdMs = (created - UNIX_EPOCH) / 10000;
            if (createdMs < fromMs || createdMs > toMs) return "other " + createdMs;
            IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
            if (job == IntPtr.Zero) return "refused " + Marshal.GetLastWin32Error();
            var limits = new ExtendedLimits();
            limits.Basic.LimitFlags = KILL_ON_JOB_CLOSE | BREAKAWAY_OK;
            if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))) ||
                !AssignProcessToJobObject(job, process))
            {
                int code = Marshal.GetLastWin32Error();
                CloseHandle(job);
                return "refused " + code;
            }
            jobs[id] = job;
            return "ok " + createdMs;
        }
        finally { CloseHandle(process); }
    }

    static uint Active(IntPtr job)
    {
        Accounting info;
        return QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero) ? info.ActiveProcesses : 0;
    }

    static string End(string id)
    {
        IntPtr job;
        if (!jobs.TryGetValue(id, out job)) return "ok 0";
        uint active = Active(job);
        TerminateJobObject(job, 1);
        for (int waited = 0; waited < 1000 && Active(job) > 0; waited += 10) Thread.Sleep(10);
        jobs.Remove(id);
        CloseHandle(job);
        return "ok " + active;
    }
}
`;

const HOST_SCRIPT =
  "$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'\n" +
  `Add-Type -TypeDefinition @'\n${JOBS_SOURCE}\n'@\n` +
  '[PuddleConptyJobs]::Serve()\n';

/** The host's arguments to Windows PowerShell 5.1. */
export const JOB_HOST_ARGS: readonly string[] = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
  Buffer.from(HOST_SCRIPT, 'utf16le').toString('base64'),
];

/** Whether `commandLine` is a ConPTY job host's (the test suites' process guard leaves it be). */
export function isConptyJobHost(commandLine: string): boolean {
  return commandLine.includes(JOB_HOST_ARGS[JOB_HOST_ARGS.length - 1]!);
}

export interface JobHostOptions {
  /** The host to run; Windows PowerShell 5.1 with JOB_HOST_ARGS by default. Tests substitute a fake. */
  worker?: { file: string; args: readonly string[] };
  /** Bound on the host's start (PowerShell and the compile); 15 s by default. */
  startMs?: number;
  /** Bound on one answer, after which that request counts as failed; 5 s by default. */
  answerMs?: number;
  /** Told once when a host that held jobs exits: every process in them has ended with it. */
  onLost?: (reason: string) => void;
}

/** How long after a host that could not start (no PowerShell, `Add-Type` refused) none is tried. */
const RETRY_MS = 5 * 60_000;

/**
 * The daemon's job host (see the module comment). It is started on first
 * use, or by `ready()`. Its handles hold the event loop only while it starts
 * or a request is outstanding, so an idle host never keeps the daemon alive.
 */
export class JobHost implements ConptyJobs {
  private readonly worker: { file: string; args: readonly string[] };
  private readonly startMs: number;
  private readonly answerMs: number;
  private readonly onLost: ((reason: string) => void) | undefined;
  private child: ChildProcess | null = null;
  private started: Promise<boolean> | null = null;
  private starting = false;
  /** A host that never became ready is not tried again before this. */
  private retryAfter = 0;
  private sequence = 0;
  /** Which host this is: a job is only ever ended by the host that holds it. */
  private generation = 0;
  /** Jobs assigned and not yet ended. */
  private held = 0;
  private readonly waiting = new Map<string, (reply: string | null) => void>();

  constructor(options: JobHostOptions = {}) {
    this.worker = options.worker ?? {
      file: system32Path(win32.join('WindowsPowerShell', 'v1.0', 'powershell.exe')),
      args: JOB_HOST_ARGS,
    };
    this.startMs = options.startMs ?? 15_000;
    this.answerMs = options.answerMs ?? 5_000;
    this.onLost = options.onLost;
  }

  /** The host's pid while it runs (tests). */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  ready(): Promise<boolean> {
    // A host that has exited holds no job any more: a new one may start.
    if (this.started && !this.child && !this.starting && Date.now() >= this.retryAfter) {
      this.started = null;
    }
    return (this.started ??= this.start());
  }

  async assign(
    pid: number,
    createdWithin: { fromMs: number; toMs: number },
  ): Promise<ConptyJob | null> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const request = this.request(
      `assign ${pid} ${Math.floor(createdWithin.fromMs)} ${Math.ceil(createdWithin.toMs)}`,
    );
    if (!(await request.reply)?.startsWith('ok ')) return null;
    const generation = this.generation;
    this.held++;
    let ended: Promise<number> | null = null;
    return {
      end: () =>
        (ended ??=
          // A host that has exited took its jobs' processes with it.
          generation !== this.generation || this.child === null
            ? Promise.resolve(0)
            : this.request(`end ${request.id}`).reply.then((answer) => {
                if (generation === this.generation) this.held--;
                const count = answer?.startsWith('ok ') ? Number(answer.slice(3)) : 0;
                return Number.isSafeInteger(count) ? count : 0;
              })),
    };
  }

  private request(command: string): { id: string; reply: Promise<string | null> } {
    const id = String(++this.sequence);
    const reply = this.ready().then((up) => {
      const child = this.child;
      if (!up || child === null) return null;
      return new Promise<string | null>((resolve) => {
        // A slow answer fails this request only: stopping the host would end every job.
        const timer = setTimeout(() => settle(null), this.answerMs);
        const settle = (answer: string | null) => {
          clearTimeout(timer);
          this.waiting.delete(id);
          this.reference();
          resolve(answer);
        };
        this.waiting.set(id, settle);
        this.reference();
        child.stdin!.write(`${id} ${command}\n`, (err) => {
          if (err) settle(null);
        });
      });
    });
    return { id, reply };
  }

  private start(): Promise<boolean> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(this.worker.file, [...this.worker.args], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        resolve(false);
        return;
      }
      this.child = child;
      this.generation++;
      this.starting = true;
      let up = false;
      let gone = false;
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        if (!this.starting) return;
        this.starting = false;
        up = ok;
        this.reference();
        resolve(ok);
      };
      // Until it is ready it holds no job: stopping it then ends nothing.
      const timer = setTimeout(() => {
        child.kill();
        if (this.child === child) this.child = null;
        this.retryAfter = Date.now() + RETRY_MS;
        finish(false);
      }, this.startMs);
      let stderr = '';
      child.stderr!.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-2048);
      });
      child.stdin!.on('error', () => {});
      child.stdout!.on('error', () => {});
      child.stderr!.on('error', () => {});
      createInterface({ input: child.stdout! }).on('line', (line) => {
        if (!up) {
          if (line === 'ready') finish(true);
          return;
        }
        const space = line.indexOf(' ');
        if (space > 0) this.waiting.get(line.slice(0, space))?.(line.slice(space + 1));
      });
      const exited = (reason: string) => {
        if (gone) return;
        gone = true;
        if (this.child === child) this.child = null;
        if (!up) this.retryAfter = Date.now() + RETRY_MS;
        finish(false);
        for (const settle of [...this.waiting.values()]) settle(null);
        if (this.held > 0) {
          this.held = 0;
          this.onLost?.(`${reason}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
        }
      };
      child.on('error', (err) => exited(err.message));
      child.on('exit', (code) => exited(`exit code ${String(code)}`));
      this.reference();
    });
  }

  private reference(): void {
    const child = this.child;
    if (!child) return;
    const on = this.starting || this.waiting.size > 0;
    const handles = [child, child.stdin, child.stdout, child.stderr];
    for (const handle of handles as Array<{ ref?: () => void; unref?: () => void } | null>) {
      if (on) handle?.ref?.();
      else handle?.unref?.();
    }
  }
}

let shared: JobHost | null = null;

/** This process's job host, shared by every PtyManager in it. */
export function sharedConptyJobs(): ConptyJobs {
  return (shared ??= new JobHost({
    onLost: (reason) =>
      console.warn(`the ConPTY job host exited (${reason}); its PTYs have ended with it`),
  }));
}
