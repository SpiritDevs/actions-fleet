using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using GitHub.Runner.Worker.Handlers;
using Xunit;

namespace GitHub.Runner.Common.Tests.Worker
{
    public sealed class FleetShellArgumentsL0
    {
        [Theory]
        [InlineData("/bin/bash", "--noprofile --norc -e -o pipefail {0}")]
        [InlineData("/bin/sh", "-e {0}")]
        [InlineData("/bin/bash", "--noprofile --norc -e {0}")]
        [InlineData("/bin/bash", "--noprofile --norc -e \"{0}\"")]
        [Trait("Level", "L0")]
        [Trait("Category", "Worker")]
        public async Task ExecutesDefaultAndCustomShellsWithSpacedScriptPaths(string executable, string format)
        {
            if (OperatingSystem.IsWindows()) return;
            var root = Path.Combine(Path.GetTempPath(), "fleet-shell-" + Guid.NewGuid());
            var directory = Path.Combine(root, "Library", "Application Support", "Actions Fleet", "job \"double\" and 'single'");
            Directory.CreateDirectory(directory);
            try
            {
                var script = Path.Combine(directory, "script.sh");
                await File.WriteAllTextAsync(script, "printf '%s' 'fleet-spaced-path-success'\n");
                using var process = new Process
                {
                    StartInfo = new ProcessStartInfo
                    {
                        FileName = executable,
                        Arguments = FleetShellArguments.Format(format, script.Replace("\"", "\\\"")),
                        UseShellExecute = false,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true
                    }
                };
                Assert.True(process.Start());
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
                var output = await process.StandardOutput.ReadToEndAsync();
                var error = await process.StandardError.ReadToEndAsync();
                await process.WaitForExitAsync(timeout.Token);
                Assert.True(process.ExitCode == 0, error);
                Assert.Equal("fleet-spaced-path-success", output);
            }
            finally { Directory.Delete(root, true); }
        }

        [Theory]
        [InlineData("-command \". '{0}'\"")]
        [InlineData("--custom \"{0}\"")]
        [InlineData("--custom=\"{0}\"")]
        [Trait("Level", "L0")]
        [Trait("Category", "Worker")]
        public void PreservesAlreadyQuotedCommandTemplates(string format)
        {
            const string path = "/Library/Application Support/Actions Fleet/script.ps1";
            Assert.Equal(string.Format(format, path), FleetShellArguments.Format(format, path));
        }
    }
}
