using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

internal static class SelineManagedLauncher
{
    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        var directory = AppDomain.CurrentDomain.BaseDirectory;
        var script = Path.Combine(directory, "start-seline.ps1");
        var envFile = Path.Combine(directory, ".env");
        if (!File.Exists(script))
        {
            Error("start-seline.ps1 was not found. Keep Seline.exe inside the bot folder.");
            return;
        }

        var baseUrl = Env(envFile, "OLLAMA_BASE_URL") ?? "http://127.0.0.1:11434";
        Process ownedOllama = null;
        try
        {
            if (!Ready(baseUrl))
            {
                var executable = FindOllama(envFile);
                if (executable == null)
                {
                    Error("Ollama is not running and ollama.exe could not be found.");
                    return;
                }

                ownedOllama = StartOllama(executable, baseUrl);
                if (!WaitForOllama(baseUrl, ownedOllama))
                {
                    Error("Ollama did not become ready within 20 seconds.");
                    return;
                }
            }

            using (var powershell = Process.Start(new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"",
                WorkingDirectory = directory,
                UseShellExecute = true
            }))
            {
                if (powershell == null) throw new InvalidOperationException("PowerShell could not be started.");
                powershell.WaitForExit();
            }
        }
        catch (Exception exception)
        {
            Error("Seline could not be started.\n\n" + exception.Message);
        }
        finally
        {
            StopOwnedOllama(ownedOllama);
        }
    }

    private static Process StartOllama(string executable, string baseUrl)
    {
        var info = new ProcessStartInfo
        {
            FileName = executable,
            Arguments = "serve",
            WorkingDirectory = Path.GetDirectoryName(executable),
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        Uri uri;
        if (Uri.TryCreate(baseUrl, UriKind.Absolute, out uri) && uri.IsLoopback)
            info.EnvironmentVariables["OLLAMA_HOST"] = uri.Authority;
        var process = Process.Start(info);
        if (process == null) throw new InvalidOperationException("ollama.exe could not be started.");
        return process;
    }

    private static bool WaitForOllama(string baseUrl, Process process)
    {
        var deadline = DateTime.UtcNow.AddSeconds(20);
        while (DateTime.UtcNow < deadline)
        {
            if (Ready(baseUrl)) return true;
            if (process.HasExited) return false;
            Thread.Sleep(250);
        }
        return Ready(baseUrl);
    }

    private static bool Ready(string baseUrl)
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(baseUrl.TrimEnd('/') + "/api/tags");
            request.Timeout = 750;
            request.ReadWriteTimeout = 750;
            request.Proxy = null;
            using (var response = (HttpWebResponse)request.GetResponse())
                return (int)response.StatusCode >= 200 && (int)response.StatusCode < 300;
        }
        catch { return false; }
    }

    private static string FindOllama(string envFile)
    {
        var configured = Env(envFile, "OLLAMA_EXE");
        if (!String.IsNullOrWhiteSpace(configured) && File.Exists(configured)) return configured;
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var directory in path.Split(Path.PathSeparator))
        {
            var candidate = Path.Combine(directory.Trim().Trim('"'), "ollama.exe");
            if (File.Exists(candidate)) return candidate;
        }
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        foreach (var candidate in new[]
        {
            Path.Combine(local, "Programs", "Ollama", "ollama.exe"),
            Path.Combine(local, "Ollama", "ollama.exe"),
            Path.Combine(programFiles, "Ollama", "ollama.exe")
        })
            if (File.Exists(candidate)) return candidate;
        return null;
    }

    private static string Env(string file, string name)
    {
        if (!File.Exists(file)) return null;
        foreach (var raw in File.ReadAllLines(file))
        {
            var line = raw.Trim();
            if (line.StartsWith("#") || !line.StartsWith(name + "=", StringComparison.OrdinalIgnoreCase)) continue;
            var value = line.Substring(line.IndexOf('=') + 1).Trim();
            if (value.Length >= 2 && ((value[0] == '"' && value[value.Length - 1] == '"') ||
                (value[0] == '\'' && value[value.Length - 1] == '\'')))
                value = value.Substring(1, value.Length - 2);
            return value;
        }
        return null;
    }

    private static void StopOwnedOllama(Process process)
    {
        if (process == null) return;
        try
        {
            if (process.HasExited) return;
            using (var killer = Process.Start(new ProcessStartInfo
            {
                FileName = "taskkill.exe",
                Arguments = "/PID " + process.Id + " /T /F",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            }))
                if (killer != null) killer.WaitForExit(5000);
            if (!process.HasExited) process.Kill();
        }
        catch { }
        finally { process.Dispose(); }
    }

    private static void Error(string message)
    {
        MessageBox.Show(message, "Seline", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}
