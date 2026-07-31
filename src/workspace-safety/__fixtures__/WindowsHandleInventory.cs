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
        private const uint OBJ_INHERIT = 0x00000002;
        private const int STD_INPUT_HANDLE = -10;
        private const int STD_OUTPUT_HANDLE = -11;
        private const int STD_ERROR_HANDLE = -12;
        private const uint STARTF_USESTDHANDLES = 0x00000100;
        private const uint PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
        private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const uint CREATE_NO_WINDOW = 0x08000000;
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
        private const uint SYNCHRONIZE = 0x00100000;
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
            internal uint dwFlags;
            internal short wShowWindow;
            internal short cbReserved2;
            internal IntPtr lpReserved2;
            internal IntPtr hStdInput;
            internal IntPtr hStdOutput;
            internal IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct STARTUPINFOEX
        {
            internal STARTUPINFO StartupInfo;
            internal IntPtr lpAttributeList;
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
        private struct SECURITY_ATTRIBUTES
        {
            internal int nLength;
            internal IntPtr lpSecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)] internal bool bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FILETIME
        {
            internal uint dwLowDateTime;
            internal uint dwHighDateTime;
        }

        [DllImport("ntdll.dll")]
        private static extern int NtQuerySystemInformation(int informationClass,
            IntPtr information, int informationLength, out int returnLength);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentProcessId();

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

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
            ref STARTUPINFOEX startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool InitializeProcThreadAttributeList(IntPtr attributeList,
            int attributeCount, int flags, ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UpdateProcThreadAttribute(IntPtr attributeList, uint flags,
            UIntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue,
            IntPtr returnSize);

        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint desiredAccess,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, uint processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetProcessTimes(IntPtr process, out FILETIME creation,
            out FILETIME exit, out FILETIME kernel, out FILETIME user);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true,
            ExactSpelling = true)]
        private static extern IntPtr CreateEventW(ref SECURITY_ATTRIBUTES attributes,
            [MarshalAs(UnmanagedType.Bool)] bool manualReset,
            [MarshalAs(UnmanagedType.Bool)] bool initialState, string name);

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

        private static List<SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX> HandleEntries(uint processId)
        {
            int length = 1 << 20;
            int validLength = 0;
            IntPtr buffer = IntPtr.Zero;
            try
            {
                while (true)
                {
                    buffer = Marshal.AllocHGlobal(length);
                    int required;
                    int status = NtQuerySystemInformation(SystemExtendedHandleInformation,
                        buffer, length, out required);
                    if (status == 0)
                    {
                        validLength = required;
                        break;
                    }
                    Marshal.FreeHGlobal(buffer);
                    buffer = IntPtr.Zero;
                    if (status != STATUS_INFO_LENGTH_MISMATCH)
                        throw new InvalidOperationException("NtQuerySystemInformation failed with " +
                            status.ToString(CultureInfo.InvariantCulture));
                    length = Math.Max(checked(length * 2), checked(required + 65536));
                    if (length > 256 * 1024 * 1024)
                        throw new InvalidOperationException("system handle inventory is too large");
                }
                ulong count = unchecked((ulong)Marshal.ReadIntPtr(buffer).ToInt64());
                int offset = IntPtr.Size * 2;
                int entrySize = Marshal.SizeOf(typeof(SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX));
                int expectedEntrySize = IntPtr.Size * 3 + 16;
                if (entrySize != expectedEntrySize || validLength < offset ||
                    validLength > length)
                    throw new InvalidOperationException("system handle inventory layout is invalid");
                ulong capacity = unchecked((ulong)((validLength - offset) / entrySize));
                if (count > capacity)
                    throw new InvalidOperationException("system handle inventory count exceeds its buffer");
                List<SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX> entries =
                    new List<SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX>();
                for (ulong index = 0; index < count; index++)
                {
                    long entryOffset = checked((long)index * entrySize);
                    IntPtr entryPointer = new IntPtr(checked(buffer.ToInt64() + offset + entryOffset));
                    SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX entry =
                        (SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX)Marshal.PtrToStructure(entryPointer,
                            typeof(SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX));
                    if (entry.UniqueProcessId.ToUInt64() == processId) entries.Add(entry);
                }
                return entries;
            }
            finally
            {
                if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
            }
        }

        private static void AssertSnapshotCalibration()
        {
            SECURITY_ATTRIBUTES inheritableAttributes = new SECURITY_ATTRIBUTES();
            inheritableAttributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            inheritableAttributes.bInheritHandle = true;
            SECURITY_ATTRIBUTES ordinaryAttributes = new SECURITY_ATTRIBUTES();
            ordinaryAttributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            ordinaryAttributes.bInheritHandle = false;
            IntPtr inheritableEvent = IntPtr.Zero;
            IntPtr ordinaryEvent = IntPtr.Zero;
            try
            {
                inheritableEvent = CreateEventW(ref inheritableAttributes, false, false, null);
                ordinaryEvent = CreateEventW(ref ordinaryAttributes, false, false, null);
                if (inheritableEvent == IntPtr.Zero || ordinaryEvent == IntPtr.Zero)
                    throw new InvalidOperationException(
                        "handle inventory calibration event creation failed with " +
                        Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture));
                uint inheritableFlags;
                uint ordinaryFlags;
                if (!GetHandleInformation(inheritableEvent, out inheritableFlags) ||
                    !GetHandleInformation(ordinaryEvent, out ordinaryFlags) ||
                    (inheritableFlags & HANDLE_FLAG_INHERIT) == 0 ||
                    (ordinaryFlags & HANDLE_FLAG_INHERIT) != 0)
                    throw new InvalidOperationException("public handle inheritance calibration failed");
                ulong inheritableValue = unchecked((ulong)inheritableEvent.ToInt64());
                ulong ordinaryValue = unchecked((ulong)ordinaryEvent.ToInt64());
                List<SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX> entries =
                    HandleEntries(GetCurrentProcessId());
                List<SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX> inheritableEntries = entries
                    .Where(entry => entry.HandleValue.ToUInt64() == inheritableValue)
                    .ToList();
                List<SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX> ordinaryEntries = entries
                    .Where(entry => entry.HandleValue.ToUInt64() == ordinaryValue)
                    .ToList();
                if (inheritableEntries.Count != 1 || ordinaryEntries.Count != 1 ||
                    (inheritableEntries[0].HandleAttributes & OBJ_INHERIT) == 0 ||
                    (ordinaryEntries[0].HandleAttributes & OBJ_INHERIT) != 0)
                    throw new InvalidOperationException("system handle inheritance calibration failed");
            }
            finally
            {
                if (inheritableEvent != IntPtr.Zero) CloseHandle(inheritableEvent);
                if (ordinaryEvent != IntPtr.Zero) CloseHandle(ordinaryEvent);
            }
        }

        private static string ProcessIdentity(IntPtr process)
        {
            FILETIME creation;
            FILETIME exit;
            FILETIME kernel;
            FILETIME user;
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
                throw new InvalidOperationException("GetProcessTimes failed with " +
                    Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture));
            ulong value = ((ulong)creation.dwHighDateTime << 32) | creation.dwLowDateTime;
            return value.ToString(CultureInfo.InvariantCulture);
        }

        private static string JsonHandles(IEnumerable<ulong> handles)
        {
            return String.Join(",", handles.OrderBy(value => value).Select(value => "\"" +
                value.ToString(CultureInfo.InvariantCulture) + "\"").ToArray());
        }

        private static void WriteCommitted(string path, string content)
        {
            string temporary = path + ".tmp-" +
                GetCurrentProcessId().ToString(CultureInfo.InvariantCulture);
            try
            {
                File.WriteAllText(temporary, content, new UTF8Encoding(false));
                File.Move(temporary, path);
            }
            finally
            {
                if (File.Exists(temporary)) File.Delete(temporary);
            }
        }

        private static void WriteSuspendedInventory(string role, uint processId,
            string expectedIdentity, string path)
        {
            IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                false, processId);
            if (process == IntPtr.Zero)
                throw new InvalidOperationException("OpenProcess for handle inventory failed with " +
                    Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture));
            try
            {
                if (WaitForSingleObject(process, 0) != WAIT_TIMEOUT)
                    throw new InvalidOperationException("handle inventory target is not alive");
                string identityBefore = ProcessIdentity(process);
                if (identityBefore != expectedIdentity)
                    throw new InvalidOperationException("handle inventory target identity changed");
                List<ulong> handles = HandleEntries(processId)
                    .Where(entry => (entry.HandleAttributes & OBJ_INHERIT) != 0)
                    .Select(entry => entry.HandleValue.ToUInt64())
                    .OrderBy(value => value)
                    .ToList();
                if (WaitForSingleObject(process, 0) != WAIT_TIMEOUT ||
                    ProcessIdentity(process) != identityBefore)
                    throw new InvalidOperationException("handle inventory target changed during capture");
                string json = "{\"kind\":\"suspended-handle-snapshot-v1\",\"role\":\"" + role +
                    "\",\"pid\":" + processId.ToString(CultureInfo.InvariantCulture) +
                    ",\"processIdentity\":\"" + identityBefore + "\",\"pointerSize\":" +
                    IntPtr.Size.ToString(CultureInfo.InvariantCulture) + ",\"entrySize\":" +
                    Marshal.SizeOf(typeof(SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX))
                        .ToString(CultureInfo.InvariantCulture) + ",\"handles\":[" +
                    JsonHandles(handles) + "]}";
                WriteCommitted(path, json);
            }
            finally
            {
                CloseHandle(process);
            }
        }

        private static void WriteRuntimeInventory(string role, string path)
        {
            IntPtr[] standardHandles = new IntPtr[] {
                GetStdHandle(STD_INPUT_HANDLE),
                GetStdHandle(STD_OUTPUT_HANDLE),
                GetStdHandle(STD_ERROR_HANDLE)
            };
            List<ulong> values = new List<ulong>();
            foreach (IntPtr handle in standardHandles)
            {
                uint flags;
                if (!GetHandleInformation(handle, out flags) ||
                    (flags & HANDLE_FLAG_INHERIT) == 0)
                    throw new InvalidOperationException("runtime standard handle is not inheritable");
                values.Add(unchecked((ulong)handle.ToInt64()));
            }
            string json = "{\"kind\":\"runtime-standard-handles-v1\",\"role\":\"" + role +
                "\",\"pid\":" + GetCurrentProcessId().ToString(CultureInfo.InvariantCulture) +
                ",\"processIdentity\":\"" + ProcessIdentity(GetCurrentProcess()) + "\"" +
                ",\"handles\":[" + JsonHandles(values) + "]}";
            WriteCommitted(path, json);
        }

        private static void WriteInspectorIdentity(string path)
        {
            WriteCommitted(path, "{\"pid\":" +
                GetCurrentProcessId().ToString(CultureInfo.InvariantCulture) +
                ",\"processIdentity\":\"" + ProcessIdentity(GetCurrentProcess()) + "\"}");
        }

        private static void WaitForFile(string path, IntPtr process, string label)
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(30);
            while (!File.Exists(path) && DateTime.UtcNow <= deadline)
            {
                if (WaitForSingleObject(process, 0) != WAIT_TIMEOUT)
                    throw new InvalidOperationException("descendant exited before " + label);
                Thread.Sleep(20);
            }
            if (!File.Exists(path))
                throw new InvalidOperationException("descendant " + label + " timed out");
        }

        public static int RunDescendant(string inventoryPath)
        {
            WriteRuntimeInventory("descendant-runtime", inventoryPath);
            Thread.Sleep(Timeout.Infinite);
            return 0;
        }

        public static int RunRoot(string executablePath, string rootRuntimeInventoryPath,
            string descendantCreatedPath, string descendantRuntimeInventoryPath,
            string descendantProceedPath, string readyPath)
        {
            PROCESS_INFORMATION child = new PROCESS_INFORMATION();
            IntPtr attributeSize = IntPtr.Zero;
            IntPtr attributes = IntPtr.Zero;
            IntPtr handlesValue = IntPtr.Zero;
            bool attributesInitialized = false;
            bool ready = false;
            try
            {
                WriteRuntimeInventory("root-runtime", rootRuntimeInventoryPath);
                string[] arguments = new string[] {
                    executablePath, "descendant", descendantRuntimeInventoryPath
                };
                StringBuilder commandLine = new StringBuilder(String.Join(" ",
                    arguments.Select(Quote).ToArray()));
                IntPtr[] inherited = new IntPtr[] {
                    GetStdHandle(STD_INPUT_HANDLE),
                    GetStdHandle(STD_OUTPUT_HANDLE),
                    GetStdHandle(STD_ERROR_HANDLE)
                };
                foreach (IntPtr handle in inherited)
                {
                    uint handleFlags;
                    if (!GetHandleInformation(handle, out handleFlags) ||
                        (handleFlags & HANDLE_FLAG_INHERIT) == 0)
                        throw new InvalidOperationException(
                            "standard handle is not safely inheritable");
                }

                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
                if (attributeSize == IntPtr.Zero)
                    throw new InvalidOperationException(
                        "InitializeProcThreadAttributeList did not report a size");
                attributes = Marshal.AllocHGlobal(attributeSize);
                if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref attributeSize))
                    throw new InvalidOperationException(
                        "InitializeProcThreadAttributeList failed with " +
                        Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture));
                attributesInitialized = true;
                handlesValue = Marshal.AllocHGlobal(IntPtr.Size * inherited.Length);
                for (int index = 0; index < inherited.Length; index++)
                    Marshal.WriteIntPtr(handlesValue, index * IntPtr.Size, inherited[index]);
                if (!UpdateProcThreadAttribute(attributes, 0,
                    new UIntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), handlesValue,
                    new IntPtr(IntPtr.Size * inherited.Length), IntPtr.Zero, IntPtr.Zero))
                    throw new InvalidOperationException(
                        "UpdateProcThreadAttribute(HANDLE_LIST) failed with " +
                        Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture));

                STARTUPINFOEX startup = new STARTUPINFOEX();
                startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = inherited[0];
                startup.StartupInfo.hStdOutput = inherited[1];
                startup.StartupInfo.hStdError = inherited[2];
                startup.lpAttributeList = attributes;
                if (!CreateProcessW(executablePath, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                    EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED |
                    CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                    IntPtr.Zero, Path.GetDirectoryName(readyPath), ref startup, out child))
                    throw new InvalidOperationException("CreateProcessW descendant failed with " +
                        Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture));
                DeleteProcThreadAttributeList(attributes);
                attributesInitialized = false;
                Marshal.FreeHGlobal(attributes);
                attributes = IntPtr.Zero;
                Marshal.FreeHGlobal(handlesValue);
                handlesValue = IntPtr.Zero;
                string descendantIdentity = ProcessIdentity(child.hProcess);
                WriteCommitted(descendantCreatedPath, "{\"descendantPid\":" +
                    child.dwProcessId.ToString(CultureInfo.InvariantCulture) +
                    ",\"descendantIdentity\":\"" + descendantIdentity + "\"}");
                WaitForFile(descendantProceedPath, child.hProcess, "inspection release");
                uint previousSuspendCount = ResumeThread(child.hThread);
                if (previousSuspendCount != 1)
                    throw new InvalidOperationException(
                        "ResumeThread descendant did not release one suspended launch thread: " +
                        previousSuspendCount.ToString(CultureInfo.InvariantCulture));
                CloseHandle(child.hThread);
                child.hThread = IntPtr.Zero;
                WaitForFile(descendantRuntimeInventoryPath, child.hProcess, "runtime inventory");
                WriteCommitted(readyPath, "{\"rootPid\":" +
                    GetCurrentProcessId().ToString(CultureInfo.InvariantCulture) +
                    ",\"descendantPid\":" +
                    child.dwProcessId.ToString(CultureInfo.InvariantCulture) + "}");
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
                if (attributes != IntPtr.Zero)
                {
                    if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
                    Marshal.FreeHGlobal(attributes);
                }
                if (handlesValue != IntPtr.Zero) Marshal.FreeHGlobal(handlesValue);
            }
        }

        public static int Main(string[] arguments)
        {
            try
            {
                if (arguments.Length == 2 && arguments[0] == "descendant")
                    return RunDescendant(arguments[1]);
                if (arguments.Length == 6 && arguments[0] == "inspect")
                {
                    if (arguments[1] != "root-prestart" &&
                        arguments[1] != "descendant-prestart")
                        throw new InvalidOperationException("handle inventory role is invalid");
                    uint processId;
                    if (!UInt32.TryParse(arguments[2], NumberStyles.None,
                        CultureInfo.InvariantCulture, out processId) || processId == 0)
                        throw new InvalidOperationException("handle inventory process id is invalid");
                    WriteInspectorIdentity(arguments[5]);
                    AssertSnapshotCalibration();
                    WriteSuspendedInventory(arguments[1], processId, arguments[3],
                        arguments[4]);
                    return 0;
                }
                if (arguments.Length == 7 && arguments[0] == "root")
                    return RunRoot(arguments[1], arguments[2], arguments[3], arguments[4],
                        arguments[5], arguments[6]);
                Console.Error.WriteLine("coding-x Windows handle inventory arguments are invalid");
                return 2;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                return 2;
            }
        }
    }
}
