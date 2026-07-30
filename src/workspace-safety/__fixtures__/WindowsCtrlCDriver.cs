using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace CodingX.WorkspaceSafety.Tests
{
    public static class WindowsCtrlCDriver
    {
        private const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
        private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const uint CREATE_NEW_CONSOLE = 0x00000010;
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CTRL_C_EVENT = 0;
        private const uint WAIT_OBJECT_0 = 0;
        private const uint WAIT_TIMEOUT = 0x00000102;
        private const uint STILL_ACTIVE = 259;
        private const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const uint JobObjectExtendedLimitInformation = 9;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            internal int cb;
            internal string lpReserved;
            internal string lpDesktop;
            internal string lpTitle;
            internal uint dwX;
            internal uint dwY;
            internal uint dwXSize;
            internal uint dwYSize;
            internal uint dwXCountChars;
            internal uint dwYCountChars;
            internal uint dwFillAttribute;
            internal uint dwFlags;
            internal short wShowWindow;
            internal short cbReserved2;
            internal IntPtr lpReserved2;
            internal IntPtr hStdInput;
            internal IntPtr hStdOutput;
            internal IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            internal IntPtr hProcess;
            internal IntPtr hThread;
            internal uint dwProcessId;
            internal uint dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            internal ulong ReadOperationCount;
            internal ulong WriteOperationCount;
            internal ulong OtherOperationCount;
            internal ulong ReadTransferCount;
            internal ulong WriteTransferCount;
            internal ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            internal long PerProcessUserTimeLimit;
            internal long PerJobUserTimeLimit;
            internal uint LimitFlags;
            internal UIntPtr MinimumWorkingSetSize;
            internal UIntPtr MaximumWorkingSetSize;
            internal uint ActiveProcessLimit;
            internal UIntPtr Affinity;
            internal uint PriorityClass;
            internal uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            internal JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            internal IO_COUNTERS IoInfo;
            internal UIntPtr ProcessMemoryLimit;
            internal UIntPtr JobMemoryLimit;
            internal UIntPtr PeakProcessMemoryUsed;
            internal UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true,
            ExactSpelling = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcessW(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFO startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FreeConsole();

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AttachConsole(uint processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroupId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true,
            ExactSpelling = true)]
        private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(IntPtr job, uint informationClass,
            IntPtr information, uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        private static string Quote(string value)
        {
            if (value.Length != 0 && value.All(character =>
                character != ' ' && character != '\t' && character != '\n' && character != '\v' &&
                character != '"')) return value;
            StringBuilder quoted = new StringBuilder("\"");
            int slashes = 0;
            foreach (char character in value)
            {
                if (character == '\\') { slashes++; continue; }
                if (character == '"')
                {
                    quoted.Append('\\', slashes * 2 + 1).Append('"');
                    slashes = 0;
                    continue;
                }
                quoted.Append('\\', slashes);
                slashes = 0;
                quoted.Append(character);
            }
            quoted.Append('\\', slashes * 2).Append('"');
            return quoted.ToString();
        }

        private static Exception Failure(string operation)
        {
            return new InvalidOperationException(operation + " failed with Win32 error " +
                Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture));
        }

        private static void SetActiveProcessLimit(IntPtr job, uint activeProcessLimit)
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            limits.BasicLimitInformation.ActiveProcessLimit = activeProcessLimit;
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, buffer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                    buffer, (uint)size)) throw Failure("SetInformationJobObject");
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        private static void WaitForFile(string path, IntPtr process, int seconds, string label)
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(seconds);
            while (!File.Exists(path) && DateTime.UtcNow <= deadline)
            {
                if (WaitForSingleObject(process, 0) == WAIT_OBJECT_0)
                    throw new InvalidOperationException(label + " process exited before becoming ready");
                Thread.Sleep(20);
            }
            if (!File.Exists(path))
                throw new InvalidOperationException(label + " process did not become ready");
        }

        public static int Run(string nodePath, string workerPath, string assetRoot,
            string workspace, string readyPath, string outcomePath)
        {
            PROCESS_INFORMATION child = new PROCESS_INFORMATION();
            bool completed = false;
            try
            {
                string[] arguments = new string[] {
                    nodePath, workerPath, assetRoot, workspace, readyPath, outcomePath
                };
                StringBuilder commandLine = new StringBuilder(String.Join(" ",
                    arguments.Select(Quote).ToArray()));
                STARTUPINFO startup = new STARTUPINFO();
                startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                uint flags = CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP |
                    CREATE_UNICODE_ENVIRONMENT;
                if (!CreateProcessW(nodePath, commandLine, IntPtr.Zero, IntPtr.Zero, false,
                    flags, IntPtr.Zero, workspace, ref startup, out child))
                    throw Failure("CreateProcessW");
                CloseHandle(child.hThread);
                child.hThread = IntPtr.Zero;

                WaitForFile(readyPath, child.hProcess, 45, "Ctrl+C parent");

                FreeConsole();
                if (!AttachConsole(child.dwProcessId)) throw Failure("AttachConsole");
                if (!SetConsoleCtrlHandler(IntPtr.Zero, true))
                    throw Failure("SetConsoleCtrlHandler");
                if (!GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0))
                    throw Failure("GenerateConsoleCtrlEvent");
                uint wait = WaitForSingleObject(child.hProcess, 60000);
                if (wait == WAIT_TIMEOUT)
                    throw new InvalidOperationException("Ctrl+C parent did not exit after the console event");
                if (wait != WAIT_OBJECT_0) throw Failure("WaitForSingleObject");
                uint exitCode;
                if (!GetExitCodeProcess(child.hProcess, out exitCode) || exitCode == STILL_ACTIVE)
                    throw Failure("GetExitCodeProcess");
                if (exitCode != 130)
                    throw new InvalidOperationException("Ctrl+C parent exit code was " +
                        exitCode.ToString(CultureInfo.InvariantCulture) + " instead of 130");
                if (!File.Exists(outcomePath))
                    throw new InvalidOperationException("Ctrl+C parent did not persist its outcome");
                completed = true;
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                return 2;
            }
            finally
            {
                if (!completed && child.hProcess != IntPtr.Zero)
                {
                    uint exitCode;
                    if (GetExitCodeProcess(child.hProcess, out exitCode) && exitCode == STILL_ACTIVE)
                        TerminateProcess(child.hProcess, 2);
                }
                if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
                if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
            }
        }

        public static int RunOuterJob(string nodePath, string workerPath, string assetRoot,
            string workspace, string readyPath, string continuePath, string outcomePath,
            string mode)
        {
            PROCESS_INFORMATION child = new PROCESS_INFORMATION();
            IntPtr job = IntPtr.Zero;
            bool completed = false;
            try
            {
                job = CreateJobObjectW(IntPtr.Zero, null);
                if (job == IntPtr.Zero) throw Failure("CreateJobObjectW");
                SetActiveProcessLimit(job, 16);
                string[] arguments = new string[] {
                    nodePath, workerPath, assetRoot, workspace, readyPath, continuePath,
                    outcomePath, mode
                };
                StringBuilder commandLine = new StringBuilder(String.Join(" ",
                    arguments.Select(Quote).ToArray()));
                STARTUPINFO startup = new STARTUPINFO();
                startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                if (!CreateProcessW(nodePath, commandLine, IntPtr.Zero, IntPtr.Zero, false,
                    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, workspace,
                    ref startup, out child)) throw Failure("CreateProcessW");
                if (!AssignProcessToJobObject(job, child.hProcess))
                    throw Failure("AssignProcessToJobObject");
                if (ResumeThread(child.hThread) == UInt32.MaxValue) throw Failure("ResumeThread");
                CloseHandle(child.hThread);
                child.hThread = IntPtr.Zero;
                WaitForFile(readyPath, child.hProcess, 45, "outer-Job parent");
                if (mode == "incompatible") SetActiveProcessLimit(job, 2);
                else if (mode != "compatible")
                    throw new InvalidOperationException("unknown outer-Job mode");
                File.WriteAllText(continuePath, "continue", new UTF8Encoding(false));
                uint wait = WaitForSingleObject(child.hProcess, 60000);
                if (wait != WAIT_OBJECT_0)
                    throw new InvalidOperationException("outer-Job parent did not exit cleanly");
                uint exitCode;
                if (!GetExitCodeProcess(child.hProcess, out exitCode) || exitCode != 0)
                    throw new InvalidOperationException("outer-Job parent did not prove its contract");
                if (!File.Exists(outcomePath))
                    throw new InvalidOperationException("outer-Job parent did not persist its outcome");
                completed = true;
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                return 2;
            }
            finally
            {
                if (!completed && job != IntPtr.Zero) TerminateJobObject(job, 2);
                if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
                if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
                if (job != IntPtr.Zero) CloseHandle(job);
            }
        }
    }
}
