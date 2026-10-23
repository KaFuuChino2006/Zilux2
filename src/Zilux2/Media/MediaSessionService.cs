using System.Globalization;
using System.Windows.Threading;
using Windows.Media;

namespace Zilux2.Media;

/// <summary>Playback snapshot pushed by the page (contract §11).</summary>
internal sealed record MediaState(
    string Title,
    string Artist,
    string Album,
    string? CoverUrl,
    double DurationMs,
    double PositionMs,
    bool Playing);

/// <summary>Command coming back from the Windows Now Playing UI / media keys.</summary>
internal sealed record MediaControlCommand(string Action, double? PositionMs);

/// <summary>
/// Bridges the page's playback state into the Windows SystemMediaTransportControls session and
/// forwards Now Playing / media-key commands back. Desktop apps cannot use GetForCurrentView,
/// so the window-scoped interop factory is used instead (no extra NuGet package needed).
/// </summary>
internal sealed class MediaSessionService : IDisposable
{
    // The page is expected to push at most 10 state updates per second; coalesce defensively.
    private const int MinUpdateIntervalMs = 100;
    private const int MaxTextLength = 256;

    private readonly Dispatcher _dispatcher = Dispatcher.CurrentDispatcher;
    private readonly object _gate = new();
    private readonly Timer _coalescer;

    private SystemMediaTransportControls? _controls;
    private SystemMediaTransportControlsTimelineProperties? _timeline;
    private MediaState? _pending;
    private bool _coalesceScheduled;
    private long _lastApplyTicks;
    private bool _disposed;
    private bool _unavailableLogged;
    private CancellationTokenSource? _coverCts;
    private string? _coverSource;

    public MediaSessionService()
    {
        _coalescer = new Timer(_ => FlushPending(), null, Timeout.Infinite, Timeout.Infinite);
    }

    /// <summary>Raised when Windows asks the app to change playback. May arrive off the UI thread.</summary>
    public event Action<MediaControlCommand>? ControlRequested;

    public bool IsAvailable
    {
        get
        {
            lock (_gate)
            {
                return _controls is not null;
            }
        }
    }

    /// <summary>
    /// Creates the SMTC session for the host window. Called after the page is ready; repeated
    /// calls are ignored. Any WinRT failure only disables Now Playing, never the app.
    /// </summary>
    public void Enable(IntPtr windowHandle)
    {
        if (_disposed)
        {
            return;
        }

        lock (_gate)
        {
            if (_controls is not null)
            {
                return;
            }
        }

        try
        {
            var controls = SystemMediaTransportControlsInterop.GetForWindow(windowHandle);
            controls.IsEnabled = true;
            controls.IsPlayEnabled = true;
            controls.IsPauseEnabled = true;
            controls.IsStopEnabled = true;
            controls.IsNextEnabled = true;
            controls.IsPreviousEnabled = true;
            controls.IsFastForwardEnabled = false;
            controls.IsRewindEnabled = false;
            controls.IsRecordEnabled = false;
            controls.IsChannelUpEnabled = false;
            controls.IsChannelDownEnabled = false;
            controls.DisplayUpdater.Type = MediaPlaybackType.Music;
            controls.PlaybackStatus = MediaPlaybackStatus.Paused;
            controls.ButtonPressed += OnButtonPressed;
            controls.PlaybackPositionChangeRequested += OnPositionChangeRequested;

            lock (_gate)
            {
                _controls = controls;
            }

            HostLog.Info("[smtc] enabled");
        }
        catch (Exception exception)
        {
            if (!_unavailableLogged)
            {
                _unavailableLogged = true;
                HostLog.Warn($"[smtc] unavailable: {Describe(exception)}");
            }
        }
    }

