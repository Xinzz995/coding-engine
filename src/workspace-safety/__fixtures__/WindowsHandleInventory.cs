using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace CodingX.WorkspaceSafety.Tests
{
    public static class WindowsHandleInventory
    {
        private const int SystemExtendedHandleInformation = 64;
        private const int STATUS_INFO_LENGTH_MISMATCH = unchecked((int)0xC0000004);
        private const uint HANDLE_FLAG_INHERIT = 0x00000001;
        private const int STD_INPUT_HANDLE = -10;
        private const int STD_OUTPUT_HANDLE = -11;
        private const int STD_ERROR_HANDLE = -12;
        private const uint STARTF_USESTDHANDLES = 0x00000100;
        private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const uint WAIT_TIMEOUT = 0x00000102;

        [StructLayout(LayoutKind.Sequential)]
        private struct SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX
        {
            internal IntPtr Object;
            internal UIntPtr UniqueProcessId;
            internal UIntPtr HandleValue;
            internal uint GrantedAccess;
            internal ushort CreatorBackTraceIndex;
            internal ushort ObjectTypeIndex;
            internal uint HandleAttributes;
            internal uint Reserved;
        }

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

        [DllImport("ntdll.dll")]
        private static extern int NtQuerySystemInformation(int informationClass,
            IntPtr information, int informationLength, out int returnLength);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentProcessId();

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetHandleInformation(IntPtr handle, out uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int standardHandle);

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
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

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

        private static List<ulong> InheritableHandles()
        {
            int length = 1 << 20;
            IntPtr buffer = IntPtr.Zero;
            try
            {
                while (true)
                {
                    buffer = Marshal.AllocHGlobal(length);
                    int required;
                    int status = NtQuerySystemInformation(SystemExtendedHandleInformation,
                        buffer, length, out required);
                    if (status == 0) break;
                    Marshal.FreeHGlobal(buffer);
                    buffer = IntPtr.Zero;
                    if (status != STATUS_INFO_LENGTH_MISMATCH)
                        throw new InvalidOperationException("NtQuerySystemInformation failed with " +
                            status.ToString(CultureInfo.InvariantCulture));
                    length = Math.Max(length * 2, required + 65536);
                    if (length > 256 * 1024 * 1024)
                        throw new InvalidOperationException("system handle inventory is too large");
                }
                ulong count = unchecked((ulong)Marshal.ReadIntPtr(buffer).ToInt64());
                int offset = IntPtr.Size * 2;
                int entrySize = Marshal.SizeOf(typeof(SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX));
                ulong currentPid = GetCurrentProcessId();
                List<ulong> inheritable = new List<ulong>();
                for (ulong index = 0; index < count; index++)
                {
                    IntPtr entryPointer = new IntPtr(buffer.ToInt64() + offset +
                        checked((long)index * entrySize));
                    SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX entry =
                        (SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX)Marshal.PtrToStructure(entryPointer,
                            typeof(SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX));
                    if (entry.UniqueProcessId.ToUInt64() != currentPid) continue;
                    IntPtr handle = new IntPtr(unchecked((long)entry.HandleValue.ToUInt64()));
                    uint flags;
                    if (GetHandleInformation(handle, out flags) &&
                        (flags & HANDLE_FLAG_INHERIT) != 0)
                        inheritable.Add(entry.HandleValue.ToUInt64());
                }
                return inheritable.OrderBy(value => value).ToList();
            }
            finally
            {
                if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
            }
        }

        private static void WriteInventory(string role, string path)
        {
            List<ulong> handles = InheritableHandles();
            ulong stdin = unchecked((ulong)GetStdHandle(STD_INPUT_HANDLE).ToInt64());
            ulong stdout = unchecked((ulong)GetStdHandle(STD_OUTPUT_HANDLE).ToInt64());
            ulong stderr = unchecked((ulong)GetStdHandle(STD_ERROR_HANDLE).ToInt64());
            string json = "{\"role\":\"" + role + "\",\"pid\":" +
                GetCurrentProcessId().ToString(CultureInfo.InvariantCulture) +
                ",\"inheritableCount\":" + handles.Count.ToString(CultureInfo.InvariantCulture) +
                ",\"stdinIncluded\":" + handles.Contains(stdin).ToString().ToLowerInvariant() +
                ",\"stdoutIncluded\":" + handles.Contains(stdout).ToString().ToLowerInvariant() +
                ",\"stderrIncluded\":" + handles.Contains(stderr).ToString().ToLowerInvariant() +
                ",\"handles\":[" + String.Join(",", handles.Select(value =>
                    value.ToString(CultureInfo.InvariantCulture)).ToArray()) + "]}";
            File.WriteAllText(path, json, new UTF8Encoding(false));
        }

        private static void WaitForFile(string path, IntPtr process)
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(30);
            while (!File.Exists(path) && DateTime.UtcNow <= deadline)
            {
                if (WaitForSingleObject(process, 0) != WAIT_TIMEOUT)
                    throw new InvalidOperationException("descendant exited before inventory");
                Thread.Sleep(20);
            }
            if (!File.Exists(path))
                throw new InvalidOperationException("descendant inventory timed out");
        }

        public static int RunDescendant(string inventoryPath)
        {
            WriteInventory("descendant", inventoryPath);
            Thread.Sleep(Timeout.Infinite);
            return 0;
        }

        public static int RunRoot(string powershellPath, string scriptPath, string sourcePath,
            string rootInventoryPath, string descendantInventoryPath, string readyPath)
        {
            PROCESS_INFORMATION child = new PROCESS_INFORMATION();
            bool ready = false;
            try
            {
                WriteInventory("root", rootInventoryPath);
                string[] arguments = new string[] {
                    powershellPath, "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
                    scriptPath, "-Mode", "descendant", "-SourcePath", sourcePath,
                    "-PowerShellPath", powershellPath, "-ScriptPath", scriptPath,
                    "-RootInventoryPath", rootInventoryPath, "-DescendantInventoryPath",
                    descendantInventoryPath, "-ReadyPath", readyPath
                };
                StringBuilder commandLine = new StringBuilder(String.Join(" ",
                    arguments.Select(Quote).ToArray()));
                STARTUPINFO startup = new STARTUPINFO();
                startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                startup.dwFlags = STARTF_USESTDHANDLES;
                startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
                startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
                startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
                if (!CreateProcessW(powershellPath, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                    CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, Path.GetDirectoryName(readyPath),
                    ref startup, out child))
                    throw new InvalidOperationException("CreateProcessW descendant failed with " +
                        Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture));
                CloseHandle(child.hThread);
                child.hThread = IntPtr.Zero;
                WaitForFile(descendantInventoryPath, child.hProcess);
                File.WriteAllText(readyPath, "{\"rootPid\":" +
                    GetCurrentProcessId().ToString(CultureInfo.InvariantCulture) +
                    ",\"descendantPid\":" +
                    child.dwProcessId.ToString(CultureInfo.InvariantCulture) + "}",
                    new UTF8Encoding(false));
                ready = true;
                Thread.Sleep(Timeout.Infinite);
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                return 2;
            }
            finally
            {
                if (!ready && child.hProcess != IntPtr.Zero) TerminateProcess(child.hProcess, 2);
                if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
                if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
            }
        }
    }
}
