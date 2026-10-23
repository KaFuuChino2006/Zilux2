using System.Text;
using Zilux2.AirPlay;
using Zilux2.AirPlay.Discovery;

Console.OutputEncoding = Encoding.UTF8;

var discovery = new AirPlayDiscovery();
discovery.OnError += message => Console.WriteLine($"[error] {message}");
discovery.OnTrace += message => Console.WriteLine($"[trace] {message}");
discovery.DevicesChanged += devices =>
{
    Console.WriteLine($"[devices] count={devices.Count}");
    foreach (var device in devices)
    {
        Console.WriteLine(
            $"  id={device.Id} name={device.Name} host={device.Host}:{device.Port} " +
            $"model={device.Model} pwd={device.RequiresPassword} airplay2={device.SupportsAirPlay2}");
    }
};

Console.WriteLine("[probe] starting discovery for 12s ...");
try
{
    discovery.Start();
    Console.WriteLine($"[probe] running={discovery.IsRunning}");
}
catch (Exception exception)
{
    Console.WriteLine($"[probe] start failed: {exception.GetType().Name}: {exception.Message}");
    return 1;
}

await Task.Delay(TimeSpan.FromSeconds(12));

Console.WriteLine($"[probe] devices seen={discovery.Devices.Count}");
discovery.Stop();
discovery.Dispose();
Console.WriteLine("[probe] done");
return 0;
