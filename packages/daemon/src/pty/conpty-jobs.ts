import { spawn, type ChildProcess } from 'node:child_process';
import { win32 } from 'node:path';
import { createInterface } from 'node:readline';
import { system32Path } from '@puddle/shared/node/platform';

/**
 * The ConPTY helper (docs/windows.md, decision 8): what tells the daemon
 * which processes are attached to each PTY's console, so that a PTY's end
 * ends exactly those, as a hang-up ends a POSIX terminal's session.
 *
 * Windows records, for every process, the console host it is attached to
 * (NtQueryInformationProcess, ProcessConsoleHostProcess; cleared when it
 * frees its console, but left as it was when the host is terminated, so it
 * counts only for a process created after the host), and a console lists
 * its own processes (GetConsoleProcessList, from a process attached to it
 * for a moment). A PTY's console host is the headless `conhost.exe` its
 * root runs in: the root names it; should the root have gone already, the
 * daemon, which notes every spawn, picks the one only this spawn could have
 * created (chooseHost). A process that left the console (a GUI programme
 * and all it starts, a detached process, one started in a console of its
 * own such as PowerShell's `Start-Process`) is not attached to it and is
 * never named here, as `nohup`, `setsid` and GUI launches survive a
 * hang-up; nor is a GUI programme that attached to it of its own accord,
 * or anything that programme started.
 *
 * The helper holds every process it names open (a SYNCHRONIZE handle), the
 * root and the console host from just after `pty.spawn` and each member
 * from when it was listed, so that a pid it names can never be another
 * process's by the time the daemon acts on it: it ends only processes it
 * holds. It runs no job objects: what it names is the console's, however a
 * process got there, and nothing it holds ends with it.
 *
 * Node has no API for any of this, so the helper is one hidden Windows
 * PowerShell 5.1 process per daemon (and one per supervisor) running a small
 * C# class (`Add-Type`, compiled by the .NET Framework that ships with
 * Windows; its source travels in an environment variable) that answers
 * requests on stdin, where numbers are all that cross. It starts in about
 * half a second; a request takes a few milliseconds. Where
 * it cannot run (Constrained Language Mode refuses `Add-Type`), the daemon
 * falls back on what node-pty itself can do (pty-manager.ts). Kept under
 * its first name, the job host's: `ConptyJobs` is what the daemon passes.
 */

/** A process attached to a PTY's console, held open by the helper. */
export interface ConsoleMember {
  pid: number;
  /** Its creation time, Unix ms, as Windows records it. */
  createdAtMs: number;
  /** Its key for `terminate`. */
  key: string;
  /** Its image is a GUI programme (PE subsystem 2): never ended. */
  gui: boolean;
  /**
   * A GUI programme started it, or one of its ancestors below the PTY's
   * root (one that attached to the console and started console
   * programmes in it): never ended either.
   */
  guiStarted: boolean;
  /**
   * The console host Windows last recorded for it: 0 for none, -1 when
   * Windows will not say. Windows leaves it as it was when a host is
   * terminated, so it names this console only for a process created after
   * the host was.
   */
  consoleHost: number;
  /** The console's own process list named it (only when the scan attached to it). */
  listed: boolean;
}

export interface ConsoleScan {
  rootAlive: boolean;
  hostAlive: boolean;
  /** Every process attached to the console, the root included while it runs. */
  members: ConsoleMember[];
}

/** One PTY as the helper holds it; every method never rejects. */
export interface ConptyConsole {
  /** The root's creation time; null when it had already exited, or its pid named another process. */
  readonly rootCreatedAtMs: number | null;
  /** The PTY's headless console host, held open; null when it could not be told apart. */
  readonly host: { pid: number; createdAtMs: number } | null;
  /** Whether the root and the console host still run; null when the helper did not answer. */
  alive(): Promise<{ root: boolean; host: boolean } | null>;
  /**
   * What is attached to the console now, each process held open from now on.
   * With `attach`, the helper also reads the console's own list, attaching
   * to it for a moment: never while the console is being closed, whose
   * close would end the helper with its members. While the host is not told
   * apart, it reads the root's console only when this PTY's spawn could have
   * created it (never the parent's, which a GUI root may attach to), and
   * names only what was created after that host. Null when it did not answer.
   */
  scan(options: { attach: boolean }): Promise<ConsoleScan | null>;
  /**
   * Ends held processes: members by key, `root`, `host` (never a GUI member,
   * nor one a GUI programme started). Resolves with how many.
   */
  terminate(keys: readonly string[]): Promise<number>;
  /** Lets go of every process held for this PTY (once its teardown is over). */
  release(): void;
}

/** When `pty.spawn` began and returned, by this process's clock. */
export interface SpawnWindow {
  startedAtMs: number;
  spawnedAtMs: number;
}

export interface ConptyJobs {
  /**
   * Holds the root `pid`, provided this process created it between `fromMs`
   * and `toMs` (Unix ms; a process created at any other time holds a pid
   * the root has given up) and no other spawn of this process's could have
   * (attributeRoot), and its console host: the one the root runs in, or,
   * should the root have exited already, the headless host this process
   * created that only this spawn could have (chooseHost). Resolves null
   * when the helper is not available or did not answer in time.
   */
  track(
    pid: number,
    createdWithin: { fromMs: number; toMs: number; startedAtMs?: number; spawnedAtMs?: number },
  ): Promise<ConptyConsole | null>;
  /** Resolves once the helper can take requests, or cannot start; never rejects. */
  ready(): Promise<boolean>;
}

/** A process the supervisor asked about (ConsoleInspector.classify). */
export interface ClassifiedProcess {
  pid: number;
  createdAtMs: number;
  key: string;
  gui: boolean;
  /** The console host it is attached to: 0 for none (a detached process), -1 unknown. */
  consoleHost: number;
}

