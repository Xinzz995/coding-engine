using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace CodingX.WorkspaceSafety
{
    internal static class WindowsSupervisorProgram
    {
        private const int ExitFailure = 2;
        private const int StandardInputHandle = -10;
        private const int StandardOutputHandle = -11;
        private const int StandardErrorHandle = -12;
        private const uint FileTypePipe = 0x0003;
        private const int MaximumExecutableBytes = 4 * 1024 * 1024;
        private const int MaximumTimeoutArgumentCharacters = 16 * 1024;
        private const string DigestFlag = "--expected-helper-digest";
        private const string TimeoutsFlag = "--timeouts-base64";
        private const string ExecutableDigestDomain = "coding-x-windows-supervisor-exe-v1\0";

        private static int Main(string[] arguments)
        {
            try
            {
                ValidateProcessIsolation();
                BindStrictUtf8Pipes();
                if (arguments == null || arguments.Length != 4 ||
                    !String.Equals(arguments[0], DigestFlag, StringComparison.Ordinal) ||
                    !String.Equals(arguments[2], TimeoutsFlag, StringComparison.Ordinal))
                    throw new SafetyException("invalid supervisor command line");

                string expectedDigest = arguments[1];
                string timeoutsBase64 = arguments[3];
                if (!Patterns.Digest.IsMatch(expectedDigest ?? String.Empty))
                    throw new SafetyException("invalid fixed helper digest");
                if (String.IsNullOrEmpty(timeoutsBase64) ||
                    timeoutsBase64.Length > MaximumTimeoutArgumentCharacters ||
                    timeoutsBase64.IndexOf('\0') >= 0)
                    throw new SafetyException("invalid supervisor timeouts argument");

                if (!String.Equals(ExecutableDigest(), expectedDigest, StringComparison.Ordinal))
                    throw new SafetyException("fixed supervisor executable digest mismatch");

                return WindowsJobSupervisor.Run(expectedDigest, timeoutsBase64);
            }
            catch (Exception error)
            {
                ProtocolWriter.TryFailure(error is SafetyException
                    ? error.Message
                    : "Windows supervisor initialization failed");
                return ExitFailure;
            }
        }

        private static void ValidateProcessIsolation()
        {
            if (GetConsoleWindow() != IntPtr.Zero)
                throw new SafetyException("supervisor must not be attached to a console");
            RequirePipe(StandardInputHandle, "stdin");
            RequirePipe(StandardOutputHandle, "stdout");
            RequirePipe(StandardErrorHandle, "stderr");
        }

        private static void RequirePipe(int identifier, string label)
        {
            IntPtr handle = GetStdHandle(identifier);
            if (handle == IntPtr.Zero || handle == new IntPtr(-1) ||
                GetFileType(handle) != FileTypePipe)
                throw new SafetyException("supervisor " + label + " must be an inherited pipe");
        }

        private static void BindStrictUtf8Pipes()
        {
            UTF8Encoding utf8 = new UTF8Encoding(false, true);
            StreamReader input = new StreamReader(
                Console.OpenStandardInput(), utf8, false, 4096, false);
            StreamWriter output = new StreamWriter(
                Console.OpenStandardOutput(), utf8, 4096, false);
            StreamWriter error = new StreamWriter(
                Console.OpenStandardError(), utf8, 4096, false);
            output.NewLine = "\n";
            error.NewLine = "\n";
            output.AutoFlush = true;
            error.AutoFlush = true;
            Console.SetIn(input);
            Console.SetOut(output);
            Console.SetError(error);
        }

        private static string ExecutableDigest()
        {
            string path = typeof(WindowsSupervisorProgram).Assembly.Location;
            if (String.IsNullOrEmpty(path) || !Path.IsPathRooted(path))
                throw new SafetyException("supervisor executable path is unavailable");
            path = Path.GetFullPath(path);
            FileInfo information = new FileInfo(path);
            if (!information.Exists || information.Length <= 0 ||
                information.Length > MaximumExecutableBytes)
                throw new SafetyException("supervisor executable is outside its size limit");

            byte[] executable = File.ReadAllBytes(path);
            if (executable.LongLength != information.Length)
                throw new SafetyException("supervisor executable changed during read");
            byte[] domain = new UTF8Encoding(false, true).GetBytes(ExecutableDigestDomain);
            byte[] digestInput = new byte[domain.Length + executable.Length];
            Buffer.BlockCopy(domain, 0, digestInput, 0, domain.Length);
            Buffer.BlockCopy(executable, 0, digestInput, domain.Length, executable.Length);
            return Hashing.Digest(digestInput);
        }

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetConsoleWindow();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int standardHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint GetFileType(IntPtr handle);
    }
}
