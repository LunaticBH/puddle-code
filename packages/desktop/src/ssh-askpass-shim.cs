// Windows SSH_ASKPASS program for the Puddle desktop (docs/windows.md).
//
// OpenSSH runs SSH_ASKPASS with the prompt as its only argument and reads the
// answer from its stdout. Puddle.exe cannot be that program: Electron's
// browser process writes a CRLF to stdout at startup (verified with Electron
// 43.2.0), which OpenSSH reads as an empty answer, and its Node mode needs a
// script argument. A .cmd wrapper would let cmd.exe parse prompt text that the
// server controls. So this console program runs Electron in Node mode on the
// askpass helper with the prompt as one quoted argument, relays its stdout,
// and ties the helper to its own lifetime (a kill-on-close job object) and to
// its SSH parent's.
//
// The desktop writes <PUDDLE_HOME, else %USERPROFILE%\.puddle>\ssh-askpass.txt:
//   line 1  Electron executable      line 3  bridge endpoint
//   line 2  askpass helper script    line 4  bridge token
//
// Built by scripts/askpass-shim.mjs with the .NET Framework 4 compiler that
// every supported Windows ships (C# 5: no newer syntax).
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class PuddleSshAskpass
{
    static int Main(string[] args)
    {
        try
        {
            return Run(args);
        }
        catch (Exception)
        {
            // A broken bridge is indistinguishable from cancellation to ssh.
            return 1;
        }
    }

    static int Run(string[] args)
    {
        string home = Environment.GetEnvironmentVariable("PUDDLE_HOME");
        if (String.IsNullOrEmpty(home))
        {
            home = Path.Combine(Environment.GetEnvironmentVariable("USERPROFILE") ?? "", ".puddle");
        }
        string[] bridge = File.ReadAllLines(Path.Combine(home, "ssh-askpass.txt"), new UTF8Encoding(false));
        if (bridge.Length < 4) return 1;

        Process parent = ParentProcess();
        IntPtr job = KillOnCloseJob();

        StringBuilder arguments = new StringBuilder(Quote(bridge[1]));
        foreach (string argument in args) arguments.Append(' ').Append(Quote(argument));
        ProcessStartInfo start = new ProcessStartInfo(bridge[0], arguments.ToString());
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardOutput = true;
        start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
        start.EnvironmentVariables["PUDDLE_DESKTOP_ASKPASS_URL"] = bridge[2];
        start.EnvironmentVariables["PUDDLE_DESKTOP_ASKPASS_TOKEN"] = bridge[3];

        using (Process helper = Process.Start(start))
        {
            if (job != IntPtr.Zero) AssignProcessToJobObject(job, helper.Handle);
            Stream output = Console.OpenStandardOutput();
            Thread relay = new Thread(delegate()
            {
                helper.StandardOutput.BaseStream.CopyTo(output);
                output.Flush();
            });
            relay.Start();
            while (!helper.WaitForExit(250))
            {
                // Exiting closes the job, which ends the helper and its request.
                if (parent != null && parent.HasExited) return 1;
            }
            relay.Join();
            return helper.ExitCode;
        }
    }

    // The Microsoft C runtime's quoting, which Electron's command line parser reverses.
    static string Quote(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return argument;
        }
        StringBuilder quoted = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char c in argument)
        {
            if (c == '\\')
            {
                backslashes++;
                continue;
            }
            quoted.Append('\\', c == '"' ? backslashes * 2 + 1 : backslashes);
            backslashes = 0;
            quoted.Append(c);
        }
        quoted.Append('\\', backslashes * 2);
        return quoted.Append('"').ToString();
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessBasicInformation
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(
        IntPtr process, int informationClass, ref ProcessBasicInformation information, int length, out int returned);

    static Process ParentProcess()
    {
        ProcessBasicInformation information = new ProcessBasicInformation();
        int returned;
        Process self = Process.GetCurrentProcess();
        if (NtQueryInformationProcess(self.Handle, 0, ref information, Marshal.SizeOf(information), out returned) != 0)
        {
            return null;
        }
        try
        {
            Process parent = Process.GetProcessById(information.InheritedFromUniqueProcessId.ToInt32());
            // A recycled process id belongs to a process younger than this one.
            if (parent.StartTime > self.StartTime) return null;
            // Hold a handle now, so a later recycling of the id cannot mislead HasExited.
            bool exited = parent.HasExited;
            return exited ? null : parent;
        }
        catch (Exception)
        {
            return null;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    const int ExtendedLimitInformation = 9;
    const uint KillOnJobClose = 0x2000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(
        IntPtr job, int informationClass, ref JobObjectExtendedLimitInformation information, int length);

    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    static IntPtr KillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;
        JobObjectExtendedLimitInformation information = new JobObjectExtendedLimitInformation();
        information.BasicLimitInformation.LimitFlags = KillOnJobClose;
        return SetInformationJobObject(job, ExtendedLimitInformation, ref information, Marshal.SizeOf(information))
            ? job
            : IntPtr.Zero;
    }
}
