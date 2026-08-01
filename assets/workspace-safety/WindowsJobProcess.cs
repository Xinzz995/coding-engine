namespace CodingX.WorkspaceSafety
{
    using System;
    using System.Collections.Generic;
    using System.Globalization;
    using System.IO;
    using System.Linq;
    using System.Runtime.InteropServices;
    using System.Security.Cryptography;
    using System.Text;
    using System.Threading;

    internal static class Hashing
    {
        internal static string Digest(byte[] bytes)
        {
            using (SHA256 hash = SHA256.Create())
            {
                return "sha256:" + String.Concat(hash.ComputeHash(bytes).Select(value =>
                    value.ToString("x2", CultureInfo.InvariantCulture)).ToArray());
            }
        }

        internal static byte[] Utf8(string value)
        {
            return new UTF8Encoding(false, true).GetBytes(value);
        }
    }

    internal sealed class OutputPipe : IDisposable
    {
        private readonly string stream;
        private readonly Thread thread;
        private IntPtr readHandle;
        internal IntPtr ChildHandle;
        internal volatile bool EndOfFile;
        internal volatile Exception Error;

        internal OutputPipe(string name)
        {
            stream = name;
            try
            {
                SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
                attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
                attributes.bInheritHandle = true;
                if (!Native.CreatePipe(out readHandle, out ChildHandle, ref attributes, 0))
                    throw Native.Failure("CreatePipe");
                if (!Native.SetHandleInformation(readHandle, Native.HANDLE_FLAG_INHERIT, 0))
                    throw Native.Failure("SetHandleInformation");
            }
            catch
            {
                Native.Close(ref readHandle);
                Native.Close(ref ChildHandle);
                throw;
            }
            thread = new Thread(Pump);
            thread.IsBackground = true;
            thread.Name = "coding-x-windows-" + name;
        }

        internal void Start() { thread.Start(); }

        internal void CloseChildHandle() { Native.Close(ref ChildHandle); }

        private void Pump()
        {
            try
            {
                byte[] buffer = new byte[16384];
                while (true)
                {
                    uint read;
                    if (!Native.ReadFile(readHandle, buffer, (uint)buffer.Length, out read, IntPtr.Zero))
                    {
                        int code = Marshal.GetLastWin32Error();
                        if (code == 109 || code == 38) break;
                        throw Native.Failure("ReadFile");
                    }
                    if (read == 0) break;
                    byte[] chunk = new byte[read];
                    Buffer.BlockCopy(buffer, 0, chunk, 0, (int)read);
                    ProtocolWriter.Send(new Dictionary<string, object> {
                        { "schemaVersion", 1 }, { "type", "OUTPUT" },
                        { "stream", stream }, { "data", Convert.ToBase64String(chunk) }
                    });
                }
            }
            catch (Exception error) { Error = error; }
            finally
            {
                Native.Close(ref readHandle);
                EndOfFile = true;
            }
        }

        public void Dispose()
        {
            CloseChildHandle();
            Native.Close(ref readHandle);
        }
    }

    internal sealed class JobTarget : IDisposable
    {
        private IntPtr job;
        private IntPtr process;
        private IntPtr thread;
        private OutputPipe standardOutput;
        private OutputPipe standardError;
        private uint? exitCode;

        internal uint ProcessId;
        internal string ProcessIdentity;
        internal bool WasResumed;

        internal bool OutputEnded
        {
            get
            {
                if (standardOutput.Error != null || standardError.Error != null)
                    throw new SafetyException("target output pipe could not be drained");
                return standardOutput.EndOfFile && standardError.EndOfFile;
            }
        }

        internal JobTarget(TargetSpec target)
        {
            AssertOrdinaryPath(target.Executable, false);
            AssertOrdinaryPath(target.WorkingDirectory, true);
            try
            {
                standardOutput = new OutputPipe("stdout");
                standardError = new OutputPipe("stderr");
                Create(target);
            }
            catch
            {
                Dispose();
                throw;
            }
        }

        private static void AssertOrdinaryPath(string path, bool directory)
        {
            FileAttributes attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) != 0 ||
                (((attributes & FileAttributes.Directory) != 0) != directory))
                throw new SafetyException("target path must be an ordinary " + (directory ? "directory" : "file"));
        }

        private static string QuoteArgument(string value)
        {
            if (value.Length != 0 && value.All(character =>
                character != ' ' && character != '\t' && character != '\n' && character != '\v' && character != '"'))
                return value;
            StringBuilder quoted = new StringBuilder("\"");
            int slashes = 0;
            foreach (char character in value)
            {
                if (character == '\\') { slashes++; continue; }
                if (character == '"')
                {
                    quoted.Append('\\', slashes * 2 + 1);
                    quoted.Append('"');
                    slashes = 0;
                    continue;
                }
                quoted.Append('\\', slashes);
                slashes = 0;
                quoted.Append(character);
            }
            quoted.Append('\\', slashes * 2);
            quoted.Append('"');
            return quoted.ToString();
        }

        private static StringBuilder BuildCommandLine(TargetSpec target, out string application)
        {
            string extension = Path.GetExtension(target.Executable);
            if (String.Equals(extension, ".cmd", StringComparison.OrdinalIgnoreCase) ||
                String.Equals(extension, ".bat", StringComparison.OrdinalIgnoreCase))
            {
                if (target.Executable.IndexOfAny(
                    new char[] { '"', '%', '\r', '\n', '&', '|', '<', '>', '^', '!' }) >= 0)
                    throw new SafetyException("cmd target path is outside the supported safe subset");
                foreach (string argument in target.Arguments)
                {
                    if (argument.IndexOfAny(
                        new char[] { '"', '%', '\r', '\n', '&', '|', '<', '>', '^', '!' }) >= 0)
                        throw new SafetyException("cmd target argument is outside the supported safe subset");
                }
                string windows = Environment.GetEnvironmentVariable("SystemRoot");
                application = Path.Combine(windows, "System32", "cmd.exe");
                StringBuilder command = new StringBuilder(QuoteArgument(application));
                command.Append(" /d /s /v:off /c \"\"").Append(target.Executable).Append('"');
                foreach (string argument in target.Arguments)
                    command.Append(" \"").Append(argument).Append('"');
                command.Append('"');
                return command;
            }
            string executableName = Path.GetFileName(target.Executable);
            if (String.Equals(executableName, "cmd", StringComparison.OrdinalIgnoreCase) ||
                String.Equals(executableName, "cmd.exe", StringComparison.OrdinalIgnoreCase))
            {
                string windows = Environment.GetEnvironmentVariable("SystemRoot");
                string commandProcessor = Path.GetFullPath(
                    Path.Combine(windows, "System32", "cmd.exe"));
                if (!String.Equals(commandProcessor, Path.GetFullPath(target.Executable),
                    StringComparison.OrdinalIgnoreCase))
                    throw new SafetyException("only the fixed system cmd.exe target is supported");
                if (target.Arguments.Length != 4 ||
                    !String.Equals(target.Arguments[0], "/d", StringComparison.OrdinalIgnoreCase) ||
                    !String.Equals(target.Arguments[1], "/s", StringComparison.OrdinalIgnoreCase) ||
                    !String.Equals(target.Arguments[2], "/c", StringComparison.OrdinalIgnoreCase))
                    throw new SafetyException("cmd.exe target must use the fixed /d /s /c shape");
                application = commandProcessor;
                return new StringBuilder(QuoteArgument(application))
                    .Append(" /d /s /c \"").Append(target.Arguments[3]).Append('"');
            }
            application = target.Executable;
            return new StringBuilder(String.Join(" ",
                new string[] { application }.Concat(target.Arguments).Select(QuoteArgument).ToArray()));
        }

        private static IntPtr BuildEnvironment(EnvironmentEntry[] entries)
        {
            StringBuilder block = new StringBuilder();
            foreach (EnvironmentEntry entry in entries.OrderBy(value => value.Name,
                StringComparer.OrdinalIgnoreCase))
            {
                block.Append(entry.Name).Append('=').Append(entry.Value).Append('\0');
            }
            block.Append('\0');
            if (block.Length > 32767) throw new SafetyException("target environment is too large");
            return Marshal.StringToHGlobalUni(block.ToString());
        }

        private static void SetJobKillOnClose(IntPtr jobHandle)
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr value = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, value, false);
                if (!Native.SetInformationJobObject(jobHandle,
                    Native.JobObjectExtendedLimitInformation, value, (uint)size))
                    throw Native.Failure("SetInformationJobObject");
                uint returned;
                if (!Native.QueryInformationJobObject(jobHandle,
                    Native.JobObjectExtendedLimitInformation, value, (uint)size, out returned))
                    throw Native.Failure("QueryInformationJobObject");
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION observed =
                    (JOBOBJECT_EXTENDED_LIMIT_INFORMATION)Marshal.PtrToStructure(value,
                        typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                if (observed.BasicLimitInformation.LimitFlags != Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
                    throw new SafetyException("Job limits do not match the fixed policy");
            }
            finally { Marshal.FreeHGlobal(value); }
        }

        private static uint ActiveProcesses(IntPtr jobHandle)
        {
            int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            IntPtr value = Marshal.AllocHGlobal(size);
            try
            {
                uint returned;
                if (!Native.QueryInformationJobObject(jobHandle,
                    Native.JobObjectBasicAccountingInformation, value, (uint)size, out returned))
                    throw Native.Failure("QueryInformationJobObject");
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting =
                    (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(value,
                        typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
                return accounting.ActiveProcesses;
            }
            finally { Marshal.FreeHGlobal(value); }
        }

        private void Create(TargetSpec target)
        {
            job = Native.CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw Native.Failure("CreateJobObjectW");
            SetJobKillOnClose(job);
            if (ActiveProcesses(job) != 0) throw new SafetyException("new Job was not empty");

            SECURITY_ATTRIBUTES inheritable = new SECURITY_ATTRIBUTES();
            inheritable.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            inheritable.bInheritHandle = true;
            IntPtr standardInput = Native.CreateFileW("NUL", Native.GENERIC_READ,
                Native.FILE_SHARE_READ, ref inheritable, Native.OPEN_EXISTING,
                Native.FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            if (standardInput == Native.InvalidHandleValue) throw Native.Failure("CreateFileW");

            IntPtr attributeSize = IntPtr.Zero;
            Native.InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeSize);
            IntPtr attributes = Marshal.AllocHGlobal(attributeSize);
            IntPtr jobValue = IntPtr.Zero;
            IntPtr handlesValue = IntPtr.Zero;
            IntPtr environment = IntPtr.Zero;
            bool attributesInitialized = false;
            try
            {
                if (!Native.InitializeProcThreadAttributeList(attributes, 2, 0, ref attributeSize))
                    throw Native.Failure("InitializeProcThreadAttributeList");
                attributesInitialized = true;
                jobValue = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobValue, job);
                if (!Native.UpdateProcThreadAttribute(attributes, 0,
                    new UIntPtr(Native.PROC_THREAD_ATTRIBUTE_JOB_LIST), jobValue,
                    new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                    throw Native.Failure("UpdateProcThreadAttribute(JOB_LIST)");
                IntPtr[] inherited = new IntPtr[] {
                    standardInput, standardOutput.ChildHandle, standardError.ChildHandle
                };
                handlesValue = Marshal.AllocHGlobal(IntPtr.Size * inherited.Length);
                for (int index = 0; index < inherited.Length; index++)
                    Marshal.WriteIntPtr(handlesValue, index * IntPtr.Size, inherited[index]);
                if (!Native.UpdateProcThreadAttribute(attributes, 0,
                    new UIntPtr(Native.PROC_THREAD_ATTRIBUTE_HANDLE_LIST), handlesValue,
                    new IntPtr(IntPtr.Size * inherited.Length), IntPtr.Zero, IntPtr.Zero))
                    throw Native.Failure("UpdateProcThreadAttribute(HANDLE_LIST)");

                string application;
                StringBuilder commandLine = BuildCommandLine(target, out application);
                if (commandLine.Length > 32767)
                    throw new SafetyException("target command line is too large");
                AssertOrdinaryPath(application, false);
                environment = BuildEnvironment(target.Environment);
                STARTUPINFOEX startup = new STARTUPINFOEX();
                startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.StartupInfo.dwFlags = Native.STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = standardInput;
                startup.StartupInfo.hStdOutput = standardOutput.ChildHandle;
                startup.StartupInfo.hStdError = standardError.ChildHandle;
                startup.lpAttributeList = attributes;
                PROCESS_INFORMATION created;
                uint flags = Native.EXTENDED_STARTUPINFO_PRESENT |
                    Native.CREATE_UNICODE_ENVIRONMENT | Native.CREATE_SUSPENDED |
                    Native.CREATE_NO_WINDOW;
                if (!Native.CreateProcessW(application, commandLine, IntPtr.Zero, IntPtr.Zero,
                    true, flags, environment, target.WorkingDirectory, ref startup, out created))
                    throw Native.Failure("CreateProcessW");
                process = created.hProcess;
                thread = created.hThread;
                ProcessId = created.dwProcessId;
                ProcessIdentity = Native.ProcessIdentity(process);
            }
            finally
            {
                Native.Close(ref standardInput);
                standardOutput.CloseChildHandle();
                standardError.CloseChildHandle();
                if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
                if (handlesValue != IntPtr.Zero) Marshal.FreeHGlobal(handlesValue);
                if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue);
                if (attributes != IntPtr.Zero)
                {
                    if (attributesInitialized) Native.DeleteProcThreadAttributeList(attributes);
                    Marshal.FreeHGlobal(attributes);
                }
            }
            if (ActiveProcesses(job) != 1)
                throw new SafetyException("Job did not atomically contain exactly one suspended target");
            standardOutput.Start();
            standardError.Start();
        }

        internal void Resume()
        {
            if (thread == IntPtr.Zero || WasResumed) throw new SafetyException("target cannot be resumed twice");
            uint previous = Native.ResumeThread(thread);
            if (previous == UInt32.MaxValue) throw Native.Failure("ResumeThread");
            Native.Close(ref thread);
            WasResumed = true;
        }

        internal bool CaptureRootResult()
        {
            if (process == IntPtr.Zero) return exitCode.HasValue;
            uint wait = Native.WaitForSingleObject(process, 0);
            if (wait == Native.WAIT_TIMEOUT) return false;
            if (wait != Native.WAIT_OBJECT_0) throw Native.Failure("WaitForSingleObject");
            uint value;
            if (!Native.GetExitCodeProcess(process, out value) || value == Native.STILL_ACTIVE)
                throw Native.Failure("GetExitCodeProcess");
            exitCode = value;
            Native.Close(ref process);
            return true;
        }

        internal uint RootExitCode
        {
            get
            {
                if (!exitCode.HasValue) throw new SafetyException("root result is unavailable");
                return exitCode.Value;
            }
        }

        internal uint ActiveCount { get { return ActiveProcesses(job); } }

        internal bool Drained { get { return ActiveProcesses(job) == 0 && OutputEnded; } }

        internal void Terminate()
        {
            if (job != IntPtr.Zero && ActiveProcesses(job) != 0 &&
                !Native.TerminateJobObject(job, Native.TERMINATION_EXIT_CODE))
                throw Native.Failure("TerminateJobObject");
            Native.Close(ref thread);
        }

        internal bool WaitForEmptyAndEof(MonotonicDeadline deadline, int pollMs)
        {
            while (!deadline.Expired)
            {
                CaptureRootResult();
                if (ActiveProcesses(job) == 0 && OutputEnded) return true;
                Thread.Sleep(Math.Min(pollMs, deadline.RemainingMilliseconds));
            }
            return ActiveProcesses(job) == 0 && OutputEnded;
        }

        internal void CloseJob() { Native.Close(ref job); }

        public void Dispose()
        {
            try { if (job != IntPtr.Zero && ActiveProcesses(job) != 0) Native.TerminateJobObject(job, Native.TERMINATION_EXIT_CODE); }
            catch { }
            Native.Close(ref thread);
            Native.Close(ref process);
            Native.Close(ref job);
            if (standardOutput != null) standardOutput.Dispose();
            if (standardError != null) standardError.Dispose();
        }
    }

}
