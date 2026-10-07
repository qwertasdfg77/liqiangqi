using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;

[assembly: AssemblyTitle("力墙棋")]
[assembly: AssemblyDescription("最高难度人机对弈 · 完整便携版")]
[assembly: AssemblyVersion("1.8.0.0")]
[assembly: AssemblyFileVersion("1.8.0.0")]

internal sealed class PayloadFile
{
    internal string Name;
    internal string Hash;
    internal long Size;
}

internal static class PortableLauncher
{
    private static readonly object LogGate = new object();
    private static string logRoot;

    private static void Log(string message)
    {
        if (String.IsNullOrEmpty(logRoot)) return;
        try
        {
            lock (LogGate)
            {
                Directory.CreateDirectory(logRoot);
                string filename = Path.Combine(logRoot, "startup.log");
                if (File.Exists(filename) && new FileInfo(filename).Length > 1024 * 1024)
                    File.WriteAllText(filename, "", Encoding.UTF8);
                File.AppendAllText(filename, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine, Encoding.UTF8);
            }
        }
        catch { /* Diagnostics must never prevent the game from starting. */ }
    }

    private static string Hash(Stream stream)
    {
        using (SHA256 algorithm = SHA256.Create())
            return BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }

    private static string FileHash(string filename)
    {
        using (FileStream stream = File.OpenRead(filename)) return Hash(stream);
    }

    private static string PayloadPath(string root, string relative)
    {
        string target = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!target.StartsWith(Path.GetFullPath(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("游戏文件路径不正确。");
        return target;
    }

    private static Dictionary<string, PayloadFile> Manifest()
    {
        Dictionary<string, PayloadFile> files = new Dictionary<string, PayloadFile>(StringComparer.Ordinal);
        using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("lqq.manifest"))
        using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
        {
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                string[] parts = line.Split('|');
                if (parts.Length != 3) throw new InvalidDataException("游戏文件清单不完整。");
                files.Add(parts[0], new PayloadFile { Name = parts[0], Hash = parts[1], Size = long.Parse(parts[2]) });
            }
        }
        return files;
    }

    private static bool Valid(string root, PayloadFile file)
    {
        string filename = PayloadPath(root, file.Name);
        return File.Exists(filename) && new FileInfo(filename).Length == file.Size && FileHash(filename) == file.Hash;
    }

