using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

namespace CodingX.WorkspaceSafety.Tests
{
    public static class WindowsBreakawayAttempt
    {
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
        private const int ERROR_ACCESS_DENIED = 5;

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

        public static int Run(string nodePath, string escapeMarker, string outcomePath)
        {
            PROCESS_INFORMATION child = new PROCESS_INFORMATION();
            try
            {
                string markerBase64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(escapeMarker));
                string script = "const p=Buffer.from('" + markerBase64 +
                    "','base64').toString('utf8');require('node:fs').writeFileSync(p,'escaped')";
                string[] arguments = new string[] { nodePath, "-e", script };
                StringBuilder commandLine = new StringBuilder(String.Join(" ",
                    arguments.Select(Quote).ToArray()));
                STARTUPINFO startup = new STARTUPINFO();
                startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                bool created = CreateProcessW(nodePath, commandLine, IntPtr.Zero, IntPtr.Zero,
                    false, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT |
                    CREATE_BREAKAWAY_FROM_JOB, IntPtr.Zero, Path.GetDirectoryName(outcomePath),
                    ref startup, out child);
                int error = created ? 0 : Marshal.GetLastWin32Error();
                if (created)
                {
                    TerminateProcess(child.hProcess, 2);
                    File.WriteAllText(outcomePath,
                        "{\"allowed\":true,\"error\":0}", new UTF8Encoding(false));
                    return 2;
                }
                File.WriteAllText(outcomePath, "{\"allowed\":false,\"error\":" +
                    error.ToString(CultureInfo.InvariantCulture) + "}", new UTF8Encoding(false));
                return error == ERROR_ACCESS_DENIED ? 0 : 3;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                return 2;
            }
            finally
            {
                if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
                if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
            }
        }
    }
}
