using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace CodingX.WorkspaceSafety
{
    public static class WindowsJobSupervisor
    {
        private const int ExitFailure = 2;

        public static int Run(string expectedHelperDigest, string timeoutsBase64)
        {
            try
            {
                if (!Patterns.Digest.IsMatch(expectedHelperDigest ?? String.Empty))
                    throw new SafetyException("invalid fixed helper digest");
                Timeouts timeouts = Timeouts.Parse(timeoutsBase64);
                SupervisorSession session = new SupervisorSession(expectedHelperDigest, timeouts);
                return session.Run();
            }
            catch (Exception error)
            {
                ProtocolWriter.TryFailure(error is SafetyException ? error.Message : "Windows supervisor failed");
                return ExitFailure;
            }
        }
    }

    internal sealed class SafetyException : Exception
    {
        internal SafetyException(string message) : base(message) { }
    }

    internal static class Patterns
    {
        internal static readonly Regex Uuid = new Regex(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            RegexOptions.CultureInvariant);
        internal static readonly Regex Digest = new Regex(
            "^sha256:[0-9a-f]{64}$",
            RegexOptions.CultureInvariant);
        internal static readonly Regex GitHead = new Regex(
            "^(?:[0-9a-f]{40}|[0-9a-f]{64})$",
            RegexOptions.CultureInvariant);
        internal static readonly Regex EnvironmentName = new Regex(
            "^[A-Za-z_][A-Za-z0-9_]{0,127}$",
            RegexOptions.CultureInvariant);
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SECURITY_ATTRIBUTES
    {
        internal int nLength;
        internal IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] internal bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct FILETIME
    {
        internal uint dwLowDateTime;
        internal uint dwHighDateTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct BY_HANDLE_FILE_INFORMATION
    {
        internal uint FileAttributes;
        internal FILETIME CreationTime;
        internal FILETIME LastAccessTime;
        internal FILETIME LastWriteTime;
        internal uint VolumeSerialNumber;
        internal uint FileSizeHigh;
        internal uint FileSizeLow;
        internal uint NumberOfLinks;
        internal uint FileIndexHigh;
        internal uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct IO_COUNTERS
    {
        internal ulong ReadOperationCount;
        internal ulong WriteOperationCount;
        internal ulong OtherOperationCount;
        internal ulong ReadTransferCount;
        internal ulong WriteTransferCount;
        internal ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION
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
    internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        internal JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        internal IO_COUNTERS IoInfo;
        internal UIntPtr ProcessMemoryLimit;
        internal UIntPtr JobMemoryLimit;
        internal UIntPtr PeakProcessMemoryUsed;
        internal UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        internal long TotalUserTime;
        internal long TotalKernelTime;
        internal long ThisPeriodTotalUserTime;
        internal long ThisPeriodTotalKernelTime;
        internal uint TotalPageFaultCount;
        internal uint TotalProcesses;
        internal uint ActiveProcesses;
        internal uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct STARTUPINFO
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
    internal struct STARTUPINFOEX
    {
        internal STARTUPINFO StartupInfo;
        internal IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROCESS_INFORMATION
    {
        internal IntPtr hProcess;
        internal IntPtr hThread;
        internal uint dwProcessId;
        internal uint dwThreadId;
    }

    internal static class Native
    {
        internal static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

        internal const uint JobObjectBasicAccountingInformation = 1;
        internal const uint JobObjectExtendedLimitInformation = 9;
        internal const uint JobObjectBasicProcessIdList = 3;
        internal const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        internal const uint PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
        internal const uint PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000D;
        internal const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        internal const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        internal const uint CREATE_SUSPENDED = 0x00000004;
        internal const uint CREATE_NO_WINDOW = 0x08000000;
        internal const uint STARTF_USESTDHANDLES = 0x00000100;
        internal const uint HANDLE_FLAG_INHERIT = 0x00000001;
        internal const uint GENERIC_READ = 0x80000000;
        internal const uint FILE_SHARE_READ = 0x00000001;
        internal const uint OPEN_EXISTING = 3;
        internal const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
        internal const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
        internal const uint WAIT_OBJECT_0 = 0;
        internal const uint WAIT_TIMEOUT = 0x00000102;
        internal const uint STILL_ACTIVE = 259;
        internal const uint TERMINATION_EXIT_CODE = 0xC000013A;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        internal static extern IntPtr CreateJobObjectW(IntPtr jobAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetInformationJobObject(
            IntPtr job,
            uint informationClass,
            IntPtr information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool QueryInformationJobObject(
            IntPtr job,
            uint informationClass,
            IntPtr information,
            uint informationLength,
            out uint returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool IsProcessInJob(
            IntPtr processHandle,
            IntPtr jobHandle,
            [MarshalAs(UnmanagedType.Bool)] out bool result);

        [DllImport("kernel32.dll")]
        internal static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CreatePipe(
            out IntPtr readPipe,
            out IntPtr writePipe,
            ref SECURITY_ATTRIBUTES pipeAttributes,
            uint size);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        internal static extern IntPtr CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            ref SECURITY_ATTRIBUTES securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool InitializeProcThreadAttributeList(
            IntPtr attributeList,
            int attributeCount,
            uint flags,
            ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool UpdateProcThreadAttribute(
            IntPtr attributeList,
            uint flags,
            UIntPtr attribute,
            IntPtr value,
            IntPtr size,
            IntPtr previousValue,
            IntPtr returnSize);

        [DllImport("kernel32.dll")]
        internal static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CreateProcessW(
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
        internal static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetProcessTimes(
            IntPtr process,
            out FILETIME creation,
            out FILETIME exit,
            out FILETIME kernel,
            out FILETIME user);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetFileInformationByHandle(
            IntPtr file,
            out BY_HANDLE_FILE_INFORMATION information);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ReadFile(
            IntPtr file,
            byte[] buffer,
            uint bytesToRead,
            out uint bytesRead,
            IntPtr overlapped);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool MoveFileExW(string existingFile, string newFile, uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(IntPtr handle);

        internal static SafetyException Failure(string operation)
        {
            return new SafetyException(operation + " failed with Win32 error " +
                Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture));
        }

        internal static void Close(ref IntPtr handle)
        {
            if (handle == IntPtr.Zero || handle == InvalidHandleValue) return;
            IntPtr closing = handle;
            handle = IntPtr.Zero;
            CloseHandle(closing);
        }

        internal static string ProcessIdentity(IntPtr process)
        {
            FILETIME creation;
            FILETIME exit;
            FILETIME kernel;
            FILETIME user;
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
                throw Failure("GetProcessTimes");
            ulong value = ((ulong)creation.dwHighDateTime << 32) | creation.dwLowDateTime;
            return value.ToString(CultureInfo.InvariantCulture);
        }
    }

    internal static class StrictJson
    {
        private const int MaximumJsonCharacters = 128 * 1024;

        internal static Dictionary<string, object> ParseObject(string text, string label)
        {
            if (text == null || text.Length == 0 || text.Length > MaximumJsonCharacters)
                throw new SafetyException(label + " is empty or too large");
            DuplicateKeyScanner scanner = new DuplicateKeyScanner(text);
            scanner.Scan();
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = MaximumJsonCharacters;
            object parsed = serializer.DeserializeObject(text);
            Dictionary<string, object> record = parsed as Dictionary<string, object>;
            if (record == null) throw new SafetyException(label + " must be a JSON object");
            return record;
        }

        internal static string Serialize(object value)
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = MaximumJsonCharacters;
            return serializer.Serialize(value);
        }

        internal static string CanonicalSerialize(object value)
        {
            StringBuilder builder = new StringBuilder();
            AppendCanonical(builder, value);
            return builder.ToString();
        }

        private static void AppendCanonical(StringBuilder builder, object value)
        {
            if (value == null) { builder.Append("null"); return; }
            string text = value as string;
            if (text != null) { AppendJsonString(builder, text); return; }
            if (value is bool) { builder.Append((bool)value ? "true" : "false"); return; }
            if (value is int)
            {
                builder.Append(((int)value).ToString(CultureInfo.InvariantCulture));
                return;
            }
            if (value is long)
            {
                builder.Append(((long)value).ToString(CultureInfo.InvariantCulture));
                return;
            }
            if (value is decimal)
            {
                decimal number = (decimal)value;
                if (Decimal.Truncate(number) != number)
                    throw new SafetyException("canonical JSON contains a non-integer number");
                builder.Append(number.ToString("0", CultureInfo.InvariantCulture));
                return;
            }
            object[] array = value as object[];
            if (array != null)
            {
                builder.Append('[');
                for (int index = 0; index < array.Length; index++)
                {
                    if (index > 0) builder.Append(',');
                    AppendCanonical(builder, array[index]);
                }
                builder.Append(']');
                return;
            }
            Dictionary<string, object> record = value as Dictionary<string, object>;
            if (record != null)
            {
                builder.Append('{');
                string[] keys = record.Keys.OrderBy(key => key, StringComparer.Ordinal).ToArray();
                for (int index = 0; index < keys.Length; index++)
                {
                    if (index > 0) builder.Append(',');
                    AppendJsonString(builder, keys[index]);
                    builder.Append(':');
                    AppendCanonical(builder, record[keys[index]]);
                }
                builder.Append('}');
                return;
            }
            throw new SafetyException("canonical JSON contains an unsupported value");
        }

        private static void AppendJsonString(StringBuilder builder, string value)
        {
            builder.Append('"');
            for (int index = 0; index < value.Length; index++)
            {
                char current = value[index];
                if (current == '"') { builder.Append("\\\""); continue; }
                if (current == '\\') { builder.Append("\\\\"); continue; }
                if (current == '\b') { builder.Append("\\b"); continue; }
                if (current == '\f') { builder.Append("\\f"); continue; }
                if (current == '\n') { builder.Append("\\n"); continue; }
                if (current == '\r') { builder.Append("\\r"); continue; }
                if (current == '\t') { builder.Append("\\t"); continue; }
                if (current < 0x20 ||
                    (Char.IsHighSurrogate(current) &&
                     (index + 1 >= value.Length || !Char.IsLowSurrogate(value[index + 1]))) ||
                    Char.IsLowSurrogate(current))
                {
                    builder.Append("\\u");
                    builder.Append(((int)current).ToString("x4", CultureInfo.InvariantCulture));
                    continue;
                }
                builder.Append(current);
                if (Char.IsHighSurrogate(current))
                {
                    index++;
                    builder.Append(value[index]);
                }
            }
            builder.Append('"');
        }

        internal static void ExactKeys(
            Dictionary<string, object> record,
            string label,
            params string[] expected)
        {
            if (record.Count != expected.Length || expected.Any(key => !record.ContainsKey(key)))
                throw new SafetyException(label + " has unknown or missing fields");
        }

        internal static string String(
            Dictionary<string, object> record,
            string key,
            string label,
            bool allowEmpty)
        {
            object raw;
            if (!record.TryGetValue(key, out raw))
                throw new SafetyException(label + " is missing");
            string value = raw as string;
            if (value == null || (!allowEmpty && value.Length == 0) ||
                value.Length > 4096 || value.IndexOf('\0') >= 0)
                throw new SafetyException(label + " is invalid");
            return value;
        }

        internal static int Integer(Dictionary<string, object> record, string key, string label)
        {
            object raw;
            if (!record.TryGetValue(key, out raw))
                throw new SafetyException(label + " is missing");
            long value;
            if (raw is int) value = (int)raw;
            else if (raw is long) value = (long)raw;
            else throw new SafetyException(label + " must be an integer");
            if (value < Int32.MinValue || value > Int32.MaxValue)
                throw new SafetyException(label + " is out of range");
            return (int)value;
        }

        internal static long SafeInteger(
            Dictionary<string, object> record,
            string key,
            string label)
        {
            object raw;
            if (!record.TryGetValue(key, out raw))
                throw new SafetyException(label + " is missing");
            decimal value;
            if (raw is int) value = (int)raw;
            else if (raw is long) value = (long)raw;
            else if (raw is decimal) value = (decimal)raw;
            else throw new SafetyException(label + " must be an integer");
            if (Decimal.Truncate(value) != value || value < 0 || value > 9007199254740991m)
                throw new SafetyException(label + " is out of range");
            return Decimal.ToInt64(value);
        }

        internal static Dictionary<string, object> Object(
            Dictionary<string, object> record,
            string key,
            string label)
        {
            object raw;
            if (!record.TryGetValue(key, out raw))
                throw new SafetyException(label + " is missing");
            Dictionary<string, object> value = raw as Dictionary<string, object>;
            if (value == null) throw new SafetyException(label + " must be an object");
            return value;
        }

        internal static object[] Array(
            Dictionary<string, object> record,
            string key,
            string label,
            int maximum)
        {
            object raw;
            if (!record.TryGetValue(key, out raw))
                throw new SafetyException(label + " is missing");
            object[] values = raw as object[];
            if (values == null || values.Length > maximum)
                throw new SafetyException(label + " must be a bounded array");
            return values;
        }

        internal static Dictionary<string, object> DecodeBase64Object(
            string encoded,
            string label)
        {
            if (encoded == null || encoded.Length == 0 || encoded.Length > 96 * 1024)
                throw new SafetyException(label + " base64 is invalid");
            byte[] bytes;
            try { bytes = Convert.FromBase64String(encoded); }
            catch { throw new SafetyException(label + " base64 is invalid"); }
            if (bytes.Length > 64 * 1024 || Convert.ToBase64String(bytes) != encoded)
                throw new SafetyException(label + " base64 is non-canonical or too large");
            string text;
            try { text = new UTF8Encoding(false, true).GetString(bytes); }
            catch { throw new SafetyException(label + " is not strict UTF-8"); }
            if (text.Length > 0 && text[0] == '\uFEFF')
                throw new SafetyException(label + " contains a BOM");
            return ParseObject(text, label);
        }

        private sealed class DuplicateKeyScanner
        {
            private readonly string text;
            private int index;

            internal DuplicateKeyScanner(string value) { text = value; }

            internal void Scan()
            {
                SkipWhitespace();
                Value();
                SkipWhitespace();
                if (index != text.Length) throw new SafetyException("JSON has trailing input");
            }

            private void Value()
            {
                if (index >= text.Length) throw new SafetyException("JSON value is missing");
                char current = text[index];
                if (current == '{') { Object(); return; }
                if (current == '[') { Array(); return; }
                if (current == '"') { String(); return; }
                if (TakeLiteral("true") || TakeLiteral("false") || TakeLiteral("null")) return;
                Number();
            }

            private void Object()
            {
                index++;
                SkipWhitespace();
                if (Take('}')) return;
                HashSet<string> keys = new HashSet<string>(StringComparer.Ordinal);
                while (true)
                {
                    if (index >= text.Length || text[index] != '"')
                        throw new SafetyException("JSON object key is invalid");
                    string key = String();
                    if (!keys.Add(key)) throw new SafetyException("JSON contains a duplicate key");
                    SkipWhitespace();
                    Expect(':');
                    SkipWhitespace();
                    Value();
                    SkipWhitespace();
                    if (Take('}')) return;
                    Expect(',');
                    SkipWhitespace();
                }
            }

            private void Array()
            {
                index++;
                SkipWhitespace();
                if (Take(']')) return;
                while (true)
                {
                    Value();
                    SkipWhitespace();
                    if (Take(']')) return;
                    Expect(',');
                    SkipWhitespace();
                }
            }

            private string String()
            {
                int start = index;
                Expect('"');
                while (index < text.Length)
                {
                    char current = text[index++];
                    if (current == '"')
                    {
                        string token = text.Substring(start, index - start);
                        JavaScriptSerializer serializer = new JavaScriptSerializer();
                        return serializer.Deserialize<string>(token);
                    }
                    if (current == '\\')
                    {
                        if (index >= text.Length) throw new SafetyException("JSON escape is invalid");
                        char escape = text[index++];
                        if (escape == 'u')
                        {
                            if (index + 4 > text.Length ||
                                text.Substring(index, 4).Any(value => !Uri.IsHexDigit(value)))
                                throw new SafetyException("JSON Unicode escape is invalid");
                            index += 4;
                        }
                        else if ("\"\\/bfnrt".IndexOf(escape) < 0)
                            throw new SafetyException("JSON escape is invalid");
                    }
                    else if (current < 0x20)
                        throw new SafetyException("JSON string contains a control character");
                }
                throw new SafetyException("JSON string is unterminated");
            }

            private void Number()
            {
                int start = index;
                if (Take('-')) { }
                if (Take('0')) { }
                else
                {
                    if (index >= text.Length || text[index] < '1' || text[index] > '9')
                        throw new SafetyException("JSON number is invalid");
                    while (index < text.Length && Char.IsDigit(text[index])) index++;
                }
                if (Take('.'))
                {
                    int fraction = index;
                    while (index < text.Length && Char.IsDigit(text[index])) index++;
                    if (fraction == index) throw new SafetyException("JSON number is invalid");
                }
                if (index < text.Length && (text[index] == 'e' || text[index] == 'E'))
                {
                    index++;
                    if (index < text.Length && (text[index] == '+' || text[index] == '-')) index++;
                    int exponent = index;
                    while (index < text.Length && Char.IsDigit(text[index])) index++;
                    if (exponent == index) throw new SafetyException("JSON number is invalid");
                }
                if (start == index) throw new SafetyException("JSON value is invalid");
            }

            private bool TakeLiteral(string value)
            {
                if (index + value.Length > text.Length ||
                    System.String.CompareOrdinal(text, index, value, 0, value.Length) != 0) return false;
                index += value.Length;
                return true;
            }

            private bool Take(char value)
            {
                if (index >= text.Length || text[index] != value) return false;
                index++;
                return true;
            }

            private void Expect(char value)
            {
                if (!Take(value)) throw new SafetyException("JSON syntax is invalid");
            }

            private void SkipWhitespace()
            {
                while (index < text.Length &&
                    (text[index] == ' ' || text[index] == '\t' ||
                     text[index] == '\r' || text[index] == '\n')) index++;
            }
        }
    }

    internal sealed class Timeouts
    {
        internal int HandshakeMs;
        internal int NaturalDrainMs;
        internal int TerminateMs;
        internal int AckMs;
        internal int PollMs;

        internal static Timeouts Parse(string encoded)
        {
            Dictionary<string, object> record = StrictJson.DecodeBase64Object(encoded, "timeouts");
            StrictJson.ExactKeys(record, "timeouts",
                "handshakeMs", "naturalDrainMs", "terminateMs", "ackMs", "pollMs");
            Timeouts result = new Timeouts();
            result.HandshakeMs = Range(StrictJson.Integer(record, "handshakeMs", "handshakeMs"), 10, 60000);
            result.NaturalDrainMs = Range(StrictJson.Integer(record, "naturalDrainMs", "naturalDrainMs"), 0, 60000);
            result.TerminateMs = Range(StrictJson.Integer(record, "terminateMs", "terminateMs"), 1, 60000);
            result.AckMs = Range(StrictJson.Integer(record, "ackMs", "ackMs"), 10, 60000);
            result.PollMs = Range(StrictJson.Integer(record, "pollMs", "pollMs"), 1, 1000);
            return result;
        }

        private static int Range(int value, int minimum, int maximum)
        {
            if (value < minimum || value > maximum)
                throw new SafetyException("timeout is outside its supported range");
            return value;
        }
    }

    internal sealed class ControlFrame
    {
        internal string Line;
        internal bool EndOfFile;
        internal Exception Error;
    }

    internal sealed class ControlReader : IDisposable
    {
        private const int MaximumLineCharacters = 128 * 1024;
        private readonly BlockingCollection<ControlFrame> frames = new BlockingCollection<ControlFrame>();
        private readonly Thread thread;

        internal ControlReader()
        {
            thread = new Thread(ReadLoop);
            thread.IsBackground = true;
            thread.Name = "coding-x-windows-supervisor-control";
            thread.Start();
        }

        private void ReadLoop()
        {
            try
            {
                while (true)
                {
                    StringBuilder line = new StringBuilder();
                    while (true)
                    {
                        int value = Console.In.Read();
                        if (value < 0)
                        {
                            if (line.Length != 0)
                                frames.Add(new ControlFrame { Error = new SafetyException("control line ended without newline") });
                            frames.Add(new ControlFrame { EndOfFile = true });
                            return;
                        }
                        if (value == '\n') break;
                        if (value == '\r') continue;
                        if (line.Length >= MaximumLineCharacters)
                            throw new SafetyException("control line exceeds its limit");
                        line.Append((char)value);
                    }
                    frames.Add(new ControlFrame { Line = line.ToString() });
                }
            }
            catch (Exception error)
            {
                frames.Add(new ControlFrame { Error = error });
            }
        }

        internal ControlFrame Take(int timeoutMs)
        {
            ControlFrame frame;
            if (!frames.TryTake(out frame, timeoutMs))
                throw new SafetyException("control handshake timed out");
            if (frame.Error != null) throw new SafetyException(frame.Error.Message);
            return frame;
        }

        internal bool TryTake(int timeoutMs, out ControlFrame frame)
        {
            if (!frames.TryTake(out frame, timeoutMs)) return false;
            if (frame.Error != null) throw new SafetyException(frame.Error.Message);
            return true;
        }

        public void Dispose() { frames.Dispose(); }
    }

    internal static class ProtocolWriter
    {
        private static readonly object Gate = new object();
        private static bool connected = true;

        internal static bool Connected { get { lock (Gate) { return connected; } } }

        internal static void Send(Dictionary<string, object> message)
        {
            lock (Gate)
            {
                if (!connected) return;
                try
                {
                    Console.Out.WriteLine(StrictJson.Serialize(message));
                    Console.Out.Flush();
                }
                catch
                {
                    connected = false;
                }
            }
        }

        internal static void Disconnect() { lock (Gate) { connected = false; } }

        internal static void TryFailure(string message)
        {
            string bounded = (message ?? "Windows supervisor failed").Replace("\r", " ").Replace("\n", " ");
            if (bounded.Length > 512) bounded = bounded.Substring(0, 512);
            Send(new Dictionary<string, object> {
                { "schemaVersion", 1 }, { "type", "FAILURE" }, { "message", bounded }
            });
        }
    }

    internal sealed class EnvironmentEntry
    {
        internal string Name;
        internal string Value;
    }

    internal sealed class TargetSpec
    {
        internal string OperationId;
        internal string WorkspacePath;
        internal string Executable;
        internal string[] Arguments;
        internal string WorkingDirectory;
        internal EnvironmentEntry[] Environment;

        internal static TargetSpec Parse(Dictionary<string, object> envelope)
        {
            StrictJson.ExactKeys(envelope, "DATA envelope",
                "schemaVersion", "type", "workspacePath", "messageBase64");
            if (StrictJson.Integer(envelope, "schemaVersion", "DATA schemaVersion") != 1 ||
                StrictJson.String(envelope, "type", "DATA type", false) != "DATA")
                throw new SafetyException("DATA envelope is invalid");
            string workspace = StrictJson.String(envelope, "workspacePath", "workspacePath", false);
            if (!Path.IsPathRooted(workspace) || Path.GetFullPath(workspace) != workspace)
                throw new SafetyException("workspacePath must be canonical and absolute");
            Dictionary<string, object> message = StrictJson.DecodeBase64Object(
                StrictJson.String(envelope, "messageBase64", "DATA messageBase64", false), "DATA");
            StrictJson.ExactKeys(message, "DATA", "schemaVersion", "type", "operationId", "target");
            if (StrictJson.Integer(message, "schemaVersion", "DATA schemaVersion") != 1 ||
                StrictJson.String(message, "type", "DATA type", false) != "DATA")
                throw new SafetyException("DATA message is invalid");
            string operationId = StrictJson.String(message, "operationId", "operationId", false);
            if (!Patterns.Uuid.IsMatch(operationId)) throw new SafetyException("operationId is invalid");
            Dictionary<string, object> target = StrictJson.Object(message, "target", "target");
            StrictJson.ExactKeys(target, "target", "executable", "args", "cwd", "environment");
            string executable = StrictJson.String(target, "executable", "target executable", false);
            string cwd = StrictJson.String(target, "cwd", "target cwd", false);
            if (!Path.IsPathRooted(executable) || !Path.IsPathRooted(cwd) ||
                Path.GetFullPath(executable) != executable || Path.GetFullPath(cwd) != cwd)
                throw new SafetyException("target executable and cwd must be canonical absolute paths");
            object[] rawArguments = StrictJson.Array(target, "args", "target args", 256);
            string[] arguments = rawArguments.Select((value, index) => {
                string item = value as string;
                if (item == null || item.Length > 4096 || item.IndexOf('\0') >= 0)
                    throw new SafetyException("target argument is invalid");
                return item;
            }).ToArray();
            object[] rawEnvironment = StrictJson.Array(target, "environment", "target environment", 256);
            HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            List<EnvironmentEntry> environment = new List<EnvironmentEntry>();
            foreach (object raw in rawEnvironment)
            {
                Dictionary<string, object> entry = raw as Dictionary<string, object>;
                if (entry == null) throw new SafetyException("target environment entry is invalid");
                StrictJson.ExactKeys(entry, "target environment entry", "name", "value");
                string name = StrictJson.String(entry, "name", "environment name", false);
                string value = StrictJson.String(entry, "value", "environment value", true);
                if (!Patterns.EnvironmentName.IsMatch(name) || !names.Add(name))
                    throw new SafetyException("target environment name is invalid or duplicated");
                environment.Add(new EnvironmentEntry { Name = name, Value = value });
            }
            return new TargetSpec {
                OperationId = operationId,
                WorkspacePath = workspace,
                Executable = executable,
                Arguments = arguments,
                WorkingDirectory = cwd,
                Environment = environment.ToArray()
            };
        }
    }

}
