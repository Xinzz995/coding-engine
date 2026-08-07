namespace CodingX.WorkspaceSafety
{
    using System;
    using System.Collections.Concurrent;
    using System.Collections.Generic;
    using System.Diagnostics;
    using System.Threading;

    internal sealed class MonotonicDeadline
    {
        private long expiresAt;

        private MonotonicDeadline(int durationMs)
        {
            long durationTicks = (long)Math.Ceiling(
                durationMs * (double)Stopwatch.Frequency / 1000.0);
            expiresAt = Stopwatch.GetTimestamp() + durationTicks;
        }

        internal static MonotonicDeadline Start(int durationMs)
        {
            if (durationMs < 0) throw new SafetyException("deadline duration is invalid");
            return new MonotonicDeadline(durationMs);
        }

        internal int RemainingMilliseconds
        {
            get
            {
                long remainingTicks = expiresAt - Stopwatch.GetTimestamp();
                if (remainingTicks <= 0) return 0;
                double milliseconds = Math.Ceiling(
                    remainingTicks * 1000.0 / Stopwatch.Frequency);
                return (int)Math.Min(Int32.MaxValue, Math.Max(1.0, milliseconds));
            }
        }

        internal bool Expired { get { return RemainingMilliseconds == 0; } }

        internal void TightenAfter(int durationMs)
        {
            if (durationMs < 0) throw new SafetyException("deadline duration is invalid");
            long durationTicks = (long)Math.Ceiling(
                durationMs * (double)Stopwatch.Frequency / 1000.0);
            expiresAt = Math.Min(expiresAt, Stopwatch.GetTimestamp() + durationTicks);
        }
    }

    internal static class ProtocolWriter
    {
        private sealed class WriteRequest
        {
            internal string Line;
            internal readonly ManualResetEventSlim Completed = new ManualResetEventSlim(false);
            internal Exception Error;
            internal volatile bool Cancelled;
        }

        private static readonly BlockingCollection<WriteRequest> Requests =
            new BlockingCollection<WriteRequest>(1024);
        private static readonly Thread Writer;
        private static volatile bool connected = true;

        static ProtocolWriter()
        {
            Writer = new Thread(WriteLoop);
            Writer.IsBackground = true;
            Writer.Name = "coding-x-windows-supervisor-protocol-writer";
            Writer.Start();
        }

        internal static bool Connected { get { return connected; } }

        internal static void Send(Dictionary<string, object> message)
        {
            Send(message, MonotonicDeadline.Start(5000));
        }

        internal static void Send(Dictionary<string, object> message,
            MonotonicDeadline deadline)
        {
            if (!connected) return;
            WriteRequest request = new WriteRequest { Line = StrictJson.Serialize(message) };
            int remaining = deadline.RemainingMilliseconds;
            if (remaining == 0 || !Requests.TryAdd(request, remaining))
                throw new SafetyException("protocol send timed out");
            remaining = deadline.RemainingMilliseconds;
            if (remaining == 0 || !request.Completed.Wait(remaining))
            {
                request.Cancelled = true;
                connected = false;
                throw new SafetyException("protocol send timed out");
            }
            if (deadline.Expired)
            {
                request.Cancelled = true;
                connected = false;
                throw new SafetyException("protocol send timed out");
            }
            if (request.Error != null) throw new SafetyException("protocol send failed");
        }

        internal static bool SendOutput(Dictionary<string, object> message)
        {
            if (!connected) return false;
            WriteRequest request = new WriteRequest { Line = StrictJson.Serialize(message) };
            while (connected && !Requests.TryAdd(request, 25)) { }
            if (!connected)
            {
                request.Cancelled = true;
                return false;
            }
            while (connected && !request.Completed.Wait(25)) { }
            if (!connected)
            {
                request.Cancelled = true;
                return false;
            }
            if (request.Error != null) throw new SafetyException("protocol send failed");
            return true;
        }

        private static void WriteLoop()
        {
            foreach (WriteRequest request in Requests.GetConsumingEnumerable())
            {
                if (request.Cancelled || !connected)
                {
                    request.Completed.Set();
                    continue;
                }
                try
                {
                    Console.Out.WriteLine(request.Line);
                    Console.Out.Flush();
                }
                catch (Exception error)
                {
                    request.Error = error;
                    connected = false;
                }
                finally { request.Completed.Set(); }
            }
        }

        internal static void Disconnect() { connected = false; }

        internal static void TryFailure(string message)
        {
            TryFailure(message, null);
        }

        internal static void TryFailure(string message, MonotonicDeadline deadline)
        {
            string bounded = (message ?? "Windows supervisor failed").Replace("\r", " ").Replace("\n", " ");
            if (bounded.Length > 512) bounded = bounded.Substring(0, 512);
            Dictionary<string, object> failure = new Dictionary<string, object> {
                { "schemaVersion", 1 }, { "type", "FAILURE" }, { "message", bounded }
            };
            if (deadline != null && deadline.Expired)
            {
                if (!connected) return;
                Requests.TryAdd(new WriteRequest { Line = StrictJson.Serialize(failure) }, 0);
                return;
            }
            try
            {
                if (deadline == null) Send(failure);
                else Send(failure, deadline);
            }
            catch { }
        }
    }
}