    private static void EnsurePayload(string root)
    {
        Dictionary<string, PayloadFile> files = Manifest();
        List<PayloadFile> missing = new List<PayloadFile>();
        foreach (PayloadFile file in files.Values) if (!Valid(root, file)) missing.Add(file);
        if (missing.Count == 0) return;
        Directory.CreateDirectory(root);
        using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("lqq.payload"))
        using (ZipArchive archive = new ZipArchive(stream, ZipArchiveMode.Read))
        {
            if (archive.Entries.Count != files.Count) throw new InvalidDataException("游戏包不完整。");
            foreach (ZipArchiveEntry entry in archive.Entries)
                if (!files.ContainsKey(entry.FullName)) throw new InvalidDataException("游戏包包含未知文件。");
            foreach (PayloadFile file in missing)
            {
                ZipArchiveEntry entry = archive.GetEntry(file.Name);
                if (entry == null || entry.Length != file.Size) throw new InvalidDataException("游戏文件不完整。");
                string destination = PayloadPath(root, file.Name);
                Directory.CreateDirectory(Path.GetDirectoryName(destination));
                string temporary = destination + "." + Guid.NewGuid().ToString("N") + ".partial";
                try
                {
                    using (Stream input = entry.Open())
                    using (FileStream output = File.Create(temporary)) input.CopyTo(output);
                    if (FileHash(temporary) != file.Hash) throw new InvalidDataException("游戏文件校验失败，请重新复制完整的 exe。");
                    File.Copy(temporary, destination, true);
                }
                finally { if (File.Exists(temporary)) File.Delete(temporary); }
            }
        }
    }

    private static string Quoted(string value) { return "\"" + value + "\""; }

    private static bool MatchingService(string candidate, string app)
    {
        try
        {
            Uri url;
            if (!Uri.TryCreate(candidate, UriKind.Absolute, out url) ||
                url.Scheme != "http" || url.Host != "127.0.0.1" || url.Port < 1) return false;
            JavaScriptSerializer json = new JavaScriptSerializer();
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(new Uri(url, "/api/info"));
            request.Proxy = null; request.Timeout = 1000; request.ReadWriteTimeout = 1000;
            using (WebResponse response = request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
            {
                Dictionary<string, object> info = json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                return (string)info["service"] == "lqq-duel-local-v2" &&
                    String.Equals(Path.GetFullPath((string)info["root"]), app, StringComparison.OrdinalIgnoreCase);
            }
        }
        catch { return false; }
    }

    private static string ReadyAddress(string local, string app, string announced)
    {
        if (!String.IsNullOrEmpty(announced) && MatchingService(announced, app)) return announced;
        try
        {
            string id;
            using (MemoryStream bytes = new MemoryStream(Encoding.UTF8.GetBytes(app))) id = Hash(bytes).Substring(0, 20);
            string addressFile = Path.Combine(local, "LqqDuel", id + ".json");
            foreach (string filename in new string[] { addressFile, Path.Combine(Path.GetDirectoryName(app), "service-address.json") })
            {
                try
                {
                    Dictionary<string, object> saved = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(filename));
                    string candidate = (string)saved["url"];
                    if (MatchingService(candidate, app)) return candidate;
                }
                catch { }
            }
        }
        catch { }
        const string fallback = "http://127.0.0.1:18741";
        return MatchingService(fallback, app) ? fallback : null;
    }

    private static void OpenBrowser(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
            Log("BROWSER_OPENED " + url);
        }
        catch (Exception error)
        {
            Log("BROWSER_ERROR " + error);
            MessageBox.Show("游戏已启动。请在浏览器地址栏打开：\n" + url,
                "力墙棋 · 游戏已启动", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        bool noBrowser = Array.IndexOf(args, "--no-browser") >= 0;
        try
        {
            if (!Environment.Is64BitOperatingSystem) throw new PlatformNotSupportedException("此便携版适用于 Windows 10 / 11 的 64 位电脑。");
            string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
            if (String.IsNullOrEmpty(local)) local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string root = Path.GetFullPath(Path.Combine(local, "LqqPortable", PackageInfo.Id));
            logRoot = root;
            Log("LAUNCH version=1.8.0 browser=" + !noBrowser);
            string lockHash;
            using (MemoryStream bytes = new MemoryStream(Encoding.UTF8.GetBytes(root.ToLowerInvariant()))) lockHash = Hash(bytes);
            using (Mutex gate = new Mutex(false, "Local\\LqqPortable-" + lockHash.Substring(0, 20)))
            {
                bool acquired = false;
                try
                {
                    try { acquired = gate.WaitOne(TimeSpan.FromSeconds(60)); }
                    catch (AbandonedMutexException) { acquired = true; }
                    if (!acquired) throw new TimeoutException("另一次启动尚未完成，请稍后再试。");
                    EnsurePayload(root);
                    string app = Path.Combine(root, "app");
                    string ready = ReadyAddress(local, app, null);
                    if (ready != null)
                    {
                        // Reopening an already running game must not start another
                        // Node process or race its exit against the health check.
                        Log("REUSE " + ready);
                        if (!noBrowser) OpenBrowser(ready);
                        Console.WriteLine("PORTABLE_ROOT=" + root);
                        return 0;
                    }
                    string arguments = Quoted(Path.Combine(app, "server.cjs"));
                    string resume = Path.Combine(root, "resume-game.json");
                    if (File.Exists(resume)) arguments += " --resume " + Quoted(resume);
                    ProcessStartInfo info = new ProcessStartInfo {
                        FileName = Path.Combine(root, "runtime", "node.exe"),
                        Arguments = arguments,
                        WorkingDirectory = app,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WindowStyle = ProcessWindowStyle.Hidden,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        StandardOutputEncoding = Encoding.UTF8,
                        StandardErrorEncoding = Encoding.UTF8
                    };
                    info.EnvironmentVariables.Remove("NODE_OPTIONS");
                    info.EnvironmentVariables.Remove("NODE_PATH");
                    using (Process server = Process.Start(info))
                    {
                        string announced = null;
                        object outputGate = new object();
                        server.OutputDataReceived += delegate(object sender, DataReceivedEventArgs line) {
                            if (line.Data == null) return;
                            Log("NODE_OUT " + line.Data);
                            if (line.Data.StartsWith("GAME_URL=", StringComparison.Ordinal))
                                lock (outputGate) announced = line.Data.Substring(9);
                        };
                        server.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs line) {
                            if (line.Data != null) Log("NODE_ERROR " + line.Data);
                        };
                        server.BeginOutputReadLine(); server.BeginErrorReadLine();
                        Log("NODE_STARTED pid=" + server.Id);
                        // Serialize concurrent launches until the matching local service is ready.
                        Stopwatch startup = Stopwatch.StartNew();
                        try
                        {
                            while (ready == null)
                            {
                                string candidate; lock (outputGate) candidate = announced;
                                ready = ReadyAddress(local, app, candidate);
                                if (ready != null) break;
                                if (server.HasExited)
                                {
                                    server.WaitForExit();
                                    throw new InvalidOperationException("本地游戏未能启动，退出码 " + server.ExitCode + "。\n详细原因已记录在：\n" + Path.Combine(root, "startup.log"));
                                }
                                if (startup.Elapsed > TimeSpan.FromSeconds(30))
                                    throw new TimeoutException("本地游戏启动超时。\n详细记录：\n" + Path.Combine(root, "startup.log"));
                                Thread.Sleep(100);
                            }
                        }
                        catch
                        {
                            // Only stop the exact child created by this attempt.
                            if (!server.HasExited) { server.Kill(); server.WaitForExit(); }
                            throw;
                        }
                    }
                    Log("READY " + ready);
                    try
                    {
                        File.WriteAllText(Path.Combine(root, "service-address.json"),
                            new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "url", ready }, { "root", app } }), Encoding.UTF8);
                    }
                    catch (Exception addressError) { Log("ADDRESS_WARNING " + addressError.Message); }
                    if (File.Exists(resume)) File.Delete(resume);
                    if (!noBrowser) OpenBrowser(ready);
                    Console.WriteLine("PORTABLE_ROOT=" + root);
                }
                finally { if (acquired) gate.ReleaseMutex(); }
            }
            return 0;
        }
        catch (Exception error)
        {
            Log("LAUNCH_ERROR " + error);
            if (noBrowser) Console.Error.WriteLine(error.ToString());
            else MessageBox.Show(error.Message, "力墙棋 · 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