/** What the resident supervisor asks of a helper of its own (supervision/reap-daemon.ts). */
export interface ConsoleInspector {
  ready(): Promise<boolean>;
  /**
   * Holds the console host a crashed daemon `parentPid` recorded, if it
   * still is that process (`createdAtMs`, a headless conhost.exe child of
   * that daemon); null when it has exited, or on no answer.
   */
  adopt(host: {
    pid: number;
    createdAtMs: number;
    parentPid: number;
  }): Promise<ConptyConsole | null>;
  /**
   * Holds each process still running as created then and says what it is,
   * for `terminate` on the returned console; null on no answer.
   */
  classify(
    processes: readonly { pid: number; createdAtMs: number }[],
  ): Promise<{ console: ConptyConsole; processes: ClassifiedProcess[] } | null>;
}

/** The C# side: one request per stdin line, `<seq> <verb> <args...>`, one reply line each. */
const HELPER_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PuddleConsoles
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Entry
    {
        public uint Size, Usage, Pid;
        public IntPtr Heap;
        public uint Module, Threads, Parent;
        public int Priority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Exe;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct UnicodeString
    {
        public ushort Length, MaximumLength;
        public IntPtr Buffer;
    }

    delegate bool CtrlHandler(int type);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder name, ref int size);
    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr process, int infoClass, out IntPtr info, int length, IntPtr returned);
    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr process, int infoClass, IntPtr info, int length, out int returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AttachConsole(int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern int GetConsoleProcessList(int[] list, int count);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    static extern bool SetConsoleCtrlHandler(CtrlHandler handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint flags, int pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);

    const uint TERMINATE = 0x0001, QUERY_LIMITED = 0x1000, SYNCHRONIZE = 0x00100000;
    const uint WAIT_TIMEOUT = 0x102;
    const long UNIX_EPOCH = 116444736000000000L;
    const int CONSOLE_HOST = 49, COMMAND_LINE = 60;

    // A process held open: its pid cannot name another process while it is.
    class Pin
    {
        public int Pid;
        public long Created;
        public IntPtr Handle;
        // Its parent's pid as the process table showed it (0: not known).
        public int Parent;
        // Its image's subsystem, once read (-1 until then).
        public int Subsystem = -1;
        // A GUI programme started it, or an ancestor of it below the PTY's root.
        public bool GuiStarted;
        public string Key { get { return Pid + "@" + Created; } }
    }

    class Pty
    {
        public long From, To;
        // The process that spawned the PTY: its root's and its console host's parent.
        public int Parent;
        public Pin Root, Host;
        public readonly Dictionary<string, Pin> Members = new Dictionary<string, Pin>();
    }

    static readonly Dictionary<string, Pty> ptys = new Dictionary<string, Pty>();
    static readonly Dictionary<string, int> subsystems = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
    static readonly object attaching = new object();
    static readonly object attributing = new object();
    static readonly object writing = new object();
    static readonly int self = System.Diagnostics.Process.GetCurrentProcess().Id;
    static CtrlHandler ignore;
    static StreamWriter output;

    public static void Serve()
    {
        // Attached to a PTY's console for a moment, this process must not
        // stop for a Ctrl+C or Ctrl+Break typed there.
        ignore = delegate(int type) { return type == 0 || type == 1; };
        SetConsoleCtrlHandler(ignore, true);
        FreeConsole();
        var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        output.NewLine = "\n";
        output.AutoFlush = true;
        Write("ready");
        string line;
        // End of input: the daemon has gone, and every handle closes with this process.
        while ((line = input.ReadLine()) != null)
        {
            string request = line;
            ThreadPool.QueueUserWorkItem(delegate(object state)
            {
                var f = request.Split(' ');
                string reply;
                try { reply = Handle(f); }
                catch (Exception error) { reply = "error " + error.GetType().Name; }
                Write(f[0] + " " + reply);
            });
        }
    }

    static void Write(string line)
    {
        lock (writing) output.WriteLine(line);
    }

    static string Handle(string[] f)
    {
        if (f.Length == 7 && f[1] == "track") return Track(f[2], int.Parse(f[3]), long.Parse(f[4]), long.Parse(f[5]), int.Parse(f[6]));
        if (f.Length == 6 && f[1] == "claim") return Claim(f[2], f[3] == "1", int.Parse(f[4]), long.Parse(f[5]));
        if (f.Length == 3 && f[1] == "alive") return Alive(f[2]);
        if (f.Length == 4 && f[1] == "scan") return Scan(f[2], f[3] == "1");
        if (f.Length >= 3 && f[1] == "terminate") return Terminate(f[2], f, 3);
        if (f.Length == 3 && f[1] == "release") return Release(f[2]);
        if (f.Length == 6 && f[1] == "adopt") return Adopt(f[2], int.Parse(f[3]), long.Parse(f[4]), int.Parse(f[5]));
        if (f.Length >= 3 && f[1] == "classify") return Classify(f[2], f, 3);
        return "error usage";
    }

    static long CreatedMs(IntPtr handle)
    {
        long created, exited, kernel, user;
        if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) return -1;
        return (created - UNIX_EPOCH) / 10000;
    }

    static bool Running(IntPtr handle)
    {
        return handle != IntPtr.Zero && WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
    }

    static Pin Open(int pid)
    {
        if (pid <= 4 || pid == self) return null;
        IntPtr handle = OpenProcess(SYNCHRONIZE | QUERY_LIMITED | TERMINATE, false, pid);
        if (handle == IntPtr.Zero) return null;
        long created = CreatedMs(handle);
        if (created < 0 || !Running(handle))
        {
            CloseHandle(handle);
            return null;
        }
        var pin = new Pin();
        pin.Pid = pid;
        pin.Created = created;
        pin.Handle = handle;
        return pin;
    }

    static void Close(Pin pin)
    {
        if (pin != null && pin.Handle != IntPtr.Zero)
        {
            CloseHandle(pin.Handle);
            pin.Handle = IntPtr.Zero;
        }
    }

    // The console host Windows records for the process: its pid, 0 for none,
    // -1 when Windows will not say. Not cleared when that host is terminated.
    static long ConsoleHost(IntPtr handle)
    {
        IntPtr value;
        if (NtQueryInformationProcess(handle, CONSOLE_HOST, out value, IntPtr.Size, IntPtr.Zero) != 0) return -1;
        long raw = value.ToInt64();
        return (raw & 3) == 1 ? raw & ~3L : 0;
    }

    // Attached to 'host' now: it names 'host', and was created after it (a
    // process whose host was terminated keeps naming that pid, which a later
    // host may hold).
    static bool AttachedTo(Pin pin, Pin host)
    {
        return host != null && pin.Created >= host.Created && ConsoleHost(pin.Handle) == host.Pid;
    }

    static string ImagePath(IntPtr handle)
    {
        var name = new StringBuilder(1024);
        int size = name.Capacity;
        return QueryFullProcessImageNameW(handle, 0, name, ref size) ? name.ToString() : null;
    }

    static string CommandLine(IntPtr handle)
    {
        int length;
        NtQueryInformationProcess(handle, COMMAND_LINE, IntPtr.Zero, 0, out length);
        if (length <= 0 || length > 1 << 20) return null;
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try
        {
            if (NtQueryInformationProcess(handle, COMMAND_LINE, buffer, length, out length) != 0) return null;
            var text = (UnicodeString)Marshal.PtrToStructure(buffer, typeof(UnicodeString));
            return text.Buffer == IntPtr.Zero ? "" : Marshal.PtrToStringUni(text.Buffer, text.Length / 2);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    // The image's subsystem from its PE header: 2 for a GUI programme, 3 for a console one, 0 unknown.
    static int Subsystem(IntPtr handle)
    {
        string path = ImagePath(handle);
        if (path == null) return 0;
        lock (subsystems)
        {
            int known;
            if (subsystems.TryGetValue(path, out known)) return known;
        }
        int subsystem = 0;
        try
        {
            using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                var reader = new BinaryReader(file);
                file.Seek(0x3C, SeekOrigin.Begin);
                int header = reader.ReadInt32();
                file.Seek(header, SeekOrigin.Begin);
                if (reader.ReadUInt32() == 0x00004550)
                {
                    file.Seek(header + 4 + 20 + 68, SeekOrigin.Begin);
                    subsystem = reader.ReadUInt16();
                }
            }
        }
        catch (Exception) { return 0; }
        lock (subsystems) subsystems[path] = subsystem;
        return subsystem;
    }

    static int SubsystemOf(Pin pin)
    {
        if (pin.Subsystem < 0 && pin.Handle != IntPtr.Zero) pin.Subsystem = Subsystem(pin.Handle);
        return pin.Subsystem;
    }

    static Dictionary<int, Entry> Table()
    {
        var table = new Dictionary<int, Entry>();
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) return table;
        try
        {
            var entry = new Entry();
            entry.Size = (uint)Marshal.SizeOf(typeof(Entry));
            if (Process32FirstW(snapshot, ref entry))
            {
                do { table[(int)entry.Pid] = entry; } while (Process32NextW(snapshot, ref entry));
            }
        }
        finally { CloseHandle(snapshot); }
        return table;
    }

    static int ParentOf(int pid, Dictionary<int, Entry> table)
    {
        Entry entry;
        return table.TryGetValue(pid, out entry) ? (int)entry.Parent : 0;
    }

    static bool IsHeadlessHost(Pin pin, Entry entry)
    {
        if (!string.Equals(entry.Exe, "conhost.exe", StringComparison.OrdinalIgnoreCase)) return false;
        string line = CommandLine(pin.Handle);
        return line != null && line.IndexOf("--headless", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    static bool Assigned(Pin host, Pty except)
    {
        lock (ptys)
        {
            foreach (var other in ptys.Values)
            {
                if (other != except && other.Host != null && other.Host.Handle != IntPtr.Zero && other.Host.Key == host.Key) return true;
            }
        }
        return false;
    }

    // A headless console host that process 'parent' created between pty.From and pty.To, held by no other PTY.
    static Pin OpenHost(int pid, Pty pty, int parent, Dictionary<int, Entry> table)
    {
        Entry entry;
        if (!table.TryGetValue(pid, out entry) || entry.Parent != parent) return null;
        Pin pin = Open(pid);
        if (pin == null) return null;
        if (pin.Created < pty.From || pin.Created > pty.To || !IsHeadlessHost(pin, entry) || Assigned(pin, pty))
        {
            Close(pin);
            return null;
        }
        pin.Parent = parent;
        return pin;
    }

    static void Put(string id, Pty pty)
    {
        Pty old;
        lock (ptys)
        {
            if (!ptys.TryGetValue(id, out old)) old = null;
            ptys[id] = pty;
        }
        if (old != null) Drop(old);
    }

    static Pty Find(string id)
    {
        lock (ptys)
        {
            Pty pty;
            return ptys.TryGetValue(id, out pty) ? pty : null;
        }
    }

    // Holds the root, if 'parent' created it between from and to and it is
    // no console host itself, and names the console host it runs in and
    // every headless host 'parent' created in that window that no other PTY
    // holds, holding none of them: the daemon, which knows every PTY it has
    // spawned, says which is this PTY's ('claim').
    static string Track(string id, int pid, long fromMs, long toMs, int parent)
    {
        var pty = new Pty();
        pty.From = fromMs;
        pty.To = toMs;
        pty.Parent = parent;
        string state = "gone";
        Pin root = Open(pid);
        if (root != null)
        {
            Entry entry;
            var table = Table();
            if (root.Created < fromMs || root.Created > toMs || !table.TryGetValue(pid, out entry) ||
                (int)entry.Parent != parent || IsHeadlessHost(root, entry))
            {
                state = "other";
                Close(root);
                root = null;
            }
            else
            {
                root.Parent = parent;
                state = "ok";
            }
        }
        pty.Root = root;
        // The console the root runs in names its host: wait for the root to
        // attach to it (as it initialises), unless it exits first.
        long named = 0;
        if (root != null)
        {
            for (int waited = 0; waited <= 2000; waited += 5)
            {
                long host = ConsoleHost(root.Handle);
                if (host > 0) named = host;
                if (host != 0 || !Running(root.Handle)) break;
                Thread.Sleep(5);
            }
        }
        var reply = new StringBuilder(state + " " + (root != null ? root.Created : 0) + " " + named);
        var hosts = Table();
        foreach (var entry in hosts.Values)
        {
            if ((int)entry.Parent != parent) continue;
            Pin candidate = OpenHost((int)entry.Pid, pty, parent, hosts);
            if (candidate == null) continue;
            reply.Append(' ').Append(candidate.Pid).Append('@').Append(candidate.Created);
            Close(candidate);
        }
        Put(id, pty);
        return reply.ToString();
    }

    // The daemon's word on a tracked PTY: whether the root it holds is the
    // PTY's, and which console host is (0 for none). One attribution at a
    // time, so that no host is ever two PTYs'.
    static string Claim(string id, bool rootOk, int hostPid, long hostCreated)
    {
        Pty pty = Find(id);
        if (pty == null) return "none";
        if (!rootOk && pty.Root != null)
        {
            Close(pty.Root);
            pty.Root = null;
        }
        if (hostPid > 0)
        {
            lock (attributing)
            {
                Pin host = OpenHost(hostPid, pty, pty.Parent, Table());
                if (host != null && host.Created == hostCreated) pty.Host = host;
                else Close(host);
            }
        }
        return "ok " + (pty.Host != null ? pty.Host.Pid + " " + pty.Host.Created : "0 0");
    }

    static string Alive(string id)
    {
        Pty pty = Find(id);
        if (pty == null) return "ok 0 0";
        return "ok " + (pty.Root != null && Running(pty.Root.Handle) ? 1 : 0) + " " +
            (pty.Host != null && Running(pty.Host.Handle) ? 1 : 0);
    }

    static void Keep(Pty pty, Pin pin, Dictionary<int, Entry> table)
    {
        lock (pty)
        {
            Pin known;
            if (pty.Members.TryGetValue(pin.Key, out known) && known.Handle != IntPtr.Zero)
            {
                Close(pin);
                return;
            }
            if (pin.Parent == 0) pin.Parent = ParentOf(pin.Pid, table);
            pty.Members[pin.Key] = pin;
        }
    }

    // What is attached to the PTY's console now, each process held open: by
    // each process's console host, by the console's own list (when 'attach',
    // through the root, else a member), and what an earlier scan held that
    // still runs.
    static string Scan(string id, bool attach)
    {
        Pty pty = Find(id);
        if (pty == null) return "none";
        bool rootAlive = pty.Root != null && Running(pty.Root.Handle);
        Pin host = pty.Host != null && Running(pty.Host.Handle) ? pty.Host : null;
        var table = Table();
        var listed = new HashSet<string>();
        if (host != null)
        {
            foreach (var entry in table.Values)
            {
                Pin pin = Open((int)entry.Pid);
                if (pin == null) continue;
                if (AttachedTo(pin, host))
                {
                    pin.Parent = (int)entry.Parent;
                    Keep(pty, pin, table);
                }
                else Close(pin);
            }
        }
        if (attach && (rootAlive || host != null))
        {
            // The console to read: the PTY's own, or, while its host is not
            // told apart, the one the root runs in, provided this PTY's spawn
            // could have created it. Never another console the root attached
            // to (its parent's, as a GUI root such as Electron's does), whose
            // list names the daemon and whatever shares its console.
            Pin console = host;
            Pin found = null;
            if (console == null) console = found = RootConsole(pty, table);
            try
            {
                int through = console != null && rootAlive && AttachedTo(pty.Root, console) ? pty.Root.Pid : 0;
                if (through == 0 && host != null)
                {
                    lock (pty)
                    {
                        foreach (var member in pty.Members.Values)
                        {
                            if (Running(member.Handle) && AttachedTo(member, host))
                            {
                                through = member.Pid;
                                break;
                            }
                        }
                    }
                }
                if (through != 0) Listed(pty, through, console, listed, table);
            }
            finally { Close(found); }
        }
        var reply = new StringBuilder("ok " + (rootAlive ? 1 : 0) + " " + (host != null ? 1 : 0));
        var members = new List<Pin>();
        lock (pty) members.AddRange(pty.Members.Values);
        foreach (var member in members)
        {
            if (!Running(member.Handle)) continue;
            if (member.Parent == 0) member.Parent = ParentOf(member.Pid, table);
            bool guiStarted = StartedByGui(pty, member, table);
            reply.Append(' ').Append(member.Pid).Append(':').Append(member.Created).Append(':')
                .Append(SubsystemOf(member)).Append(':').Append(ConsoleHost(member.Handle)).Append(':')
                .Append(listed.Contains(member.Key) ? 1 : 0).Append(':').Append(guiStarted ? 1 : 0);
        }
        return reply.ToString();
    }

    // The console host the root runs in, held open, when this PTY's spawn
    // could have created it: a headless host the PTY's parent created within
    // the spawn's window, before the root, that no other PTY holds. Null
    // otherwise, as for a GUI root that attached to its parent's console.
    static Pin RootConsole(Pty pty, Dictionary<int, Entry> table)
    {
        if (pty.Root == null || pty.Root.Handle == IntPtr.Zero) return null;
        long named = ConsoleHost(pty.Root.Handle);
        if (named <= 0 || named > int.MaxValue) return null;
        Pin pin = OpenHost((int)named, pty, pty.Parent, table);
        if (pin != null && pin.Created > pty.Root.Created)
        {
            Close(pin);
            pin = null;
        }
        return pin;
    }

    // The console's own list, through 'through', which must be attached to
    // 'host' (held open meanwhile, so that its pid stays its own): each pid
    // listed again once held open is the process listed the first time.
    // Only a process attached to 'host' counts, created after it and after
    // the PTY's spawn began; never the PTY's parent.
    static void Listed(Pty pty, int through, Pin host, HashSet<string> listed, Dictionary<int, Entry> table)
    {
        var opened = new List<Pin>();
        lock (attaching)
        {
            if (!AttachConsole(through)) return;
            try
            {
                if (ConsoleHost(GetCurrentProcess()) != host.Pid) return;
                foreach (int pid in List())
                {
                    if (pid == pty.Parent) continue;
                    Pin pin = Open(pid);
                    if (pin != null) opened.Add(pin);
                }
                var again = new HashSet<int>(List());
                foreach (var pin in opened)
                {
                    if (again.Contains(pin.Pid) && pin.Created >= pty.From && AttachedTo(pin, host)) listed.Add(pin.Key);
                }
            }
            finally { FreeConsole(); }
        }
        foreach (var pin in opened)
        {
            if (listed.Contains(pin.Key)) Keep(pty, pin, table);
            else Close(pin);
        }
    }

    static int[] List()
    {
        var list = new int[64];
        int count = GetConsoleProcessList(list, list.Length);
        if (count > list.Length)
        {
            list = new int[count + 16];
            count = GetConsoleProcessList(list, list.Length);
        }
        if (count < 0 || count > list.Length) count = 0;
        var result = new int[count];
        Array.Copy(list, result, count);
        return result;
    }

    // A process held for this PTY as 'pid', created no later than 'before':
    // held open, its pid is still its own, though it may have exited.
    static Pin Held(Pty pty, int pid, long before)
    {
        Pin root = pty.Root;
        if (root != null && root.Pid == pid && root.Created <= before && root.Handle != IntPtr.Zero) return root;
        lock (pty)
        {
            foreach (var member in pty.Members.Values)
            {
                if (member.Pid == pid && member.Created <= before && member.Handle != IntPtr.Zero) return member;
            }
        }
        return null;
    }

    // Whether a GUI programme started 'member', or one of its ancestors
    // below the PTY's root (whose own image never counts: it is the
    // session's process): what a GUI programme starts is never ended.
    // Once found, it stays so. Found only through an ancestor that runs or
    // that a scan has held: Windows keeps nothing of an exited process
    // nobody holds, and scans run only as the PTY ends, so what a GUI
    // launcher started on the console and left there by exiting before then
    // is taken for a console programme (an accepted limitation: only a
    // record made as each process is created could tell).
    static bool StartedByGui(Pty pty, Pin member, Dictionary<int, Entry> table)
    {
        if (member.GuiStarted) return true;
        int pid = member.Parent;
        long created = member.Created;
        for (int depth = 0; depth < 64; depth++)
        {
            if (pid <= 4 || pid == pty.Parent || pid == self) return false;
            int next, subsystem;
            long ancestorCreated;
            bool started = false;
            Pin held = Held(pty, pid, created);
            if (held != null)
            {
                next = held.Parent;
                ancestorCreated = held.Created;
                subsystem = SubsystemOf(held);
                started = held.GuiStarted;
            }
            else
            {
                Entry entry;
                if (!table.TryGetValue(pid, out entry)) return false;
                IntPtr handle = OpenProcess(QUERY_LIMITED, false, pid);
                if (handle == IntPtr.Zero) return false;
                try
                {
                    ancestorCreated = CreatedMs(handle);
                    subsystem = Subsystem(handle);
                }
                finally { CloseHandle(handle); }
                // A pid taken after its child was created is not its parent.
                if (ancestorCreated < 0 || ancestorCreated > created) return false;
                next = (int)entry.Parent;
            }
            if (next == 0 || next == pty.Parent) return false;
            if (subsystem == 2 || started)
            {
                member.GuiStarted = true;
                return true;
            }
            pid = next;
            created = ancestorCreated;
        }
        return false;
    }

    // Ends the held processes named: 'root', 'host', or a member's key
    // (never a GUI programme, nor what one started).
    static string Terminate(string id, string[] f, int from)
    {
        Pty pty = Find(id);
        if (pty == null) return "ok 0";
        var ended = new List<IntPtr>();
        for (int i = from; i < f.Length; i++)
        {
            Pin pin = null;
            bool member = false;
            if (f[i] == "root") pin = pty.Root;
            else if (f[i] == "host") pin = pty.Host;
            else
            {
                member = true;
                lock (pty) pty.Members.TryGetValue(f[i], out pin);
            }
            if (pin == null || !Running(pin.Handle)) continue;
            if (member && (SubsystemOf(pin) == 2 || pin.GuiStarted)) continue;
            if (TerminateProcess(pin.Handle, 1)) ended.Add(pin.Handle);
        }
        // TerminateProcess returns before the process has gone: wait a little.
        int deadline = Environment.TickCount + 500;
        foreach (var handle in ended)
        {
            int left = deadline - Environment.TickCount;
            if (left > 0) WaitForSingleObject(handle, (uint)left);
        }
        return "ok " + ended.Count;
    }

    static void Drop(Pty pty)
    {
        Close(pty.Root);
        Close(pty.Host);
        lock (pty)
        {
            foreach (var member in pty.Members.Values) Close(member);
            pty.Members.Clear();
        }
    }

    static string Release(string id)
    {
        Pty pty;
        lock (ptys)
        {
            if (!ptys.TryGetValue(id, out pty)) return "ok";
            ptys.Remove(id);
        }
        Drop(pty);
        return "ok";
    }

    // A console host a crashed daemon recorded, held while it is still that process.
    static string Adopt(string id, int pid, long createdMs, int parent)
    {
        var pty = new Pty();
        pty.From = createdMs - 1;
        pty.To = createdMs + 1;
        pty.Parent = parent;
        pty.Host = OpenHost(pid, pty, parent, Table());
        Put(id, pty);
        return pty.Host != null ? "ok " + pty.Host.Created : "gone";
    }

    // Holds each pid@created still running as created then, and says what it is.
    static string Classify(string id, string[] f, int from)
    {
        var pty = new Pty();
        var table = Table();
        var seen = new HashSet<string>();
        var reply = new StringBuilder("ok");
        for (int i = from; i < f.Length; i++)
        {
            var parts = f[i].Split('@');
            if (parts.Length != 2) continue;
            Pin pin = Open(int.Parse(parts[0]));
            if (pin == null) continue;
            if (Math.Abs(pin.Created - long.Parse(parts[1])) > 1 || !seen.Add(pin.Key))
            {
                Close(pin);
                continue;
            }
            Keep(pty, pin, table);
            reply.Append(' ').Append(pin.Pid).Append(':').Append(pin.Created).Append(':')
                .Append(SubsystemOf(pin)).Append(':').Append(ConsoleHost(pin.Handle));
        }
        Put(id, pty);
        return reply.ToString();
    }
}
`;

/**
 * Where the helper finds its C# source: an environment variable, as a
 * command line holding it would pass Windows' 32,767-character limit.
 */
const SOURCE_VARIABLE = 'PUDDLE_CONPTY_HELPER_SOURCE';

const HELPER_SCRIPT =
  "$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'\n" +
  `$source = $env:${SOURCE_VARIABLE}; Remove-Item Env:${SOURCE_VARIABLE}\n` +
  'Add-Type -TypeDefinition $source\n' +
  '[PuddleConsoles]::Serve()\n';

/** The helper's arguments to Windows PowerShell 5.1. */
export const HELPER_ARGS: readonly string[] = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
  Buffer.from(HELPER_SCRIPT, 'utf16le').toString('base64'),
];

/** Whether `commandLine` is a ConPTY helper's (the test suites' process guard leaves it be). */
export function isConptyHelper(commandLine: string): boolean {
  return commandLine.includes(HELPER_ARGS[HELPER_ARGS.length - 1]!);
}

export interface ConptyHelperOptions {
  /** The helper to run; Windows PowerShell 5.1 with HELPER_ARGS by default. Tests substitute a fake. */
  worker?: { file: string; args: readonly string[] };
  /** Bound on the helper's start (PowerShell and the compile); 15 s by default. */
  startMs?: number;
  /** Bound on one answer, after which that request counts as failed; 5 s by default. */
  answerMs?: number;
  /** Told once when a helper that held processes exits: the PTYs it held are no longer told apart. */
  onLost?: (reason: string) => void;
  /** The process that spawns the PTYs, whose child every ConPTY host is; this one by default. */
  parentPid?: number;
}

/** How long after a helper that could not start (no PowerShell, `Add-Type` refused) none is tried. */
const RETRY_MS = 5 * 60_000;

function count(answer: string | null): number {
  const value = answer?.startsWith('ok ') ? Number(answer.slice(3)) : 0;
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** `pid:created:subsystem:host[:listed:guiStarted]` fields; null for anything malformed. */
function fields(item: string, size: number): number[] | null {
  const parts = item.split(':').map(Number);
  return parts.length === size && parts.every((part) => Number.isSafeInteger(part)) ? parts : null;
}

/**
 * How much nearer the spawn a process is attributed to must be than any
 * other spawn. Measured on Windows 11: `pty.spawn` takes 35-50 ms; it
 * creates the console host 3-15 ms in and the root at its very end
 * (Windows' creation times and this clock agree within a few ms), so a
 * host or root of a neighbouring spawn is some 30 ms further away.
 */
export const ATTRIBUTION_MARGIN_MS = 10;

/** How far apart spawns are remembered for attributing each other's processes. */
const SPAWN_MEMORY_MS = 120_000;

/** This process's recent ConPTY spawns, every PtyManager's and every helper's. */
const spawns: SpawnWindow[] = [];

/**
 * Remembers a ConPTY spawn of this process, so that no process it created
 * is taken for another spawn's (PtyManager notes each one; `track` too),
 * forgetting those long before or after it. Returns the window as
 * remembered.
 */
export function noteConptySpawn(window: SpawnWindow): SpawnWindow {
  for (let index = spawns.length - 1; index >= 0; index--) {
    if (Math.abs(spawns[index]!.spawnedAtMs - window.spawnedAtMs) > SPAWN_MEMORY_MS) {
      spawns.splice(index, 1);
    }
  }
  const known = spawns.find(
    (each) => each.startedAtMs === window.startedAtMs && each.spawnedAtMs === window.spawnedAtMs,
  );
  if (known) return known;
  const noted = { startedAtMs: window.startedAtMs, spawnedAtMs: window.spawnedAtMs };
  spawns.push(noted);
  return noted;
}

/** Whether `atMs` is nearer `edge` of `own` than that of every other spawn, by the margin. */
function nearest(
  atMs: number,
  own: SpawnWindow,
  others: readonly SpawnWindow[],
  edge: keyof SpawnWindow,
): boolean {
  const mine = Math.abs(atMs - own[edge]);
  return others.every(
    (other) => other === own || Math.abs(atMs - other[edge]) - mine >= ATTRIBUTION_MARGIN_MS,
  );
}

/**
 * Whether a root created at `createdAtMs` is `own`'s: node-pty creates the
 * root at the very end of `pty.spawn`, so it is nearer that spawn's end than
 * any other's. A later process of this daemon that took a root's pid (another
 * PTY's root, say) is not.
 */
export function attributeRoot(
  createdAtMs: number,
  own: SpawnWindow,
  others: readonly SpawnWindow[],
): boolean {
  return nearest(createdAtMs, own, others, 'spawnedAtMs');
}

/**
 * The console host of the spawn `own`: the one its root runs in (`named`,
 * created before the root), else the one candidate nearer `own`'s start than
 * any other spawn's and than any other candidate (node-pty creates the host
 * first thing in `pty.spawn`), by the margin; null when none is, as when
 * this PTY's own host has exited and the candidates are other spawns'.
 */
export function chooseHost(
  candidates: readonly { pid: number; createdAtMs: number }[],
  named: number,
  rootCreatedAtMs: number | null,
  own: SpawnWindow,
  others: readonly SpawnWindow[],
): { pid: number; createdAtMs: number } | null {
  if (rootCreatedAtMs !== null && named > 0) {
    const host = candidates.find((candidate) => candidate.pid === named);
    if (host && host.createdAtMs <= rootCreatedAtMs) return host;
  }
  const distance = (candidate: { createdAtMs: number }) =>
    Math.abs(candidate.createdAtMs - own.startedAtMs);
  const fitting = candidates
    .filter((candidate) => nearest(candidate.createdAtMs, own, others, 'startedAtMs'))
    .sort((a, b) => distance(a) - distance(b));
  const [best, next] = fitting;
  if (!best) return null;
  return next && distance(next) - distance(best) < ATTRIBUTION_MARGIN_MS ? null : best;
}

/**
 * The helper process (see the module comment). It is started on first use,
 * or by `ready()`. Its handles hold the event loop only while it starts or a
 * request is outstanding, so an idle helper never keeps its process alive.
 * A helper that exits takes its holds with it and ends nothing; the next
 * request starts another.
 */
export class ConptyHelper implements ConptyJobs, ConsoleInspector {
  private readonly worker: { file: string; args: readonly string[] };
  private readonly startMs: number;
  private readonly answerMs: number;
  private readonly onLost: ((reason: string) => void) | undefined;
  private readonly parentPid: number;
  private child: ChildProcess | null = null;
  private started: Promise<boolean> | null = null;
  private starting = false;
  /** A helper that never became ready is not tried again before this. */
  private retryAfter = 0;
  private sequence = 0;
  /** Which helper this is: a hold is only ever used with the helper that has it. */
  private generation = 0;
  /** PTYs held and not yet released. */
  private held = 0;
  private readonly waiting = new Map<string, (reply: string | null) => void>();

  constructor(options: ConptyHelperOptions = {}) {
    this.worker = options.worker ?? {
      file: system32Path(win32.join('WindowsPowerShell', 'v1.0', 'powershell.exe')),
      args: HELPER_ARGS,
    };
    this.startMs = options.startMs ?? 15_000;
    this.answerMs = options.answerMs ?? 5_000;
    this.onLost = options.onLost;
    this.parentPid = options.parentPid ?? process.pid;
  }

  /** The helper's pid while it runs (tests). */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  ready(): Promise<boolean> {
    // A helper that has exited holds nothing any more: a new one may start.
    if (this.started && !this.child && !this.starting && Date.now() >= this.retryAfter) {
      this.started = null;
    }
    return (this.started ??= this.start());
  }

  async track(
    pid: number,
    createdWithin: { fromMs: number; toMs: number; startedAtMs?: number; spawnedAtMs?: number },
  ): Promise<ConptyConsole | null> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const id = `t${++this.sequence}`;
    const { fromMs, toMs } = createdWithin;
    const middle = (fromMs + toMs) / 2;
    const own = noteConptySpawn({
      startedAtMs: createdWithin.startedAtMs ?? middle,
      spawnedAtMs: createdWithin.spawnedAtMs ?? createdWithin.startedAtMs ?? middle,
    });
    const reply = await this.ask(
      `track ${id} ${pid} ${Math.floor(fromMs)} ${Math.ceil(toMs)} ${this.parentPid}`,
    );
    const [state, rootCreated, named, ...listed] = (reply ?? '').split(' ');
    if (!['ok', 'gone', 'other'].includes(state ?? '')) {
      if (reply !== null) void this.ask(`release ${id}`);
      return null;
    }
    // Every spawn whose host the helper saw has been noted by now: the
    // helper read the process table after it was created, and each spawn
    // notes itself as `pty.spawn` returns.
    const others = [...spawns];
    const rootAtMs = Number(rootCreated);
    const rootOk =
      state === 'ok' && Number.isSafeInteger(rootAtMs) && attributeRoot(rootAtMs, own, others);
    const candidates = listed.flatMap((item) => {
      const [hostPid, hostCreated] = item.split('@').map(Number);
      return Number.isSafeInteger(hostPid) && Number.isSafeInteger(hostCreated)
        ? [{ pid: hostPid!, createdAtMs: hostCreated! }]
        : [];
    });
    const host = chooseHost(candidates, Number(named), rootOk ? rootAtMs : null, own, others);
    const claimed = await this.ask(
      `claim ${id} ${rootOk ? 1 : 0} ${host?.pid ?? 0} ${host?.createdAtMs ?? 0}`,
    );
    const [ok, hostPid, hostCreated] = (claimed ?? '').split(' ');
    if (ok !== 'ok') {
      if (claimed !== null) void this.ask(`release ${id}`);
      return null;
    }
    const held = Number(hostPid);
    return this.console(
      id,
      rootOk ? rootAtMs : null,
      Number.isSafeInteger(held) && held > 0
        ? { pid: held, createdAtMs: Number(hostCreated) }
        : null,
    );
  }

  async adopt(host: {
    pid: number;
    createdAtMs: number;
    parentPid: number;
  }): Promise<ConptyConsole | null> {
    const values = [host.pid, host.createdAtMs, host.parentPid];
    if (!values.every((value) => Number.isSafeInteger(value) && value > 0)) return null;
    const id = `a${++this.sequence}`;
    const reply = await this.ask(`adopt ${id} ${values.join(' ')}`);
    if (!reply?.startsWith('ok ')) {
      if (reply === 'gone') void this.ask(`release ${id}`);
      return null;
    }
    return this.console(id, null, { pid: host.pid, createdAtMs: Number(reply.slice(3)) });
  }

  async classify(
    processes: readonly { pid: number; createdAtMs: number }[],
  ): Promise<{ console: ConptyConsole; processes: ClassifiedProcess[] } | null> {
    const id = `c${++this.sequence}`;
    const keys = processes
      .filter((entry) => Number.isSafeInteger(entry.pid) && entry.pid > 0)
      .filter((entry) => Number.isSafeInteger(entry.createdAtMs))
      .map((entry) => `${entry.pid}@${entry.createdAtMs}`);
    const reply = await this.ask(`classify ${id} ${keys.join(' ')}`.trimEnd());
    if (reply === null || (reply !== 'ok' && !reply.startsWith('ok '))) return null;
    const classified: ClassifiedProcess[] = [];
    for (const item of reply.split(' ').slice(1)) {
      const parts = fields(item, 4);
      if (!parts) continue;
      const [pid, createdAtMs, subsystem, consoleHost] = parts as [number, number, number, number];
      classified.push({
        pid,
        createdAtMs,
        key: `${pid}@${createdAtMs}`,
        gui: subsystem === 2,
        consoleHost,
      });
    }
    return { console: this.console(id, null, null), processes: classified };
  }

  private console(
    id: string,
    rootCreatedAtMs: number | null,
    host: { pid: number; createdAtMs: number } | null,
  ): ConptyConsole {
    const generation = this.generation;
    this.held++;
    let released = false;
    // A helper that has exited holds nothing: its PTY is no longer told apart.
    const current = () => !released && generation === this.generation && this.child !== null;
    return {
      rootCreatedAtMs,
      host,
      alive: async () => {
        if (!current()) return null;
        const reply = await this.ask(`alive ${id}`);
        const [ok, root, hostAlive] = (reply ?? '').split(' ');
        return ok === 'ok' ? { root: root === '1', host: hostAlive === '1' } : null;
      },
      scan: async ({ attach }) => {
        if (!current()) return null;
        const reply = await this.ask(`scan ${id} ${attach ? 1 : 0}`);
        if (!reply?.startsWith('ok ')) return null;
        const [, root, hostAlive, ...items] = reply.split(' ');
        const members: ConsoleMember[] = [];
        for (const item of items) {
          const parts = fields(item, 6);
          if (!parts) continue;
          const [pid, createdAtMs, subsystem, consoleHost, listed, guiStarted] = parts as [
            number,
            number,
            number,
            number,
            number,
            number,
          ];
          members.push({
            pid,
            createdAtMs,
            key: `${pid}@${createdAtMs}`,
            gui: subsystem === 2,
            guiStarted: guiStarted === 1,
            consoleHost,
            listed: listed === 1,
          });
        }
        return { rootAlive: root === '1', hostAlive: hostAlive === '1', members };
      },
      terminate: async (keys) => {
        if (!current() || keys.length === 0) return 0;
        const valid = keys.filter((key) => /^(root|host|\d+@\d+)$/.test(key));
        return valid.length === 0 ? 0 : count(await this.ask(`terminate ${id} ${valid.join(' ')}`));
      },
      release: () => {
        if (released) return;
        released = true;
        if (generation !== this.generation) return;
        this.held = Math.max(0, this.held - 1);
        if (this.child !== null) void this.ask(`release ${id}`);
      },
    };
  }

  /** One request; null when the helper is not available, fails it or does not answer in time. */
  private ask(command: string): Promise<string | null> {
    const id = String(++this.sequence);
    return this.ready().then((up) => {
      const child = this.child;
      if (!up || child === null) return null;
      return new Promise<string | null>((resolve) => {
        // A slow answer fails this request only: stopping the helper would let every hold go.
        const timer = setTimeout(() => settle(null), this.answerMs);
        const settle = (answer: string | null) => {
          clearTimeout(timer);
          this.waiting.delete(id);
          this.reference();
          resolve(answer !== null && answer.startsWith('error') ? null : answer);
        };
        this.waiting.set(id, settle);
        this.reference();
        child.stdin!.write(`${id} ${command}\n`, (err) => {
          if (err) settle(null);
        });
      });
    });
  }

  private start(): Promise<boolean> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(this.worker.file, [...this.worker.args], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, [SOURCE_VARIABLE]: HELPER_SOURCE },
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
      // Until it is ready it holds nothing: stopping it then lets nothing go.
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

let shared: ConptyHelper | null = null;

/** This process's helper, shared by every PtyManager in it (and by the supervisor's reap). */
export function sharedConptyJobs(): ConptyHelper {
  return (shared ??= new ConptyHelper({
    onLost: (reason) =>
      console.warn(
        `the ConPTY helper exited (${reason}); the PTYs it held end with what node-pty can close`,
      ),
  }));
}
