// Windowless launcher for the Puddle supervisor (docs/windows.md, decision 6).
//
// The home's scheduled task, and the WMI fallback, start
//   bin\puddle-hidden.exe "<node.exe>" "<supervisor.mjs>" --home "<home>"
// Task Scheduler gives a console program a console window. This program is
// built for the GUI subsystem, which Windows starts without a console, and it
// starts the command line that follows its own name with a console that has
// no window (CREATE_NO_WINDOW), so nothing ever shows a window, whatever
// standard handles its starter passed (Task Scheduler passes none). The rest
// of its command line, after its own name however that was quoted, is handed
// on verbatim: nothing re-quotes it or expands %NAME% in it. The child
// inherits no handle, and this program waits for it and exits with its
// status, so Task Scheduler records the supervisor's own result and counts
// the task as running for as long as the supervisor runs (its IgnoreNew
// policy then never doubles it).
//
// `conhost.exe --headless` was the first choice. On Windows 11 26200 it
// expands %NAME% in the command line it runs, exits 0 whatever its program
// returns, and runs nothing at all when its standard input is the NUL device.
//
// Built by scripts/build-tarball.mjs with the .NET Framework 4 compiler that
// every supported Windows ships (C# 5: no newer syntax).
using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

static class PuddleHidden
{
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint INFINITE = 0xFFFFFFFF;
    const int ERROR_INVALID_PARAMETER = 87;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
        public int dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr GetCommandLineW();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    static int Main()
    {
        string line = Marshal.PtrToStringUni(GetCommandLineW()) ?? "";
        string command = line.Substring(Blanks(line, OwnNameEnd(line)));
        int end = ProgramEnd(command, 0);
        string program = command.Substring(0, end).Trim('"');
        // An absolute program only: CreateProcess would search the current directory and PATH.
        if (program.Length == 0 || !Path.IsPathRooted(program)) return ERROR_INVALID_PARAMETER;

        STARTUPINFO startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION process;
        if (!CreateProcessW(program, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false,
                CREATE_NO_WINDOW, IntPtr.Zero, null, ref startup, out process))
        {
            // Windows' own code (2: the file is missing), as Task Scheduler's last result.
            return Marshal.GetLastWin32Error();
        }
        CloseHandle(process.hThread);
        WaitForSingleObject(process.hProcess, INFINITE);
        uint status;
        if (!GetExitCodeProcess(process.hProcess, out status)) status = 1;
        CloseHandle(process.hProcess);
        return unchecked((int)status);
    }

    // Where this program's own name ends. A starter may pass a path with
    // blanks unquoted, which CreateProcess resolves by trying each blank in
    // turn: such a name ends at the first blank after this program's own
    // file name, never at the first blank.
    static int OwnNameEnd(string line)
    {
        if (line.Length > 0 && line[0] == '"') return ProgramEnd(line, 0);
        string self = Path.GetFileName(Assembly.GetEntryAssembly().Location);
        for (int at = line.IndexOf(self, StringComparison.OrdinalIgnoreCase); at >= 0;
             at = line.IndexOf(self, at + 1, StringComparison.OrdinalIgnoreCase))
        {
            int end = at + self.Length;
            if (end == line.Length || line[end] == ' ' || line[end] == '\t') return end;
        }
        return ProgramEnd(line, 0);
    }

    // CreateProcess's rule for a program name: to the closing quote, else to a blank.
    static int ProgramEnd(string line, int at)
    {
        if (at < line.Length && line[at] == '"')
        {
            int close = line.IndexOf('"', at + 1);
            return close < 0 ? line.Length : close + 1;
        }
        while (at < line.Length && line[at] != ' ' && line[at] != '\t') at++;
        return at;
    }

    static int Blanks(string line, int at)
    {
        while (at < line.Length && (line[at] == ' ' || line[at] == '\t')) at++;
        return at;
    }
}
