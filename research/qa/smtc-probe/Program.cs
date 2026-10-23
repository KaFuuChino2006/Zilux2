using Windows.Media.Control;

var manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
var sessions = manager.GetSessions();
Console.WriteLine($"sessions: {sessions.Count}");
foreach (var item in sessions)
{
    var props = await item.TryGetMediaPropertiesAsync();
    var info = item.GetPlaybackInfo();
    Console.WriteLine(
        $"  app={item.SourceAppUserModelId} title={props.Title} artist={props.Artist} status={info?.PlaybackStatus}");
}

var target = sessions.FirstOrDefault((s) =>
    s.SourceAppUserModelId.Contains("Zilux", StringComparison.OrdinalIgnoreCase));
if (target is null)
{
    Console.WriteLine("no Zilux2 session found");
    return 1;
}

var before = target.GetPlaybackInfo()?.PlaybackStatus;
var toggled = await target.TryTogglePlayPauseAsync();
await Task.Delay(1200);
var after = target.GetPlaybackInfo()?.PlaybackStatus;
Console.WriteLine($"zilux session: before={before} toggleResult={toggled} after={after}");
var timeline = target.GetTimelineProperties();
Console.WriteLine($"timeline: position={timeline.Position} end={timeline.EndTime}");
return 0;
