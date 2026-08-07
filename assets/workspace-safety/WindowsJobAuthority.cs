namespace CodingX.WorkspaceSafety
{
    using System;
    using System.Collections.Generic;
    using System.Globalization;
    using System.IO;
    using System.Linq;
    using System.Text;

    internal sealed class PreparedAuthority
    {
        internal byte[] Marker;
        internal byte[] Owner;
        internal byte[] Protocol;
        internal byte[] Active;
        internal byte[] Baseline;
        internal string OwnerId;
        internal string OperationId;
        internal string Kind;
        internal string Delegation;
        internal string StartedAt;
        internal string DelegationContractDigest;
        internal string OperationPath;

        internal static PreparedAuthority Read(TargetSpec target, string expectedHelperDigest,
            int supervisorPid, string supervisorIdentity)
        {
            PreparedAuthority result = new PreparedAuthority();
            result.OperationPath = Path.Combine(target.WorkspacePath, "engine.lock", "lease", "operation");
            string leasePath = Path.Combine(target.WorkspacePath, "engine.lock", "lease");
            result.Marker = AuthorityBinding.StableRead(
                Path.Combine(target.WorkspacePath, "workspace-safety.json"), 1024 * 1024);
            result.Owner = AuthorityBinding.StableRead(Path.Combine(leasePath, "owner.json"), 1024 * 1024);
            result.Protocol = AuthorityBinding.StableRead(
                Path.Combine(target.WorkspacePath, "engine.lock", "protocol.json"), 1024 * 1024);
            result.Active = AuthorityBinding.StableRead(
                Path.Combine(result.OperationPath, "active-child.json"), 1024 * 1024);
            result.Baseline = AuthorityBinding.StableRead(
                Path.Combine(result.OperationPath, "delegated-baseline.json"), 64 * 1024 * 1024);

            Dictionary<string, object> marker = AuthorityBinding.Parse(result.Marker, "workspace marker");
            Dictionary<string, object> owner = AuthorityBinding.Parse(result.Owner, "owner");
            Dictionary<string, object> protocol = AuthorityBinding.Parse(result.Protocol, "protocol");
            Dictionary<string, object> active = AuthorityBinding.Parse(result.Active, "prepared-bound active-child");
            Dictionary<string, object> baseline = AuthorityBinding.Parse(
                result.Baseline, "delegated baseline", 64 * 1024 * 1024);
            StrictJson.ExactKeys(marker, "workspace marker", "schemaVersion", "initializedBy",
                "workspaceIdentity", "protocolDigest", "initializedAt");
            StrictJson.ExactKeys(protocol, "protocol", "schemaVersion", "protocol",
                "workspaceIdentity", "createdBy", "createdAt");
            StrictJson.ExactKeys(owner, "owner", "schemaVersion", "ownerId", "pid",
                "processIdentity", "bootIdentity", "hostId", "workspaceIdentity", "startedAt", "command");
            StrictJson.ExactKeys(active, "prepared-bound active-child", "schemaVersion", "ownerId",
                "operationId", "state", "kind", "delegation", "platform", "helperDigest",
                "delegatedBaselineDigest", "delegationContractDigest", "startedAt", "updatedAt",
                "supervisorPid", "supervisorIdentity", "signalIsolation");
            StrictJson.ExactKeys(baseline, "delegated baseline", "schemaVersion", "ownerId", "operationId",
                "workspaceIdentity", "contract", "contractDigest", "entries", "capturedAt", "manifestDigest");
            Dictionary<string, object> ownerIdentity = StrictJson.Object(owner, "processIdentity", "owner process identity");
            StrictJson.ExactKeys(ownerIdentity, "owner process identity", "kind", "value");
            Dictionary<string, object> contract = StrictJson.Object(baseline, "contract", "delegation contract");
            StrictJson.ExactKeys(contract, "delegation contract", "version", "semantic", "rules");
            ValidateSemantic(StrictJson.Object(contract, "semantic", "delegation semantic contract"));

            string workspaceIdentity = StrictJson.String(marker, "workspaceIdentity", "marker workspace identity", false);
            result.OwnerId = StrictJson.String(owner, "ownerId", "ownerId", false);
            result.OperationId = StrictJson.String(active, "operationId", "operationId", false);
            result.Kind = StrictJson.String(active, "kind", "kind", false);
            result.Delegation = StrictJson.String(active, "delegation", "delegation", false);
            result.StartedAt = StrictJson.String(active, "startedAt", "startedAt", false);
            result.DelegationContractDigest = StrictJson.String(active,
                "delegationContractDigest", "delegation contract digest", false);
            string ownerCommand = StrictJson.String(owner, "command", "owner command", false);
            string ownerIdentityKind = StrictJson.String(ownerIdentity, "kind",
                "owner process identity kind", false);
            string baselineContractDigest = StrictJson.String(baseline, "contractDigest",
                "contract digest", false);
            string expectedDelegation = result.Kind == "builder" ? "builder-v1" :
                result.Kind == "validator" ? "validator-v1" :
                (result.Kind == "quality-check" || result.Kind == "tdd-check" ||
                 result.Kind == "final-review") ? "read-only-v1" : null;
            if (StrictJson.Integer(marker, "schemaVersion", "marker schemaVersion") != 2 ||
                StrictJson.String(marker, "initializedBy", "initializedBy", false) != "0.34.0" ||
                StrictJson.String(marker, "protocolDigest", "protocolDigest", false) != Hashing.Digest(result.Protocol) ||
                StrictJson.Integer(protocol, "schemaVersion", "protocol schemaVersion") != 1 ||
                StrictJson.String(protocol, "protocol", "protocol", false) != "coding-x-workspace-lease-v1" ||
                StrictJson.String(protocol, "createdBy", "createdBy", false) != "0.34.0" ||
                StrictJson.String(protocol, "workspaceIdentity", "protocol workspace identity", false) != workspaceIdentity ||
                StrictJson.Integer(owner, "schemaVersion", "owner schemaVersion") != 2 ||
                StrictJson.String(owner, "workspaceIdentity", "owner workspace identity", false) != workspaceIdentity ||
                !Patterns.Digest.IsMatch(workspaceIdentity) ||
                !Patterns.Digest.IsMatch(StrictJson.String(owner, "bootIdentity", "bootIdentity", false)) ||
                !Patterns.Digest.IsMatch(StrictJson.String(owner, "hostId", "hostId", false)) ||
                ownerIdentityKind != "windows-filetime" ||
                (ownerCommand != "workspace-init" && ownerCommand != "run" && ownerCommand != "repair" &&
                 ownerCommand != "report" && ownerCommand != "apply-prd" &&
                 ownerCommand != "review-decision") ||
                !Patterns.Uuid.IsMatch(result.OwnerId) || !Patterns.Uuid.IsMatch(result.OperationId) ||
                result.OwnerId == result.OperationId ||
                result.OperationId != target.OperationId || expectedDelegation == null ||
                result.Delegation != expectedDelegation ||
                !Patterns.Digest.IsMatch(result.DelegationContractDigest) ||
                StrictJson.Integer(active, "schemaVersion", "active schemaVersion") != 2 ||
                StrictJson.String(active, "ownerId", "active ownerId", false) != result.OwnerId ||
                StrictJson.String(active, "state", "active state", false) != "prepared-bound" ||
                StrictJson.String(active, "platform", "active platform", false) != "windows-job-v1" ||
                StrictJson.String(active, "helperDigest", "helper digest", false) != expectedHelperDigest ||
                StrictJson.String(active, "delegatedBaselineDigest", "baseline digest", false) != Hashing.Digest(result.Baseline) ||
                StrictJson.Integer(active, "supervisorPid", "supervisorPid") != supervisorPid ||
                StrictJson.String(active, "supervisorIdentity", "supervisorIdentity", false) != supervisorIdentity ||
                StrictJson.String(active, "signalIsolation", "signalIsolation", false) !=
                    "windows-new-process-group-ctrl-c-ignore-v1" ||
                StrictJson.Integer(baseline, "schemaVersion", "baseline schemaVersion") != 1 ||
                StrictJson.String(baseline, "ownerId", "baseline ownerId", false) != result.OwnerId ||
                StrictJson.String(baseline, "operationId", "baseline operationId", false) != result.OperationId ||
                StrictJson.String(baseline, "workspaceIdentity", "baseline workspace identity", false) !=
                    workspaceIdentity ||
                StrictJson.String(contract, "version", "contract version", false) != result.Delegation ||
                baselineContractDigest != result.DelegationContractDigest ||
                baselineContractDigest != Hashing.Digest(Hashing.Utf8(StrictJson.CanonicalSerialize(contract))) ||
                !Patterns.Digest.IsMatch(StrictJson.String(baseline, "manifestDigest", "manifestDigest", false)))
                throw new SafetyException("canonical prepared-bound authority binding mismatch");
            return result;
        }

        private static void ValidateSemantic(Dictionary<string, object> semantic)
        {
            string version = StrictJson.String(semantic, "version", "semantic version", false);
            if (version == "read-only-v1")
            {
                StrictJson.ExactKeys(semantic, "read-only semantic contract", "version");
                return;
            }
            if (version == "builder-state-v1")
            {
                StrictJson.ExactKeys(semantic, "builder semantic contract", "version", "storyId",
                    "acceptanceHash", "checkCount");
                StrictJson.String(semantic, "storyId", "builder semantic storyId", false);
                if (!Patterns.Digest.IsMatch(StrictJson.String(semantic, "acceptanceHash",
                        "builder semantic acceptanceHash", false)) ||
                    StrictJson.SafeInteger(semantic, "checkCount", "builder semantic checkCount") < 0)
                    throw new SafetyException("builder semantic contract is invalid");
                return;
            }
            if (version == "validator-result-v1")
            {
                StrictJson.ExactKeys(semantic, "validator semantic contract", "version", "requestId",
                    "storyId", "acceptanceHash", "checkCount", "gitHead");
                if (!Patterns.Uuid.IsMatch(StrictJson.String(semantic, "requestId",
                        "validator semantic requestId", false)) ||
                    !Patterns.Digest.IsMatch(StrictJson.String(semantic, "acceptanceHash",
                        "validator semantic acceptanceHash", false)) ||
                    !Patterns.GitHead.IsMatch(StrictJson.String(semantic, "gitHead",
                        "validator semantic gitHead", false)) ||
                    StrictJson.SafeInteger(semantic, "checkCount", "validator semantic checkCount") < 0)
                    throw new SafetyException("validator semantic contract is invalid");
                StrictJson.String(semantic, "storyId", "validator semantic storyId", false);
                return;
            }
            throw new SafetyException("delegation semantic contract version is invalid");
        }

        internal void AssertStillPrepared(TargetSpec target)
        {
            string leasePath = Path.Combine(target.WorkspacePath, "engine.lock", "lease");
            if (!AuthorityBinding.StableRead(Path.Combine(target.WorkspacePath, "workspace-safety.json"),
                    1024 * 1024).SequenceEqual(Marker) ||
                !AuthorityBinding.StableRead(Path.Combine(leasePath, "owner.json"),
                    1024 * 1024).SequenceEqual(Owner) ||
                !AuthorityBinding.StableRead(Path.Combine(target.WorkspacePath, "engine.lock", "protocol.json"),
                    1024 * 1024).SequenceEqual(Protocol) ||
                !AuthorityBinding.StableRead(Path.Combine(OperationPath, "active-child.json"),
                    1024 * 1024).SequenceEqual(Active) ||
                !AuthorityBinding.StableRead(Path.Combine(OperationPath, "delegated-baseline.json"),
                    64 * 1024 * 1024).SequenceEqual(Baseline))
                throw new SafetyException("prepared-bound authority changed before abort");
        }
    }

    internal sealed class AuthorityBinding
    {
        internal string OwnerId;
        internal string OperationId;
        internal string OwnerRecordDigest;
        internal string ProtocolDigest;
        internal string ActiveChildDigest;
        internal string DelegatedBaselineDigest;
        internal string DelegationContractDigest;
        internal string ContainmentDigest;
        internal string HelperDigest;
        internal string SupervisorIdentity;
        internal string OperationPath;
        internal string WorkspacePath;
        internal string MarkerDigest;

        internal static byte[] StableRead(string path, int maximum)
        {
            AssertNoReparseAncestors(path);
            using (FileStream firstHandle = new FileStream(path, FileMode.Open, FileAccess.Read,
                FileShare.Read))
            {
                BY_HANDLE_FILE_INFORMATION before = Information(firstHandle);
                byte[] first = ReadBounded(firstHandle, maximum);
                BY_HANDLE_FILE_INFORMATION after = Information(firstHandle);
                if (!SameFile(before, after))
                    throw new SafetyException("canonical authority changed during handle read");
                using (FileStream secondHandle = new FileStream(path, FileMode.Open, FileAccess.Read,
                    FileShare.Read))
                {
                    BY_HANDLE_FILE_INFORMATION secondInformation = Information(secondHandle);
                    byte[] second = ReadBounded(secondHandle, maximum);
                    if (!SameFile(after, secondInformation) || !first.SequenceEqual(second))
                        throw new SafetyException("canonical authority path changed during read");
                }
                return first;
            }
        }

        private static void AssertNoReparseAncestors(string path)
        {
            string full = Path.GetFullPath(path);
            FileInfo leaf = new FileInfo(full);
            if (!leaf.Exists || (leaf.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new SafetyException("canonical authority file is missing or a reparse point");
            DirectoryInfo directory = leaf.Directory;
            while (directory != null)
            {
                if (!directory.Exists || (directory.Attributes & FileAttributes.ReparsePoint) != 0)
                    throw new SafetyException("canonical authority path contains a reparse point");
                directory = directory.Parent;
            }
        }

        private static BY_HANDLE_FILE_INFORMATION Information(FileStream stream)
        {
            BY_HANDLE_FILE_INFORMATION information;
            if (!Native.GetFileInformationByHandle(stream.SafeFileHandle.DangerousGetHandle(),
                out information))
                throw Native.Failure("GetFileInformationByHandle");
            if ((information.FileAttributes & Native.FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
                information.NumberOfLinks != 1)
                throw new SafetyException("canonical authority handle is invalid");
            return information;
        }

        private static bool SameFile(BY_HANDLE_FILE_INFORMATION left,
            BY_HANDLE_FILE_INFORMATION right)
        {
            return left.VolumeSerialNumber == right.VolumeSerialNumber &&
                left.FileIndexHigh == right.FileIndexHigh && left.FileIndexLow == right.FileIndexLow &&
                left.FileSizeHigh == right.FileSizeHigh && left.FileSizeLow == right.FileSizeLow &&
                left.LastWriteTime.dwHighDateTime == right.LastWriteTime.dwHighDateTime &&
                left.LastWriteTime.dwLowDateTime == right.LastWriteTime.dwLowDateTime;
        }

        private static byte[] ReadBounded(FileStream stream, int maximum)
        {
            long length = stream.Length;
            if (length < 0 || length > maximum)
                throw new SafetyException("canonical authority file exceeds its size limit");
            byte[] bytes = new byte[(int)length];
            int offset = 0;
            while (offset < bytes.Length)
            {
                int read = stream.Read(bytes, offset, bytes.Length - offset);
                if (read == 0) throw new SafetyException("canonical authority file ended early");
                offset += read;
            }
            if (stream.ReadByte() != -1)
                throw new SafetyException("canonical authority file grew during read");
            return bytes;
        }

        internal static Dictionary<string, object> Parse(
            byte[] bytes, string label, int maximumJsonCharacters = 128 * 1024)
        {
            string text;
            try { text = new UTF8Encoding(false, true).GetString(bytes); }
            catch { throw new SafetyException(label + " is not strict UTF-8"); }
            return StrictJson.ParseObject(text, label, maximumJsonCharacters);
        }

        internal static AuthorityBinding ReadArmed(TargetSpec target, PreparedAuthority prepared,
            string activeDigest,
            string expectedHelperDigest, int supervisorPid, string supervisorIdentity,
            uint targetPid, string targetIdentity)
        {
            string operationPath = Path.Combine(target.WorkspacePath, "engine.lock", "lease", "operation");
            string leasePath = Path.Combine(target.WorkspacePath, "engine.lock", "lease");
            byte[] marker = StableRead(Path.Combine(target.WorkspacePath, "workspace-safety.json"), 1024 * 1024);
            byte[] owner = StableRead(Path.Combine(leasePath, "owner.json"), 1024 * 1024);
            byte[] protocol = StableRead(Path.Combine(target.WorkspacePath, "engine.lock", "protocol.json"), 1024 * 1024);
            byte[] active = StableRead(Path.Combine(operationPath, "active-child.json"), 1024 * 1024);
            byte[] baseline = StableRead(Path.Combine(operationPath, "delegated-baseline.json"), 64 * 1024 * 1024);
            if (!marker.SequenceEqual(prepared.Marker) || !owner.SequenceEqual(prepared.Owner) ||
                !protocol.SequenceEqual(prepared.Protocol) || !baseline.SequenceEqual(prepared.Baseline))
                throw new SafetyException("canonical authority changed between DATA and START");
            Dictionary<string, object> ownerObject = Parse(owner, "owner");
            Dictionary<string, object> activeObject = Parse(active, "active-child");
            StrictJson.ExactKeys(activeObject, "armed active-child", "schemaVersion", "ownerId",
                "operationId", "state", "kind", "delegation", "platform", "helperDigest",
                "delegatedBaselineDigest", "delegationContractDigest", "startedAt", "updatedAt",
                "supervisorPid", "supervisorIdentity", "signalIsolation", "containment",
                "containmentDigest");
            string ownerId = StrictJson.String(ownerObject, "ownerId", "ownerId", false);
            if (activeDigest == null || Hashing.Digest(active) != activeDigest ||
                StrictJson.Integer(activeObject, "schemaVersion", "active schemaVersion") != 2 ||
                StrictJson.String(activeObject, "state", "active state", false) != "armed" ||
                StrictJson.String(activeObject, "ownerId", "active ownerId", false) != ownerId ||
                StrictJson.String(activeObject, "operationId", "active operationId", false) != target.OperationId ||
                StrictJson.String(activeObject, "kind", "active kind", false) != prepared.Kind ||
                StrictJson.String(activeObject, "delegation", "active delegation", false) != prepared.Delegation ||
                StrictJson.String(activeObject, "startedAt", "active startedAt", false) != prepared.StartedAt ||
                StrictJson.String(activeObject, "platform", "active platform", false) != "windows-job-v1" ||
                StrictJson.String(activeObject, "helperDigest", "active helper digest", false) != expectedHelperDigest ||
                StrictJson.Integer(activeObject, "supervisorPid", "supervisorPid") != supervisorPid ||
                StrictJson.String(activeObject, "supervisorIdentity", "supervisorIdentity", false) != supervisorIdentity ||
                StrictJson.String(activeObject, "signalIsolation", "signalIsolation", false) !=
                    "windows-new-process-group-ctrl-c-ignore-v1")
                throw new SafetyException("canonical armed authority binding mismatch");
            Dictionary<string, object> containment = StrictJson.Object(activeObject, "containment", "containment");
            StrictJson.ExactKeys(containment, "containment", "platform", "targetPid", "targetIdentity");
            if (StrictJson.String(containment, "platform", "containment platform", false) != "windows-job-v1" ||
                StrictJson.Integer(containment, "targetPid", "targetPid") != targetPid ||
                StrictJson.String(containment, "targetIdentity", "targetIdentity", false) != targetIdentity)
                throw new SafetyException("live Windows containment binding mismatch");
            string containmentDigest = StrictJson.String(activeObject, "containmentDigest", "containmentDigest", false);
            if (containmentDigest != Hashing.Digest(WindowsContainmentBytes(targetPid, targetIdentity)))
                throw new SafetyException("containment digest mismatch");
            string baselineDigest = StrictJson.String(activeObject, "delegatedBaselineDigest", "baseline digest", false);
            if (baselineDigest != Hashing.Digest(baseline)) throw new SafetyException("baseline digest mismatch");
            if (StrictJson.String(activeObject, "delegationContractDigest",
                "delegation contract digest", false) != prepared.DelegationContractDigest)
                throw new SafetyException("delegation contract digest changed during arm");
            AuthorityBinding binding = new AuthorityBinding();
            binding.OwnerId = ownerId;
            binding.OperationId = target.OperationId;
            binding.OwnerRecordDigest = Hashing.Digest(owner);
            binding.ProtocolDigest = Hashing.Digest(protocol);
            binding.ActiveChildDigest = Hashing.Digest(active);
            binding.DelegatedBaselineDigest = baselineDigest;
            binding.DelegationContractDigest = StrictJson.String(activeObject,
                "delegationContractDigest", "delegation contract digest", false);
            binding.ContainmentDigest = containmentDigest;
            binding.HelperDigest = expectedHelperDigest;
            binding.SupervisorIdentity = supervisorIdentity;
            binding.OperationPath = operationPath;
            binding.WorkspacePath = target.WorkspacePath;
            binding.MarkerDigest = Hashing.Digest(marker);
            return binding;
        }

        private static byte[] WindowsContainmentBytes(uint targetPid, string targetIdentity)
        {
            ulong identity;
            if (!UInt64.TryParse(targetIdentity, NumberStyles.None, CultureInfo.InvariantCulture,
                    out identity) ||
                identity.ToString(CultureInfo.InvariantCulture) != targetIdentity)
                throw new SafetyException("target process identity is not canonical");
            return Hashing.Utf8(
                "{\n" +
                "  \"platform\": \"windows-job-v1\",\n" +
                "  \"targetPid\": " + targetPid.ToString(CultureInfo.InvariantCulture) + ",\n" +
                "  \"targetIdentity\": \"" + targetIdentity + "\"\n" +
                "}\n");
        }

        internal static AuthorityBinding ReadCurrentArmed(TargetSpec target,
            PreparedAuthority prepared, string expectedHelperDigest, int supervisorPid,
            string supervisorIdentity, uint targetPid, string targetIdentity)
        {
            byte[] active = StableRead(Path.Combine(prepared.OperationPath, "active-child.json"), 1024 * 1024);
            Dictionary<string, object> value = Parse(active, "active-child after parent EOF");
            string state = StrictJson.String(value, "state", "active state", false);
            if (state == "prepared-bound")
            {
                if (!active.SequenceEqual(prepared.Active))
                    throw new SafetyException("prepared-bound authority changed before parent EOF");
                return null;
            }
            if (state != "armed") throw new SafetyException("active-child state is invalid after parent EOF");
            return ReadArmed(target, prepared, Hashing.Digest(active), expectedHelperDigest,
                supervisorPid, supervisorIdentity, targetPid, targetIdentity);
        }

        internal byte[] InstallReceipt(string proof, string drainReason)
        {
            AssertCurrent();
            Dictionary<string, object> receipt = new Dictionary<string, object> {
                { "schemaVersion", 1 }, { "ownerId", OwnerId }, { "operationId", OperationId },
                { "ownerRecordDigest", OwnerRecordDigest }, { "protocolDigest", ProtocolDigest },
                { "activeChildDigest", ActiveChildDigest }, { "delegatedBaselineDigest", DelegatedBaselineDigest },
                { "delegationContractDigest", DelegationContractDigest }, { "containmentDigest", ContainmentDigest },
                { "helperDigest", HelperDigest }, { "supervisorIdentity", SupervisorIdentity },
                { "proof", proof }, { "drainReason", drainReason },
                { "drainedAt", DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture) }
            };
            byte[] bytes = Hashing.Utf8(StrictJson.Serialize(receipt));
            string staging = Path.Combine(OperationPath,
                "drained-receipt.prepare-" + Guid.NewGuid().ToString("D") + ".json");
            string destination = Path.Combine(OperationPath, "drained-receipt.json");
            using (FileStream stream = new FileStream(staging, FileMode.CreateNew, FileAccess.Write,
                FileShare.None, 4096, FileOptions.WriteThrough))
            {
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
            if (!File.ReadAllBytes(staging).SequenceEqual(bytes))
                throw new SafetyException("receipt staging readback mismatch");
            if (!Native.MoveFileExW(staging, destination, 0)) throw Native.Failure("MoveFileExW");
            if (!File.ReadAllBytes(destination).SequenceEqual(bytes))
                throw new SafetyException("receipt readback mismatch");
            return bytes;
        }

        private void AssertCurrent()
        {
            string leasePath = Path.Combine(WorkspacePath, "engine.lock", "lease");
            if (Hashing.Digest(StableRead(Path.Combine(WorkspacePath, "workspace-safety.json"),
                    1024 * 1024)) != MarkerDigest ||
                Hashing.Digest(StableRead(Path.Combine(leasePath, "owner.json"),
                    1024 * 1024)) != OwnerRecordDigest ||
                Hashing.Digest(StableRead(Path.Combine(WorkspacePath, "engine.lock", "protocol.json"),
                    1024 * 1024)) != ProtocolDigest ||
                Hashing.Digest(StableRead(Path.Combine(OperationPath, "active-child.json"),
                    1024 * 1024)) != ActiveChildDigest ||
                Hashing.Digest(StableRead(Path.Combine(OperationPath, "delegated-baseline.json"),
                    64 * 1024 * 1024)) != DelegatedBaselineDigest)
                throw new SafetyException("canonical authority changed after START");
        }
    }

    internal sealed class SupervisorSession
    {
        private readonly string helperDigest;
        private readonly Timeouts timeouts;
        private readonly int supervisorPid;
        private readonly string supervisorIdentity;
        private ControlReader control;
        private TargetSpec target;
        private JobTarget jobTarget;
        private PreparedAuthority prepared;
        private AuthorityBinding binding;
        private string receiptDigest;
        private string terminationReason;
        private bool terminationBeforeStart;
        private MonotonicDeadline currentDeadline;

        internal SupervisorSession(string digest, Timeouts values)
        {
            helperDigest = digest;
            timeouts = values;
            supervisorPid = System.Diagnostics.Process.GetCurrentProcess().Id;
            supervisorIdentity = Native.ProcessIdentity(Native.GetCurrentProcess());
        }

        internal MonotonicDeadline FailureDeadline()
        {
            if (currentDeadline == null)
                currentDeadline = MonotonicDeadline.Start(timeouts.TerminateMs);
            return currentDeadline;
        }

        private MonotonicDeadline StartPhaseDeadline(int durationMs)
        {
            currentDeadline = MonotonicDeadline.Start(durationMs);
            return currentDeadline;
        }

        private static Dictionary<string, object> Message(ControlFrame frame, string label)
        {
            if (frame.EndOfFile) return null;
            return StrictJson.ParseObject(frame.Line, label);
        }

        private static Dictionary<string, object> Embedded(Dictionary<string, object> envelope,
            string envelopeType, string messageType)
        {
            StrictJson.ExactKeys(envelope, envelopeType + " envelope", "schemaVersion", "type", "messageBase64");
            if (StrictJson.Integer(envelope, "schemaVersion", "schemaVersion") != 1 ||
                StrictJson.String(envelope, "type", "type", false) != envelopeType)
                throw new SafetyException(envelopeType + " envelope is invalid");
            Dictionary<string, object> message = StrictJson.DecodeBase64Object(
                StrictJson.String(envelope, "messageBase64", "messageBase64", false), messageType);
            return message;
        }

        private void SendBound(MonotonicDeadline deadline)
        {
            ProtocolWriter.Send(new Dictionary<string, object> {
                { "schemaVersion", 1 }, { "type", "BOUND" }, { "supervisorPid", supervisorPid },
                { "supervisorIdentity", supervisorIdentity }, { "helperDigest", helperDigest }
            }, deadline);
        }

        private void SendPrestartDrained(string operationId, MonotonicDeadline deadline)
        {
            Dictionary<string, object> message = new Dictionary<string, object> {
                { "schemaVersion", 1 }, { "type", "PRESTART_DRAINED" },
                { "operationId", operationId }, { "supervisorPid", supervisorPid },
                { "supervisorIdentity", supervisorIdentity },
                { "proof", "prestart-containment-empty-and-pipes-eof-v1" },
                { "drainedAt", DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture) }
            };
            ProtocolWriter.Send(new Dictionary<string, object> {
                { "schemaVersion", 1 }, { "type", "PRESTART_DRAINED" },
                { "messageBase64", Convert.ToBase64String(Hashing.Utf8(StrictJson.Serialize(message))) }
            }, deadline);
        }

        private void DrainAndSend(string drainReason, bool waitForAcknowledgement, string proof,
            MonotonicDeadline closeoutDeadline)
        {
            if (!jobTarget.WaitForEmptyAndEof(closeoutDeadline, timeouts.PollMs))
                throw new SafetyException("Windows Job or output pipes did not drain");
            if (binding == null) throw new SafetyException("START binding was not cached");
            byte[] receipt = binding.InstallReceipt(proof, drainReason);
            receiptDigest = Hashing.Digest(receipt);
            Dictionary<string, object> message = new Dictionary<string, object> {
                { "schemaVersion", 1 }, { "type", "DRAINED" }, { "operationId", target.OperationId },
                { "receiptDigest", receiptDigest }, { "proof", proof }
            };
            ProtocolWriter.Send(new Dictionary<string, object> {
                { "schemaVersion", 1 }, { "type", "DRAINED" },
                { "messageBase64", Convert.ToBase64String(Hashing.Utf8(StrictJson.Serialize(message))) }
            }, closeoutDeadline);
            if (!waitForAcknowledgement) return;
            WaitForAcknowledgement();
        }

        private void WaitForAcknowledgement()
        {
            MonotonicDeadline deadline = StartPhaseDeadline(timeouts.AckMs);
            while (!deadline.Expired)
            {
                ControlFrame frame = control.Take(deadline, "ACK");
                if (frame.EndOfFile) { ProtocolWriter.Disconnect(); return; }
                Dictionary<string, object> envelope = StrictJson.ParseObject(frame.Line, "post-drain envelope");
                string envelopeType = StrictJson.String(envelope, "type", "post-drain type", false);
                if (envelopeType == "TERMINATE")
                {
                    HandleTermination(frame);
                    continue;
                }
                if (envelopeType == "START" && terminationBeforeStart)
                {
                    Dictionary<string, object> ignored = Embedded(envelope, "START", "START");
                    StrictJson.ExactKeys(ignored, "START", "schemaVersion", "type", "operationId",
                        "activeChildDigest");
                    if (StrictJson.Integer(ignored, "schemaVersion", "START schemaVersion") != 1 ||
                        StrictJson.String(ignored, "type", "START type", false) != "START" ||
                        StrictJson.String(ignored, "operationId", "START operationId", false) != target.OperationId ||
                        StrictJson.String(ignored, "activeChildDigest", "activeChildDigest", false) !=
                            binding.ActiveChildDigest)
                        throw new SafetyException("ignored START binding is invalid");
                    continue;
                }
                Dictionary<string, object> acknowledgement = Embedded(envelope, "ACK", "ACK");
                StrictJson.ExactKeys(acknowledgement, "ACK",
                    "schemaVersion", "type", "operationId", "receiptDigest");
                if (StrictJson.Integer(acknowledgement, "schemaVersion", "ACK schemaVersion") != 1 ||
                    StrictJson.String(acknowledgement, "type", "ACK type", false) != "ACK" ||
                    StrictJson.String(acknowledgement, "operationId", "ACK operationId", false) != target.OperationId ||
                    StrictJson.String(acknowledgement, "receiptDigest", "ACK receiptDigest", false) != receiptDigest)
                    throw new SafetyException("ACK binding is invalid");
                return;
            }
            throw new SafetyException("ACK timed out");
        }

        private bool HandleOutputAcknowledgement(ControlFrame frame)
        {
            if (frame.EndOfFile) return false;
            Dictionary<string, object> envelope = StrictJson.ParseObject(frame.Line, "control envelope");
            string type = StrictJson.String(envelope, "type", "control type", false);
            if (type != "OUTPUT_ACK") return false;
            StrictJson.ExactKeys(envelope, "OUTPUT_ACK",
                "schemaVersion", "type", "operationId", "sequence", "bytes");
            string operationId = StrictJson.String(
                envelope, "operationId", "OUTPUT_ACK operationId", false);
            long sequence = StrictJson.SafeInteger(envelope, "sequence", "OUTPUT_ACK sequence");
            int bytes = StrictJson.Integer(envelope, "bytes", "OUTPUT_ACK bytes");
            if (StrictJson.Integer(envelope, "schemaVersion", "OUTPUT_ACK schemaVersion") != 1 ||
                operationId != target.OperationId || sequence < 1 || bytes < 1 || bytes > 16 * 1024)
                throw new SafetyException("OUTPUT_ACK binding is invalid");
            jobTarget.AcknowledgeOutput(operationId, sequence, bytes);
            return true;
        }

        private string HandleTermination(ControlFrame frame)
        {
            if (frame.EndOfFile)
            {
                ProtocolWriter.Disconnect();
                if (jobTarget != null) jobTarget.DiscardOutput();
                if (terminationReason == null) terminationReason = "parent-shutdown";
                return terminationReason;
            }
            Dictionary<string, object> envelope = StrictJson.ParseObject(frame.Line, "control envelope");
            Dictionary<string, object> message = Embedded(envelope, "TERMINATE", "TERMINATE");
            StrictJson.ExactKeys(message, "TERMINATE", "schemaVersion", "type", "operationId", "reason");
            string reason = StrictJson.String(message, "reason", "TERMINATE reason", false);
            if (StrictJson.Integer(message, "schemaVersion", "TERMINATE schemaVersion") != 1 ||
                StrictJson.String(message, "type", "TERMINATE type", false) != "TERMINATE" ||
                StrictJson.String(message, "operationId", "TERMINATE operationId", false) != target.OperationId ||
                (reason != "timeout" && reason != "user-interrupt" &&
                    reason != "parent-shutdown" && reason != "output-failure"))
                throw new SafetyException("TERMINATE binding is invalid");
            if (jobTarget != null) jobTarget.DiscardOutput();
            if (terminationReason == null) terminationReason = reason;
            return terminationReason;
        }

        private void RunStarted()
        {
            string requestedTermination = null;
            bool parentConnected = true;
            MonotonicDeadline closeoutDeadline = null;
            while (!jobTarget.CaptureRootResult())
            {
                ControlFrame frame;
                if (control.TryTake(timeouts.PollMs, out frame))
                {
                    if (!HandleOutputAcknowledgement(frame))
                    {
                        requestedTermination = HandleTermination(frame);
                        parentConnected = !frame.EndOfFile;
                        if (requestedTermination != null)
                        {
                            closeoutDeadline = StartPhaseDeadline(timeouts.TerminateMs);
                            break;
                        }
                    }
                }
            }
            if (requestedTermination != null) jobTarget.Terminate();
            if (!jobTarget.CaptureRootResult() && !jobTarget.WaitForEmptyAndEof(
                closeoutDeadline, timeouts.PollMs))
                throw new SafetyException("terminated root did not exit");
            if (closeoutDeadline == null)
                closeoutDeadline = StartPhaseDeadline(
                    timeouts.NaturalDrainMs + timeouts.TerminateMs);
            ProtocolWriter.Send(new Dictionary<string, object> {
                { "schemaVersion", 1 }, { "type", "RESULT" },
                { "code", (long)jobTarget.RootExitCode }, { "signal", null }
            }, closeoutDeadline);
            MonotonicDeadline naturalDeadline = MonotonicDeadline.Start(timeouts.NaturalDrainMs);
            bool naturallyDrained = jobTarget.Drained;
            while (requestedTermination == null && !naturallyDrained &&
                !naturalDeadline.Expired && !closeoutDeadline.Expired)
            {
                ControlFrame frame;
                int waitMs = Math.Min(timeouts.PollMs,
                    Math.Min(naturalDeadline.RemainingMilliseconds,
                        closeoutDeadline.RemainingMilliseconds));
                if (waitMs > 0 && control.TryTake(waitMs, out frame))
                {
                    if (!HandleOutputAcknowledgement(frame))
                    {
                        requestedTermination = HandleTermination(frame);
                        parentConnected = !frame.EndOfFile;
                        if (requestedTermination != null)
                            closeoutDeadline.TightenAfter(timeouts.TerminateMs);
                    }
                }
                if (requestedTermination == null && !naturalDeadline.Expired &&
                    !closeoutDeadline.Expired)
                {
                    bool observedDrained = jobTarget.Drained;
                    if (!naturalDeadline.Expired && !closeoutDeadline.Expired)
                        naturallyDrained = observedDrained;
                }
            }
            if (requestedTermination == null && !naturallyDrained &&
                jobTarget.ActiveCount == 0 && jobTarget.OutputPipesEnded)
            {
                while (!naturallyDrained && requestedTermination == null &&
                    !closeoutDeadline.Expired)
                {
                    ControlFrame frame;
                    int waitMs = Math.Min(timeouts.PollMs,
                        closeoutDeadline.RemainingMilliseconds);
                    if (waitMs > 0 && control.TryTake(waitMs, out frame))
                    {
                        if (!HandleOutputAcknowledgement(frame))
                        {
                            requestedTermination = HandleTermination(frame);
                            parentConnected = !frame.EndOfFile;
                            if (requestedTermination != null)
                                closeoutDeadline.TightenAfter(timeouts.TerminateMs);
                        }
                    }
                    if (requestedTermination == null && !closeoutDeadline.Expired)
                        naturallyDrained = jobTarget.Drained;
                }
                if (requestedTermination == null && !naturallyDrained)
                    throw new SafetyException("parent output acknowledgements did not settle");
            }
            string drainReason;
            if (requestedTermination != null)
            {
                drainReason = requestedTermination;
                if (!jobTarget.Drained) jobTarget.Terminate();
            }
            else if (!naturallyDrained)
            {
                drainReason = "process-tree-not-empty";
                jobTarget.Terminate();
            }
            else drainReason = "natural";
            DrainAndSend(drainReason, parentConnected && ProtocolWriter.Connected,
                "windows-job-zero-pipes-eof-output-settled-v2", closeoutDeadline);
        }

        internal int Run()
        {
            using (control = new ControlReader())
            {
                MonotonicDeadline prepareDeadline = StartPhaseDeadline(timeouts.HandshakeMs);
                SendBound(prepareDeadline);
                Dictionary<string, object> dataEnvelope = Message(
                    control.Take(prepareDeadline, "DATA handshake"), "DATA envelope");
                if (dataEnvelope == null) return 0;
                string firstType = StrictJson.String(dataEnvelope, "type", "initial envelope type", false);
                if (firstType == "ABORT_BEFORE_START")
                {
                    Dictionary<string, object> abort = Embedded(
                        dataEnvelope, "ABORT_BEFORE_START", "ABORT_BEFORE_START");
                    StrictJson.ExactKeys(abort, "ABORT_BEFORE_START",
                        "schemaVersion", "type", "operationId");
                    string operationId = StrictJson.String(abort, "operationId", "operationId", false);
                    if (StrictJson.Integer(abort, "schemaVersion", "ABORT schemaVersion") != 1 ||
                        StrictJson.String(abort, "type", "ABORT type", false) != "ABORT_BEFORE_START" ||
                        !Patterns.Uuid.IsMatch(operationId))
                        throw new SafetyException("ABORT_BEFORE_START binding is invalid");
                    MonotonicDeadline closeoutDeadline =
                        StartPhaseDeadline(timeouts.TerminateMs);
                    SendPrestartDrained(operationId, closeoutDeadline);
                    return 0;
                }
                target = TargetSpec.Parse(dataEnvelope);
                prepared = PreparedAuthority.Read(target, helperDigest, supervisorPid, supervisorIdentity);
                using (jobTarget = new JobTarget(target))
                {
                    ProtocolWriter.Send(new Dictionary<string, object> {
                        { "schemaVersion", 1 }, { "type", "ARMED" },
                        { "containment", new Dictionary<string, object> {
                            { "platform", "windows-job-v1" }, { "targetPid", (long)jobTarget.ProcessId },
                            { "targetIdentity", jobTarget.ProcessIdentity }
                        } }
                    }, prepareDeadline);
                    ControlFrame frame = control.Take(prepareDeadline, "START handshake");
                    if (frame.EndOfFile)
                    {
                        ProtocolWriter.Disconnect();
                        MonotonicDeadline closeoutDeadline =
                            StartPhaseDeadline(timeouts.TerminateMs);
                        jobTarget.Terminate();
                        if (!jobTarget.WaitForEmptyAndEof(closeoutDeadline, timeouts.PollMs))
                            throw new SafetyException("prestart Job did not drain after parent EOF");
                        binding = AuthorityBinding.ReadCurrentArmed(target, prepared, helperDigest,
                            supervisorPid, supervisorIdentity, jobTarget.ProcessId, jobTarget.ProcessIdentity);
                        if (binding != null)
                            binding.InstallReceipt("never-started-containment-empty-v1", "parent-shutdown");
                        jobTarget.CloseJob();
                        return 0;
                    }
                    Dictionary<string, object> envelope = StrictJson.ParseObject(frame.Line, "prestart envelope");
                    string type = StrictJson.String(envelope, "type", "prestart type", false);
                    if (type == "ABORT_BEFORE_START")
                    {
                        Dictionary<string, object> abort = Embedded(envelope, "ABORT_BEFORE_START", "ABORT_BEFORE_START");
                        StrictJson.ExactKeys(abort, "ABORT_BEFORE_START", "schemaVersion", "type", "operationId");
                        if (StrictJson.Integer(abort, "schemaVersion", "ABORT schemaVersion") != 1 ||
                            StrictJson.String(abort, "type", "ABORT type", false) != "ABORT_BEFORE_START" ||
                            StrictJson.String(abort, "operationId", "operationId", false) != target.OperationId)
                            throw new SafetyException("ABORT_BEFORE_START binding is invalid");
                        prepared.AssertStillPrepared(target);
                        MonotonicDeadline closeoutDeadline =
                            StartPhaseDeadline(timeouts.TerminateMs);
                        jobTarget.Terminate();
                        if (!jobTarget.WaitForEmptyAndEof(closeoutDeadline, timeouts.PollMs))
                            throw new SafetyException("prestart Job did not drain");
                        SendPrestartDrained(target.OperationId, closeoutDeadline);
                        jobTarget.CloseJob();
                        return 0;
                    }
                    if (type == "TERMINATE")
                    {
                        string reason = HandleTermination(frame);
                        terminationBeforeStart = true;
                        binding = AuthorityBinding.ReadCurrentArmed(target, prepared, helperDigest,
                            supervisorPid, supervisorIdentity, jobTarget.ProcessId, jobTarget.ProcessIdentity);
                        if (binding == null)
                            throw new SafetyException("TERMINATE before START requires canonical armed authority");
                        MonotonicDeadline closeoutDeadline =
                            StartPhaseDeadline(timeouts.TerminateMs);
                        jobTarget.Terminate();
                        DrainAndSend(reason, ProtocolWriter.Connected,
                            "never-started-containment-empty-v1", closeoutDeadline);
                        jobTarget.CloseJob();
                        return 0;
                    }
                    Dictionary<string, object> start = Embedded(envelope, "START", "START");
                    StrictJson.ExactKeys(start, "START", "schemaVersion", "type", "operationId", "activeChildDigest");
                    string activeDigest = StrictJson.String(start, "activeChildDigest", "activeChildDigest", false);
                    if (!Patterns.Digest.IsMatch(activeDigest) ||
                        StrictJson.Integer(start, "schemaVersion", "START schemaVersion") != 1 ||
                        StrictJson.String(start, "type", "START type", false) != "START" ||
                        StrictJson.String(start, "operationId", "START operationId", false) != target.OperationId)
                        throw new SafetyException("START binding is invalid");
                    binding = AuthorityBinding.ReadArmed(target, prepared, activeDigest, helperDigest, supervisorPid,
                        supervisorIdentity, jobTarget.ProcessId, jobTarget.ProcessIdentity);
                    jobTarget.Resume();
                    ProtocolWriter.Send(new Dictionary<string, object> {
                        { "schemaVersion", 1 }, { "type", "STARTED" },
                        { "targetPid", (long)jobTarget.ProcessId }
                    });
                    currentDeadline = null;
                    RunStarted();
                    jobTarget.CloseJob();
                    return 0;
                }
            }
        }
    }
}
