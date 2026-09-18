using System;
using System.Text;

namespace GitHub.Runner.Worker.Handlers
{
    internal static class FleetShellArguments
    {
        // ScriptHandler already escapes double quotes in resolvedScriptPath.
        // Its Unix defaults nevertheless leave {0} unquoted, causing .NET's
        // ProcessStartInfo.Arguments parser to split paths such as Application
        // Support into separate arguments. Quote only unquoted placeholders;
        // preserve existing quoted templates (including PowerShell -command).
        internal static string Format(string format, string resolvedScriptPath)
        {
            var quoted = false;
            var result = new StringBuilder();
            for (var i = 0; i < format.Length; i++)
            {
                if (i + 1 < format.Length && ((format[i] == '{' && format[i + 1] == '{') || (format[i] == '}' && format[i + 1] == '}')))
                {
                    result.Append(format[i]).Append(format[++i]);
                    continue;
                }
                if (format[i] == '"')
                {
                    var slashes = 0;
                    for (var previous = i - 1; previous >= 0 && format[previous] == '\\'; previous--) slashes++;
                    if (slashes % 2 == 0) quoted = !quoted;
                }
                if (i + 2 < format.Length && format[i] == '{' && format[i + 1] == '0' && format[i + 2] == '}')
                {
                    result.Append(quoted ? "{0}" : "\"{0}\"");
                    i += 2;
                }
                else result.Append(format[i]);
            }
            return string.Format(result.ToString(), resolvedScriptPath);
        }
    }
}
