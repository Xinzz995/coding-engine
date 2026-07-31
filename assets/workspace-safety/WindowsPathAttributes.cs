using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace CodingX.WorkspaceSafety
{
    internal static class WindowsPathAttributes
    {
        internal const uint InvalidFileAttributes = 0xffffffff;
        internal const uint FileAttributeDirectory = 0x10;
        internal const uint FileAttributeReparsePoint = 0x400;

        private const int ErrorFileNotFound = 2;
        private const int ErrorNoMoreFiles = 18;
        private const int MaximumPathCharacters = 32767;
        private const int MaximumNativeEntries = 200001;
        private static readonly IntPtr InvalidFindHandle = new IntPtr(-1);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct FindData
        {
            internal uint FileAttributes;
            internal uint CreationTimeLow;
            internal uint CreationTimeHigh;
            internal uint LastAccessTimeLow;
            internal uint LastAccessTimeHigh;
            internal uint LastWriteTimeLow;
            internal uint LastWriteTimeHigh;
            internal uint FileSizeHigh;
            internal uint FileSizeLow;
            internal uint Reserved0;
            internal uint Reserved1;

            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            internal string FileName;

            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)]
            internal string AlternateFileName;
        }

        [DllImport(
            "kernel32.dll",
            CharSet = CharSet.Unicode,
            ExactSpelling = true,
            SetLastError = true)]
        private static extern uint GetFileAttributesW(string fileName);

        [DllImport(
            "kernel32.dll",
            CharSet = CharSet.Unicode,
            ExactSpelling = true,
            SetLastError = true)]
        private static extern IntPtr FindFirstFileW(string fileName, out FindData findData);

        [DllImport(
            "kernel32.dll",
            CharSet = CharSet.Unicode,
            ExactSpelling = true,
            SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FindNextFileW(IntPtr findHandle, out FindData findData);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FindClose(IntPtr findHandle);

        internal static string ExtendedPath(string path)
        {
            string normalized = ValidateAndNormalizeAbsolutePath(path);
            string extended;
            if (normalized.StartsWith(@"\\?\", StringComparison.Ordinal))
                extended = normalized;
            else if (normalized.StartsWith(@"\\", StringComparison.Ordinal))
                extended = @"\\?\UNC\" + normalized.Substring(2);
            else
                extended = @"\\?\" + normalized;
            if (extended.Length > MaximumPathCharacters)
                throw new ArgumentException("path is outside the supported boundary");
            return extended;
        }

        internal static uint Read(string path, out int error)
        {
            uint attributes = GetFileAttributesW(ExtendedPath(path));
            error = attributes == InvalidFileAttributes ? Marshal.GetLastWin32Error() : 0;
            return attributes;
        }

        internal static IEnumerable<string> Entries(string path)
        {
            return EnumerateEntries(path, null);
        }

        internal static IEnumerable<string> Entries(string path, string exactName)
        {
            ValidateEntryName(exactName);
            return EnumerateEntries(path, exactName);
        }

        internal static string CombineChild(string parent, string name)
        {
            ValidateEntryName(name);
            string normalizedParent = ValidateAndNormalizeAbsolutePath(parent);
            string combined = normalizedParent.EndsWith(@"\", StringComparison.Ordinal)
                ? normalizedParent + name
                : normalizedParent + @"\" + name;
            if (combined.Length > MaximumPathCharacters)
                throw new ArgumentException("path is outside the supported boundary");
            return combined;
        }

        private static IEnumerable<string> EnumerateEntries(string path, string exactName)
        {
            string query = ExtendedPath(path).TrimEnd('\\') + @"\*";
            if (query.Length > MaximumPathCharacters)
                throw new ArgumentException("path is outside the supported boundary");

            FindData data;
            IntPtr handle = FindFirstFileW(query, out data);
            if (handle == InvalidFindHandle)
            {
                int error = Marshal.GetLastWin32Error();
                if (error == ErrorFileNotFound)
                    yield break;
                throw new Win32Exception(error, "native directory enumeration failed");
            }

            bool closeRequired = true;
            int entryCount = 0;
            try
            {
                while (true)
                {
                    string name = data.FileName;
                    if (!String.Equals(name, ".", StringComparison.Ordinal) &&
                        !String.Equals(name, "..", StringComparison.Ordinal))
                    {
                        ValidateEntryName(name);
                        entryCount++;
                        if (entryCount > MaximumNativeEntries)
                            throw new InvalidOperationException(
                                "native directory enumeration exceeded its boundary");
                        if (exactName == null ||
                            String.Equals(name, exactName, StringComparison.OrdinalIgnoreCase))
                            yield return CombineChild(path, name);
                    }

                    if (FindNextFileW(handle, out data))
                        continue;
                    int error = Marshal.GetLastWin32Error();
                    if (error != ErrorNoMoreFiles)
                        throw new Win32Exception(error, "native directory enumeration failed");
                    break;
                }
            }
            finally
            {
                if (closeRequired)
                {
                    closeRequired = false;
                    if (!FindClose(handle))
                        throw new Win32Exception(
                            Marshal.GetLastWin32Error(),
                            "native directory enumeration cleanup failed");
                }
            }
        }

        private static string ValidateAndNormalizeAbsolutePath(string path)
        {
            if (String.IsNullOrEmpty(path) ||
                path.Length > MaximumPathCharacters ||
                path.IndexOf('\0') >= 0)
                throw new ArgumentException("path is outside the supported boundary");

            string normalized = path.Replace('/', '\\');
            if (normalized.IndexOf('*') >= 0 || normalized.IndexOf('?') >= 0)
            {
                if (!normalized.StartsWith(@"\\?\", StringComparison.Ordinal))
                    throw new ArgumentException("path is outside the supported boundary");
                if (normalized.IndexOf('*', 4) >= 0 || normalized.IndexOf('?', 4) >= 0)
                    throw new ArgumentException("path is outside the supported boundary");
            }

            if (normalized.StartsWith(@"\\?\", StringComparison.Ordinal))
            {
                string extendedBody = normalized.Substring(4);
                if (extendedBody.StartsWith(@"UNC\", StringComparison.OrdinalIgnoreCase))
                    ValidateUncBody(extendedBody.Substring(4));
                else
                    ValidateDrivePath(extendedBody);
                return normalized;
            }

            if (normalized.StartsWith(@"\\.\", StringComparison.Ordinal) ||
                normalized.StartsWith(@"\\", StringComparison.Ordinal))
            {
                if (normalized.StartsWith(@"\\.\", StringComparison.Ordinal))
                    throw new ArgumentException("path is outside the supported boundary");
                ValidateUncBody(normalized.Substring(2));
                return normalized;
            }

            ValidateDrivePath(normalized);
            return normalized;
        }

        private static void ValidateDrivePath(string path)
        {
            if (path.Length < 3 ||
                !IsAsciiLetter(path[0]) ||
                path[1] != ':' ||
                path[2] != '\\')
                throw new ArgumentException("path is outside the supported boundary");
            ValidateSegments(path, 3);
        }

        private static void ValidateUncBody(string body)
        {
            int serverEnd = body.IndexOf('\\');
            if (serverEnd <= 0 || serverEnd == body.Length - 1)
                throw new ArgumentException("path is outside the supported boundary");
            int shareEnd = body.IndexOf('\\', serverEnd + 1);
            string server = body.Substring(0, serverEnd);
            string share = shareEnd < 0
                ? body.Substring(serverEnd + 1)
                : body.Substring(serverEnd + 1, shareEnd - serverEnd - 1);
            ValidateSegment(server);
            ValidateSegment(share);
            if (shareEnd >= 0)
                ValidateSegments(body, shareEnd + 1);
        }

        private static void ValidateSegments(string path, int start)
        {
            if (start == path.Length)
                return;
            int segmentStart = start;
            while (segmentStart < path.Length)
            {
                int segmentEnd = path.IndexOf('\\', segmentStart);
                if (segmentEnd < 0)
                    segmentEnd = path.Length;
                if (segmentEnd == segmentStart)
                    throw new ArgumentException("path is outside the supported boundary");
                ValidateSegment(path.Substring(segmentStart, segmentEnd - segmentStart));
                if (segmentEnd == path.Length)
                    return;
                segmentStart = segmentEnd + 1;
                if (segmentStart == path.Length)
                    return;
            }
        }

        private static void ValidateSegment(string segment)
        {
            if (String.IsNullOrEmpty(segment) ||
                String.Equals(segment, ".", StringComparison.Ordinal) ||
                String.Equals(segment, "..", StringComparison.Ordinal) ||
                segment.IndexOfAny(new char[] { '\\', '/', ':', '*', '?', '\0' }) >= 0)
                throw new ArgumentException("path is outside the supported boundary");
        }

        private static void ValidateEntryName(string name)
        {
            if (String.IsNullOrEmpty(name) ||
                name.Length > 255 ||
                name.IndexOfAny(new char[] { '\\', '/', ':', '*', '?', '\0' }) >= 0 ||
                String.Equals(name, ".", StringComparison.Ordinal) ||
                String.Equals(name, "..", StringComparison.Ordinal))
                throw new ArgumentException("entry name is outside the supported boundary");
        }

        private static bool IsAsciiLetter(char value)
        {
            return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z');
        }
    }
}
