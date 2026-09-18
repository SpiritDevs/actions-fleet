using System;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;

namespace GitHub.Runner.Worker
{
    // Called only with output already processed by HostContext.SecretMasker.
    // Each worker is a single job; the host owns this bounded, append-only file.
    internal static class FleetConsoleExporter
    {
        private static readonly object Gate = new object();
        private static readonly string OutputPath = Environment.GetEnvironmentVariable("FLEET_LOG_PATH");
        private static StreamWriter Writer;
        private static bool Stopped;
        private static long WrittenBytes;
        private static readonly long MaxBytes = ReadLimit();

        private static long ReadLimit()
        {
            return long.TryParse(Environment.GetEnvironmentVariable("FLEET_LOG_MAX_BYTES"), out long value)
                ? Math.Clamp(value, 65536L, 1073741824L) : 67108864L;
        }

        public static void Write(string maskedLine, string jobId, string stepId, string runId, string runAttempt)
        {
            if (string.IsNullOrEmpty(OutputPath)) return;
            lock (Gate)
            {
                if (Stopped) return;
                try
                {
                    if (Writer == null)
                    {
                        var stream = new FileStream(OutputPath, FileMode.Append, FileAccess.Write, FileShare.Read);
                        WrittenBytes = stream.Length;
                        Writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
                    }
                    long.TryParse(runId, NumberStyles.None, CultureInfo.InvariantCulture, out long run);
                    int.TryParse(runAttempt, NumberStyles.None, CultureInfo.InvariantCulture, out int attempt);
                    var timestamp = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);
                    maskedLine = maskedLine ?? string.Empty;
                    for (int offset = 0; offset < Math.Max(1, maskedLine.Length);)
                    {
                        int length = Math.Min(60000, maskedLine.Length - offset);
                        // Do not split a Unicode surrogate pair across records.
                        if (length > 0 && offset + length < maskedLine.Length && char.IsHighSurrogate(maskedLine[offset + length - 1])) length--;
                        string line = maskedLine.Substring(offset, length);
                        string record = JsonSerializer.Serialize(new { timestamp, runId = Math.Max(0, run), runAttempt = Math.Max(1, attempt), jobId, stepId, line });
                        long bytes = Encoding.UTF8.GetByteCount(record) + 1;
                        if (WrittenBytes + bytes + 1024 > MaxBytes)
                        {
                            Writer.WriteLine(JsonSerializer.Serialize(new { timestamp, runId = Math.Max(0, run), runAttempt = Math.Max(1, attempt), jobId, stepId, line = "[fleet log gap: local capture limit reached; remaining output is available in GitHub Actions]" }));
                            Writer.Dispose();
                            Stopped = true;
                            return;
                        }
                        Writer.WriteLine(record);
                        WrittenBytes += bytes;
                        if (length == 0) break;
                        offset += length;
                    }
                }
                catch (Exception)
                {
                    // Collector failures must not change the GitHub job result.
                    Stopped = true;
                    try { Writer?.Dispose(); } catch { }
                    try { File.WriteAllText(OutputPath + ".error", "Fleet console collection failed; use GitHub Actions for the remaining log.\n"); } catch { }
                    Console.Error.WriteLine("Fleet console collection failed; use GitHub Actions for the remaining log.");
                }
            }
        }
    }
}