    /// <summary>Applies the latest state; throttled so a chatty page cannot flood the shell.</summary>
    public void Update(MediaState state)
    {
        if (_disposed)
        {
            return;
        }

        lock (_gate)
        {
            _pending = state;
            if (_controls is null)
            {
                return;
            }

            var wait = MinUpdateIntervalMs - (int)(Environment.TickCount64 - _lastApplyTicks);
            if (wait > 0)
            {
                if (!_coalesceScheduled)
                {
                    _coalesceScheduled = true;
                    _coalescer.Change(wait, Timeout.Infinite);
                }

                return;
            }

            _coalesceScheduled = false;
            ApplyLocked(state);
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _coverCts?.Cancel();
        _coverCts?.Dispose();
        _coverCts = null;
        _coalescer.Dispose();

        SystemMediaTransportControls? controls;
        lock (_gate)
        {
            controls = _controls;
            _controls = null;
            _pending = null;
        }

        if (controls is null)
        {
            return;
        }

        try
        {
            controls.ButtonPressed -= OnButtonPressed;
            controls.PlaybackPositionChangeRequested -= OnPositionChangeRequested;
            // Clear the session so the shell does not keep a ghost "Now Playing" tile after exit.
            controls.PlaybackStatus = MediaPlaybackStatus.Closed;
            controls.DisplayUpdater.ClearAll();
            controls.DisplayUpdater.Update();
            controls.IsEnabled = false;
            HostLog.Info("[smtc] disabled");
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[smtc] dispose failed: {Describe(exception)}");
        }
    }

    private void FlushPending()
    {
        lock (_gate)
        {
            _coalesceScheduled = false;
            if (_disposed || _pending is null)
            {
                return;
            }

            ApplyLocked(_pending);
        }
    }

    // Caller must hold _gate.
    private void ApplyLocked(MediaState state)
    {
        var controls = _controls;
        if (controls is null)
        {
            return;
        }

        _pending = null;
        _lastApplyTicks = Environment.TickCount64;

        try
        {
            controls.PlaybackStatus = state.Playing ? MediaPlaybackStatus.Playing : MediaPlaybackStatus.Paused;

            var updater = controls.DisplayUpdater;
            var music = updater.MusicProperties;
            music.Title = Clip(state.Title);
            music.Artist = Clip(state.Artist);
            music.AlbumTitle = Clip(state.Album);
            updater.Update();

            var timeline = _timeline;
            if (timeline is null)
            {
                timeline = new SystemMediaTransportControlsTimelineProperties
                {
                    StartTime = TimeSpan.Zero,
                    MinSeekTime = TimeSpan.Zero,
                };
                _timeline = timeline;
            }

            var duration = ClampTime(state.DurationMs);
            var position = ClampTime(state.PositionMs);
            if (position > duration)
            {
                position = duration;
            }

            timeline.EndTime = duration;
            timeline.MaxSeekTime = duration;
            timeline.Position = position;
            controls.UpdateTimelineProperties(timeline);

            if (!string.Equals(state.CoverUrl, _coverSource, StringComparison.Ordinal))
            {
                RequestCoverLocked(state.CoverUrl);
            }

            HostLog.Info(
                $"[smtc] state title=\"{ClipForLog(state.Title)}\" playing={state.Playing.ToString().ToLowerInvariant()} " +
                $"positionMs={(long)Math.Round(state.PositionMs)} durationMs={(long)Math.Round(state.DurationMs)}");
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[smtc] update failed: {Describe(exception)}");
        }
    }

    // Caller must hold _gate.
    private void RequestCoverLocked(string? coverUrl)
    {
        _coverSource = coverUrl;
        _coverCts?.Cancel();
        _coverCts?.Dispose();
        _coverCts = null;

        var controls = _controls;
        if (controls is null)
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(coverUrl))
        {
            try
            {
                controls.DisplayUpdater.Thumbnail = null;
                controls.DisplayUpdater.Update();
            }
            catch (Exception exception)
            {
                HostLog.Warn($"[smtc] cover clear failed: {Describe(exception)}");
            }

            return;
        }

        var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        _coverCts = cts;
        _ = LoadCoverAsync(coverUrl, controls, cts);
    }

