using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

namespace CodingX.WorkspaceSafety
{
    public static class WindowsPathAttributes
    {
        public const uint InvalidFileAttributes = 0xffffffff;
        public const uint FileAttributeDirectory = 0x10;
        public const uint FileAttributeReparsePoint = 0x400;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFileAttributesW(string fileName);

        public static string ExtendedPath(string path)
        {
            if (String.IsNullOrEmpty(path) || path.Length > 32767 || path.IndexOf('\0') >= 0)
                throw new ArgumentException("path is outside the supported boundary");
            if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
            string full = Path.GetFullPath(path);
            if (full.StartsWith(@"\\", StringComparison.Ordinal))
                return @"\\?\UNC\" + full.Substring(2);
            return @"\\?\" + full;
        }

        public static uint Read(string path, out int error)
        {
            uint attributes = GetFileAttributesW(ExtendedPath(path));
            error = attributes == InvalidFileAttributes ? Marshal.GetLastWin32Error() : 0;
            return attributes;
        }

        public static IEnumerable<string> Entries(string path)
        {
            return Directory.EnumerateFileSystemEntries(ExtendedPath(path));
        }

        public static IEnumerable<string> Entries(string path, string searchPattern)
        {
            return Directory.EnumerateFileSystemEntries(ExtendedPath(path), searchPattern);
        }
    }
}
