using System.Text.Json;

namespace Zilux2.Settings;

// Translates `{type:'settings',action:...}` page messages into service calls and ACK snapshots.
internal sealed class SettingsBridge
{
    private readonly SettingsService _settings;

    internal SettingsBridge(SettingsService settings) => _settings = settings;

    internal string CreateSnapshotJson() => _settings.CreateSnapshotJson();

    // Returns the snapshot JSON to post back, or null when the message was ignored.
    internal string? Handle(JsonElement message)
    {
        var action = message.TryGetProperty("action", out var actionElement) && actionElement.ValueKind == JsonValueKind.String
            ? actionElement.GetString() ?? string.Empty
            : string.Empty;

        switch (action)
        {
            case "request":
                // Contract section 3.1: the page sends this before `ready`; always answer.
                HostLog.Info("[settings] request");
                return _settings.CreateSnapshotJson();

            case "patch":
                if (message.TryGetProperty("patch", out var patch) && patch.ValueKind == JsonValueKind.Object)
                {
                    _settings.Patch(patch);
                }
                else
                {
                    HostLog.Warn("[settings] patch ignored (missing patch object)");
                }

                return _settings.CreateSnapshotJson();

            case "reset":
                _settings.Reset();
                return _settings.CreateSnapshotJson();

            default:
                HostLog.Warn($"[settings] unknown action={action}");
                return null;
        }
    }
}
