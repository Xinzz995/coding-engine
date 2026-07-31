using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace CodingX.WorkspaceSafety
{
    internal static class WindowsPathInspectorProgram
    {
        private const int ExitFailure = 2;
        private const int MaximumExecutableBytes = 4 * 1024 * 1024;
        private const int MaximumRequestBytes = 1024 * 1024;
        private const int MaximumResponseBytes = 4 * 1024 * 1024;
        private const int MaximumPaths = 4096;
        private const int MaximumPathCharacters = 32767;
        private const int MaximumBusinessEntries = 100000;
        private const int MaximumSafetyEntries = 100000;
        private const int MaximumTreeDepth = 256;
        private const string DigestFlag = "--expected-helper-digest";
        private const string ExecutableDigestDomain =
            "coding-x-windows-path-inspector-exe-v1\0";

        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
        private static string stage = "startup";

        private sealed class TreeBudget
        {
            internal int Business;
            internal int Safety;
        }

        private sealed class AttributeRecord
        {
            internal readonly string Path;
            internal readonly bool Found;
            internal readonly uint Attributes;

            internal AttributeRecord(string path, bool found, uint attributes)
            {
                Path = path;
                Found = found;
                Attributes = attributes;
            }
        }

        private static int Main(string[] arguments)
        {
            try
            {
                BindStrictUtf8Streams();
                if (arguments == null ||
                    arguments.Length != 2 ||
                    !String.Equals(arguments[0], DigestFlag, StringComparison.Ordinal) ||
                    !IsDigest(arguments[1]))
                    throw new InvalidOperationException("invalid command line");

                stage = "executable-digest";
                if (!String.Equals(
                    ExecutableDigest(),
                    arguments[1],
                    StringComparison.Ordinal))
                    throw new InvalidOperationException("fixed helper digest mismatch");

                stage = "request-read";
                byte[] requestBytes = ReadBoundedInput();
                string requestText = StrictUtf8.GetString(requestBytes);

                stage = "request-parse";
                JavaScriptSerializer serializer = NewSerializer();
                object parsed = serializer.DeserializeObject(requestText);
                IDictionary<string, object> request = RequireObject(parsed);
                RequireExactKeys(
                    request,
                    new string[] { "schemaVersion", "mode", "payload" });
                if (ReadInteger(request["schemaVersion"], 1, 1) != 1)
                    throw new InvalidOperationException("unsupported schema");
                string mode = RequireString(request["mode"]);
                IDictionary<string, object> payload = RequireObject(request["payload"]);

                object response;
                if (String.Equals(mode, "paths-v1", StringComparison.Ordinal))
                {
                    stage = "paths-read";
                    response = ReadPathsResponse(payload);
                }
                else if (
                    String.Equals(mode, "process-identity-v1", StringComparison.Ordinal))
                {
                    stage = "process-identity-read";
                    response = ReadProcessIdentityResponse(payload);
                }
                else if (
                    String.Equals(mode, "safety-tree-v1", StringComparison.Ordinal) ||
                    String.Equals(mode, "workspace-tree-v1", StringComparison.Ordinal))
                {
                    response = ReadTreeResponse(mode, payload);
                }
                else
                {
                    throw new InvalidOperationException("unsupported mode");
                }

                stage = "response-write";
                string responseText = serializer.Serialize(response);
                byte[] responseBytes = StrictUtf8.GetBytes(responseText);
                if (responseBytes.Length == 0 || responseBytes.Length > MaximumResponseBytes)
                    throw new InvalidOperationException("response exceeds boundary");
                Stream output = Console.OpenStandardOutput();
                output.Write(responseBytes, 0, responseBytes.Length);
                output.Flush();
                return 0;
            }
            catch (Exception)
            {
                TryWriteFailureMarker();
                return ExitFailure;
            }
        }

        private static object ReadPathsResponse(IDictionary<string, object> payload)
        {
            RequireExactKeys(payload, new string[] { "paths" });
            IList paths = payload["paths"] as IList;
            if (paths == null || paths.Count == 0 || paths.Count > MaximumPaths)
                throw new InvalidOperationException("path count exceeds boundary");

            List<object> records = new List<object>(paths.Count);
            for (int index = 0; index < paths.Count; index++)
            {
                string path = RequireSupportedAbsolutePath(paths[index]);
                AttributeRecord record = ReadAttributes(path);
                Dictionary<string, object> value = new Dictionary<string, object>();
                value.Add("path", record.Path);
                value.Add("status", record.Found ? "found" : "missing");
                value.Add(
                    "attributes",
                    record.Found ? (object)record.Attributes : null);
                records.Add(value);
            }

            Dictionary<string, object> response = new Dictionary<string, object>();
            response.Add("schemaVersion", 1);
            response.Add("mode", "paths-v1");
            response.Add("records", records);
            return response;
        }

        private static object ReadProcessIdentityResponse(
            IDictionary<string, object> payload)
        {
            RequireExactKeys(payload, new string[] { "pid" });
            uint pid = ReadUnsignedInteger(payload["pid"], 1, UInt32.MaxValue);
            WindowsPathAttributes.ProcessIdentityRecord identity =
                WindowsPathAttributes.ReadProcessIdentity(pid);

            Dictionary<string, object> response = new Dictionary<string, object>();
            response.Add("schemaVersion", 1);
            response.Add("mode", "process-identity-v1");
            response.Add("pid", pid);
            response.Add("status", identity.Status);
            response.Add("value", identity.Value);
            return response;
        }

        private static object ReadTreeResponse(
            string mode,
            IDictionary<string, object> payload)
        {
            bool workspaceMode = String.Equals(
                mode,
                "workspace-tree-v1",
                StringComparison.Ordinal);
            RequireExactKeys(
                payload,
                workspaceMode
                    ? new string[]
                    {
                        "root",
                        "maxBusinessEntries",
                        "maxSafetyEntries",
                        "maxDepth"
                    }
                    : new string[] { "root", "maxSafetyEntries", "maxDepth" });
            string root = RequireSupportedAbsolutePath(payload["root"]);
            int maxSafetyEntries = ReadInteger(
                payload["maxSafetyEntries"],
                0,
                MaximumSafetyEntries);
            int maxDepth = ReadInteger(payload["maxDepth"], 0, MaximumTreeDepth);
            int maxBusinessEntries = workspaceMode
                ? ReadInteger(
                    payload["maxBusinessEntries"],
                    0,
                    MaximumBusinessEntries)
                : 0;

            stage = "tree-root";
            AttributeRecord rootRecord = ReadAttributes(root);
            RequireOrdinaryFound(rootRecord);
            if ((rootRecord.Attributes & WindowsPathAttributes.FileAttributeDirectory) == 0)
                throw new InvalidOperationException("tree root is not a directory");

            stage = "canonical-name-enumeration";
            AssertCanonicalSafetyRootNames(root);

            TreeBudget budget = new TreeBudget();
            if (workspaceMode)
            {
                stage = "workspace-child-enumeration";
                foreach (string child in WindowsPathAttributes.Entries(root))
                {
                    string name = EntryName(child);
                    AssertCanonicalSafetyRootName(name);
                    AddWorkspaceTreeEntry(
                        child,
                        name,
                        name,
                        1,
                        maxDepth,
                        maxBusinessEntries,
                        maxSafetyEntries,
                        budget);
                }
            }
            else
            {
                stage = "safety-child-enumeration";
                AddSafetyTreeEntry(
                    WindowsPathAttributes.CombineChild(root, "workspace-safety.json"),
                    "workspace-safety.json",
                    1,
                    maxDepth,
                    maxSafetyEntries,
                    budget,
                    false,
                    true);
                AddSafetyTreeEntry(
                    WindowsPathAttributes.CombineChild(root, "engine.lock"),
                    "engine.lock",
                    1,
                    maxDepth,
                    maxSafetyEntries,
                    budget,
                    true,
                    true);
            }

            Dictionary<string, object> response = new Dictionary<string, object>();
            response.Add("schemaVersion", 1);
            response.Add("mode", mode);
            response.Add("root", root);
            response.Add("rootAttributes", rootRecord.Attributes);
            if (workspaceMode)
                response.Add("businessEntries", budget.Business);
            response.Add("safetyEntries", budget.Safety);
            response.Add("complete", true);
            return response;
        }

        private static void AddWorkspaceTreeEntry(
            string absolutePath,
            string relativePath,
            string firstSegment,
            int depth,
            int maxDepth,
            int maxBusinessEntries,
            int maxSafetyEntries,
            TreeBudget budget)
        {
            AttributeRecord record = ReadAttributes(absolutePath);
            RequireOrdinaryFound(record);
            bool isSafety =
                String.Equals(
                    firstSegment,
                    "engine.lock",
                    StringComparison.OrdinalIgnoreCase) ||
                String.Equals(
                    relativePath,
                    "workspace-safety.json",
                    StringComparison.OrdinalIgnoreCase);
            if (isSafety)
            {
                budget.Safety++;
                if (budget.Safety > maxSafetyEntries)
                    throw new InvalidOperationException("safety tree exceeds boundary");
            }
            else
            {
                budget.Business++;
                if (budget.Business > maxBusinessEntries)
                    throw new InvalidOperationException("business tree exceeds boundary");
            }

            if ((record.Attributes & WindowsPathAttributes.FileAttributeDirectory) == 0)
                return;
            if (depth > maxDepth)
                throw new InvalidOperationException("tree exceeds depth boundary");
            foreach (string child in WindowsPathAttributes.Entries(absolutePath))
            {
                string name = EntryName(child);
                AddWorkspaceTreeEntry(
                    child,
                    relativePath + "/" + name,
                    firstSegment,
                    depth + 1,
                    maxDepth,
                    maxBusinessEntries,
                    maxSafetyEntries,
                    budget);
            }
        }

        private static void AddSafetyTreeEntry(
            string absolutePath,
            string relativePath,
            int depth,
            int maxDepth,
            int maxSafetyEntries,
            TreeBudget budget,
            bool expectedDirectory,
            bool allowMissing)
        {
            AttributeRecord record = ReadAttributes(absolutePath);
            if (!record.Found && allowMissing)
                return;
            RequireOrdinaryFound(record);
            bool isDirectory =
                (record.Attributes & WindowsPathAttributes.FileAttributeDirectory) != 0;
            if (depth == 1 && expectedDirectory != isDirectory)
                throw new InvalidOperationException("safety root has invalid type");

            budget.Safety++;
            if (budget.Safety > maxSafetyEntries)
                throw new InvalidOperationException("safety tree exceeds boundary");
            if (!isDirectory)
                return;
            if (depth > maxDepth)
                throw new InvalidOperationException("safety tree exceeds depth boundary");
            foreach (string child in WindowsPathAttributes.Entries(absolutePath))
            {
                string name = EntryName(child);
                AddSafetyTreeEntry(
                    child,
                    relativePath + "/" + name,
                    depth + 1,
                    maxDepth,
                    maxSafetyEntries,
                    budget,
                    false,
                    false);
            }
        }

        private static void AssertCanonicalSafetyRootNames(string root)
        {
            int safetyFileMatches = 0;
            int lockDirectoryMatches = 0;
            foreach (string child in WindowsPathAttributes.Entries(root))
            {
                string name = EntryName(child);
                AssertCanonicalSafetyRootName(name);
                if (String.Equals(
                    name,
                    "workspace-safety.json",
                    StringComparison.OrdinalIgnoreCase))
                {
                    safetyFileMatches++;
                    if (!String.Equals(
                        name,
                        "workspace-safety.json",
                        StringComparison.Ordinal))
                        throw new InvalidOperationException(
                            "workspace safety root spelling is not canonical");
                }
                if (String.Equals(
                    name,
                    "engine.lock",
                    StringComparison.OrdinalIgnoreCase))
                {
                    lockDirectoryMatches++;
                    if (!String.Equals(name, "engine.lock", StringComparison.Ordinal))
                        throw new InvalidOperationException(
                            "workspace safety root spelling is not canonical");
                }
                if (safetyFileMatches > 1 || lockDirectoryMatches > 1)
                    throw new InvalidOperationException(
                        "workspace safety root spelling is ambiguous");
            }
        }

        private static void AssertCanonicalSafetyRootName(string name)
        {
            if (
                (String.Equals(
                    name,
                    "workspace-safety.json",
                    StringComparison.OrdinalIgnoreCase) &&
                    !String.Equals(
                        name,
                        "workspace-safety.json",
                        StringComparison.Ordinal)) ||
                (String.Equals(
                    name,
                    "engine.lock",
                    StringComparison.OrdinalIgnoreCase) &&
                    !String.Equals(name, "engine.lock", StringComparison.Ordinal)))
                throw new InvalidOperationException(
                    "workspace safety root spelling is not canonical");
        }

        private static AttributeRecord ReadAttributes(string path)
        {
            int error;
            uint attributes = WindowsPathAttributes.Read(path, out error);
            if (attributes != WindowsPathAttributes.InvalidFileAttributes)
                return new AttributeRecord(path, true, attributes);
            if (error == 2 || error == 3)
                return new AttributeRecord(path, false, 0);
            throw new InvalidOperationException("native attribute read failed");
        }

        private static void RequireOrdinaryFound(AttributeRecord record)
        {
            if (!record.Found)
                throw new InvalidOperationException("tree path disappeared");
            if ((record.Attributes & WindowsPathAttributes.FileAttributeReparsePoint) != 0)
                throw new InvalidOperationException("tree contains reparse point");
        }

        private static string EntryName(string child)
        {
            int separator = child.LastIndexOf('\\');
            if (separator < 0 || separator == child.Length - 1)
                throw new InvalidOperationException("native child name is invalid");
            string name = child.Substring(separator + 1);
            if (name.Length == 0 ||
                name.IndexOf('\\') >= 0 ||
                name.IndexOf('/') >= 0)
                throw new InvalidOperationException("native child name is invalid");
            return name;
        }

        private static string RequireSupportedAbsolutePath(object value)
        {
            string path = value as string;
            if (String.IsNullOrEmpty(path) ||
                path.Length > MaximumPathCharacters ||
                path.IndexOf('\0') >= 0)
                throw new InvalidOperationException("path is outside boundary");
            WindowsPathAttributes.ExtendedPath(path);
            return path;
        }

        private static IDictionary<string, object> RequireObject(object value)
        {
            IDictionary<string, object> result = value as IDictionary<string, object>;
            if (result == null)
                throw new InvalidOperationException("JSON value is not an object");
            return result;
        }

        private static string RequireString(object value)
        {
            string result = value as string;
            if (result == null)
                throw new InvalidOperationException("JSON value is not a string");
            return result;
        }

        private static int ReadInteger(
            object value,
            int minimum,
            int maximum)
        {
            long number;
            if (value is int)
                number = (int)value;
            else if (value is long)
                number = (long)value;
            else
                throw new InvalidOperationException("JSON value is not an integer");
            if (number < minimum || number > maximum)
                throw new InvalidOperationException("integer is outside boundary");
            return (int)number;
        }

        private static uint ReadUnsignedInteger(
            object value,
            uint minimum,
            uint maximum)
        {
            long number;
            if (value is int)
                number = (int)value;
            else if (value is long)
                number = (long)value;
            else
                throw new InvalidOperationException("JSON value is not an integer");
            if (number < minimum || number > maximum)
                throw new InvalidOperationException("integer is outside boundary");
            return (uint)number;
        }

        private static void RequireExactKeys(
            IDictionary<string, object> value,
            string[] expected)
        {
            if (value.Count != expected.Length)
                throw new InvalidOperationException("JSON object fields do not match");
            for (int index = 0; index < expected.Length; index++)
            {
                if (!value.ContainsKey(expected[index]))
                    throw new InvalidOperationException("JSON object fields do not match");
            }
        }

        private static JavaScriptSerializer NewSerializer()
        {
            return new JavaScriptSerializer
            {
                MaxJsonLength = MaximumResponseBytes,
                RecursionLimit = 32
            };
        }

        private static byte[] ReadBoundedInput()
        {
            Stream input = Console.OpenStandardInput();
            byte[] buffer = new byte[8192];
            using (MemoryStream request = new MemoryStream())
            {
                while (true)
                {
                    int read = input.Read(buffer, 0, buffer.Length);
                    if (read == 0)
                        break;
                    if (request.Length + read > MaximumRequestBytes)
                        throw new InvalidOperationException("request exceeds boundary");
                    request.Write(buffer, 0, read);
                }
                if (request.Length == 0)
                    throw new InvalidOperationException("request is empty");
                return request.ToArray();
            }
        }

        private static string ExecutableDigest()
        {
            string path = Assembly.GetExecutingAssembly().Location;
            if (String.IsNullOrEmpty(path))
                throw new InvalidOperationException("executable location is unavailable");
            FileInfo before = new FileInfo(path);
            if (!before.Exists ||
                before.Length <= 0 ||
                before.Length > MaximumExecutableBytes)
                throw new InvalidOperationException("executable exceeds boundary");

            byte[] domain = StrictUtf8.GetBytes(ExecutableDigestDomain);
            byte[] executable;
            using (FileStream input = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read))
            {
                if (input.Length != before.Length)
                    throw new InvalidOperationException("executable changed during read");
                executable = new byte[input.Length];
                int offset = 0;
                while (offset < executable.Length)
                {
                    int read = input.Read(executable, offset, executable.Length - offset);
                    if (read == 0)
                        throw new EndOfStreamException();
                    offset += read;
                }
                if (input.ReadByte() != -1)
                    throw new InvalidOperationException("executable changed during read");
            }
            FileInfo after = new FileInfo(path);
            if (!after.Exists ||
                after.Length != before.Length ||
                after.LastWriteTimeUtc != before.LastWriteTimeUtc)
                throw new InvalidOperationException("executable changed during read");

            byte[] digestInput = new byte[domain.Length + executable.Length];
            Buffer.BlockCopy(domain, 0, digestInput, 0, domain.Length);
            Buffer.BlockCopy(
                executable,
                0,
                digestInput,
                domain.Length,
                executable.Length);
            using (SHA256 hash = SHA256.Create())
            {
                return "sha256:" + Hex(hash.ComputeHash(digestInput));
            }
        }

        private static string Hex(byte[] bytes)
        {
            char[] output = new char[bytes.Length * 2];
            const string digits = "0123456789abcdef";
            for (int index = 0; index < bytes.Length; index++)
            {
                output[index * 2] = digits[bytes[index] >> 4];
                output[(index * 2) + 1] = digits[bytes[index] & 15];
            }
            return new string(output);
        }

        private static bool IsDigest(string value)
        {
            if (String.IsNullOrEmpty(value) ||
                value.Length != 71 ||
                !value.StartsWith("sha256:", StringComparison.Ordinal))
                return false;
            for (int index = 7; index < value.Length; index++)
            {
                char character = value[index];
                if (!((character >= '0' && character <= '9') ||
                    (character >= 'a' && character <= 'f')))
                    return false;
            }
            return true;
        }

        private static void BindStrictUtf8Streams()
        {
            StreamWriter error = new StreamWriter(
                Console.OpenStandardError(),
                StrictUtf8,
                1024,
                false);
            error.NewLine = "\n";
            error.AutoFlush = true;
            Console.SetError(error);
        }

        private static void TryWriteFailureMarker()
        {
            try
            {
                Console.Error.WriteLine(
                    "CXWPI_FAILURE_V1 stage=" + stage + " code=incomplete");
            }
            catch
            {
                // A closed error stream already produces a fail-closed non-zero exit.
            }
        }
    }
}
