using System.Text.Json;
using Zilux2.Analysis;

if (args.Length == 3)
{
    var channels = int.Parse(args[1]);
    var meter = new LoudnessMeter(int.Parse(args[2]), channels);
    using var reader = new BinaryReader(File.OpenRead(args[0]));
    var frame = new float[channels];
    while (reader.BaseStream.Position + channels * 4 <= reader.BaseStream.Length)
    {
        for (var c = 0; c < channels; c++) frame[c] = reader.ReadSingle();
        meter.PushFrame(frame);
    }
    var measured = meter.Finish();
    Console.WriteLine(JsonSerializer.Serialize(new { measured.IntegratedLufs, measured.PeakDb }));
    return;
}

static LoudnessMeasurement Tone(int rate, int channels, bool inverted = false, bool silence = false)
{
    var meter = new LoudnessMeter(rate, channels);
    var frame = new float[channels];
    for (var i = 0; i < rate * 10; i++)
    {
        var value = silence ? 0 : (float)(.1 * Math.Sin(2 * Math.PI * 1000 * i / rate));
        frame[0] = value;
        if (channels == 2) frame[1] = inverted ? -value : value;
        meter.PushFrame(frame);
    }
    return meter.Finish();
}

static void Near(double a, double b, double tolerance, string reason)
{
    if (Math.Abs(a - b) > tolerance) throw new Exception($"{reason}: {a} vs {b}");
}
foreach (var rate in new[] { 44100, 48000, 96000 })
{
    var mono = Tone(rate, 1);
    var stereo = Tone(rate, 2);
    Near(mono.IntegratedLufs, -23, .1, "1kHz reference");
    Near(stereo.IntegratedLufs - mono.IntegratedLufs, 3.0103, .001, "channel summation");
    Near(Tone(rate, 2, true).IntegratedLufs, stereo.IntegratedLufs, .001, "antiphase must not cancel");
    Near(mono.PeakDb, -20, .01, "sample peak");
    Near(Tone(rate, 2, silence: true).IntegratedLufs, -70, 0, "silence finite floor");
}
// Absolute and relative gating should exclude a long, much quieter segment.
var gated = new LoudnessMeter(48000, 1);
var sample = new float[1];
for (var i = 0; i < 48000 * 30; i++)
{
    sample[0] = (float)((i < 48000 * 10 ? .1 : .0001) * Math.Sin(2 * Math.PI * 1000 * i / 48000));
    gated.PushFrame(sample);
}
Near(gated.Finish().IntegratedLufs, -23, .15, "relative gate");
Console.WriteLine("PASS: 16 loudness checks (3 sample rates, reference, stereo, antiphase, peak, silence, gate)");