    private async Task LoadCoverAsync(string coverUrl, SystemMediaTransportControls controls, CancellationTokenSource cts)
    {
        try
        {
            var reference = await SmtcArtwork.LoadAsync(coverUrl, cts.Token).ConfigureAwait(false);
            if (reference is null)
            {
                HostLog.Warn("[smtc] cover skipped: unavailable");
                return;
            }

            await _dispatcher.InvokeAsync(() =>
            {
                if (_disposed || cts.IsCancellationRequested || !ReferenceEquals(_controls, controls))
                {
                    return;
                }

                try
                {
                    controls.DisplayUpdater.Thumbnail = reference;
                    controls.DisplayUpdater.Update();
                    HostLog.Info("[smtc] cover updated");
                }
                catch (Exception exception)
                {
                    HostLog.Warn($"[smtc] cover failed: {Describe(exception)}");
                }
            });
        }
        catch (OperationCanceledException)
        {
            // A newer cover request superseded this one.
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[smtc] cover failed: {Describe(exception)}");
        }
    }

    private void OnButtonPressed(SystemMediaTransportControls sender, SystemMediaTransportControlsButtonPressedEventArgs args)
    {
        var action = args.Button switch
        {
            SystemMediaTransportControlsButton.Play => "play",
            SystemMediaTransportControlsButton.Pause => "pause",
            SystemMediaTransportControlsButton.Stop => "stop",
            SystemMediaTransportControlsButton.Next => "next",
            SystemMediaTransportControlsButton.Previous => "prev",
            _ => null,
        };

        if (action is null)
        {
            return;
        }

        HostLog.Info($"[smtc] control pressed action={action}");
        RaiseControl(new MediaControlCommand(action, null));
    }

    private void OnPositionChangeRequested(SystemMediaTransportControls sender, PlaybackPositionChangeRequestedEventArgs args)
    {
        var positionMs = (long)Math.Round(args.RequestedPlaybackPosition.TotalMilliseconds);
        if (positionMs < 0)
        {
            positionMs = 0;
        }

        HostLog.Info($"[smtc] seek requested positionMs={positionMs}");
        RaiseControl(new MediaControlCommand("seek", positionMs));
    }

    private void RaiseControl(MediaControlCommand command)
    {
        try
        {
            ControlRequested?.Invoke(command);
        }
        catch (Exception exception)
        {
            HostLog.Error("[smtc] control dispatch failed", exception);
        }
    }

    private static string Clip(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        var trimmed = value.Trim();
        return trimmed.Length <= MaxTextLength ? trimmed : trimmed[..MaxTextLength];
    }

    private static string ClipForLog(string? value)
    {
        var clipped = Clip(value);
        return clipped.Length <= 80 ? clipped : clipped[..80] + "…";
    }

    private static TimeSpan ClampTime(double milliseconds)
    {
        if (!double.IsFinite(milliseconds) || milliseconds <= 0)
        {
            return TimeSpan.Zero;
        }

        // Media session timeline values are TimeSpan; cap to a sane ~24h ceiling.
        return TimeSpan.FromMilliseconds(Math.Min(milliseconds, 24 * 60 * 60 * 1000));
    }

    private static string Describe(Exception exception) => $"{exception.GetType().Name}: {exception.Message}";
}

internal static class MediaControlMessage
{
    public static string Build(MediaControlCommand command)
    {
        if (command.PositionMs is double position)
        {
            var rounded = ((long)Math.Round(position)).ToString(CultureInfo.InvariantCulture);
            return "{\"v\":1,\"type\":\"host\",\"event\":\"mediaControl\",\"payload\":{\"action\":\"" +
                   command.Action + "\",\"positionMs\":" + rounded + "}}";
        }

        return "{\"v\":1,\"type\":\"host\",\"event\":\"mediaControl\",\"payload\":{\"action\":\"" +
               command.Action + "\"}}";
    }
}
