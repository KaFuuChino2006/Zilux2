using System;
using System.IO;
using Zilux2.AirPlay.Crypto;

namespace Zilux2.AirPlay.Ap2;

/// <summary>
/// Persists HAP pairing credentials per receiver so a PIN only has to be typed once.
/// macOS keeps the pairing record on its side too, so later connections can run
/// pair-verify (no prompt) instead of pair-setup (4-digit PIN on screen).
/// Files live under <c>%LOCALAPPDATA%\Zilux2\airplay\pairing</c> and never leave the machine.
/// </summary>
internal static class Ap2PairingStore
{
    private static readonly object Sync = new();

    /// <summary>Loads the stored long-term credentials for a receiver. Safe to call on any thread.</summary>
    public static bool TryLoad(string host, out HapCredentials credentials)
    {
        credentials = null!;
        var path = ResolvePath(host);
        try
        {
            lock (Sync)
            {
                if (!File.Exists(path))
                {
                    return false;
                }

                var bytes = File.ReadAllBytes(path);
                var loaded = HapCredentials.Deserialize(bytes);
                if (!loaded.IsValid || loaded.IsTransient)
                {
                    HostLog.Warn("[airplay] stored pairing invalid, ignoring");
                    return false;
                }

                credentials = loaded;
                return true;
            }
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[airplay] stored pairing unreadable: {exception.GetType().Name}: {exception.Message}");
            return false;
        }
    }

    /// <summary>Saves long-term credentials returned by pair-setup.</summary>
    public static void Save(string host, HapCredentials credentials)
    {
        if (!credentials.IsValid || credentials.IsTransient)
        {
            return;
        }

        var path = ResolvePath(host);
        try
        {
            var directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            lock (Sync)
            {
                File.WriteAllBytes(path, credentials.Serialize());
            }

            HostLog.Info($"[airplay] pairing saved for {host}");
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[airplay] pairing save failed: {exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>Drops stale credentials (pair-verify failed) so the next connect re-pairs.</summary>
    public static void Delete(string host)
    {
        var path = ResolvePath(host);
        try
        {
            lock (Sync)
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[airplay] pairing delete failed: {exception.GetType().Name}: {exception.Message}");
        }
    }

    private static string ResolvePath(string host)
    {
        var safeHost = host.Trim().ToLowerInvariant();
        foreach (var invalid in Path.GetInvalidFileNameChars())
        {
            safeHost = safeHost.Replace(invalid, '_');
        }

        return Path.Combine(HostFolders.Root, "airplay", "pairing", safeHost + ".hap");
    }
}
