using System;
using System.IO;
using NAudio.Wave;

internal static class Program
{
    private static void Main()
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        var folder = @"C:\Users\13329\Music";
        string? target = null;
        foreach (var name in Directory.GetFiles(folder, "*.m4a"))
        {
            target = name;
            Console.WriteLine("m4a: " + Path.GetFileName(name) + " " + new FileInfo(name).Length);
        }

        if (target is null)
        {
            Console.WriteLine("no m4a");
            return;
        }

        try
        {
            using var reader = new MediaFoundationReader(target);
            Console.WriteLine("format: " + reader.WaveFormat);
            var buffer = new byte[reader.WaveFormat.AverageBytesPerSecond * 2];
            var total = 0;
            long peak = 0;
            while (total < reader.WaveFormat.AverageBytesPerSecond * 4)
            {
                var read = reader.Read(buffer, 0, buffer.Length);
                if (read <= 0)
                {
                    break;
                }

                for (var i = 0; i + 1 < read; i += 2)
                {
                    var value = Math.Abs((int)BitConverter.ToInt16(buffer, i));
                    if (value > peak)
                    {
                        peak = value;
                    }
                }

                total += read;
            }

            Console.WriteLine($"decoded {total} bytes, peak={peak}");
        }
        catch (Exception exception)
        {
            Console.WriteLine("MF DECODE FAILED: " + exception.GetType().Name + ": " + exception.Message);
        }
    }
}
