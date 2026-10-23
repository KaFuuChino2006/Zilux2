import io
import re
from pathlib import Path

root = Path(r"E:\Zilux2开发")

# 1) csproj: reference NAudio DLLs bundled in repo (lib folder)
csproj_path = root / "src" / "Zilux2" / "Zilux2.csproj"
with io.open(csproj_path, "r", encoding="utf-8", newline="") as handle:
    text = handle.read()
crlf = "\r\n" in text
normalized = text.replace("\r\n", "\n")

anchor = """  <ItemGroup>
    <PackageReference Include="Microsoft.Web.WebView2" Version="1.0.4191.47" />
  </ItemGroup>"""
assert normalized.count(anchor) == 1, normalized.count(anchor)
replacement = anchor + """

  <ItemGroup>
    <!-- NAudio：用系统 Media Foundation 解 ALAC 的 .m4a（WebView2 自身不支持 ALAC）。 -->
    <Reference Include="NAudio.Core">
      <HintPath>$(MSBuildThisFileDirectory)lib\\NAudio.Core.dll</HintPath>
      <Private>true</Private>
    </Reference>
    <Reference Include="NAudio.Wasapi">
      <HintPath>$(MSBuildThisFileDirectory)lib\\NAudio.Wasapi.dll</HintPath>
      <Private>true</Private>
    </Reference>
  </ItemGroup>"""
normalized = normalized.replace(anchor, replacement)
with io.open(csproj_path, "w", encoding="utf-8", newline="") as handle:
    handle.write(normalized.replace("\n", "\r\n") if crlf else normalized)
print("OK: csproj")

# 2) LocalMusicService: serve ALAC m4a as transcoded WAV
service_path = root / "src" / "Zilux2" / "Local" / "LocalMusicService.cs"
with io.open(service_path, "r", encoding="utf-8", newline="") as handle:
    text = handle.read()
crlf = "\r\n" in text
normalized = text.replace("\r\n", "\n")

old = """        if (string.Equals(Path.GetExtension(fullPath), ".dsf", StringComparison.OrdinalIgnoreCase))
        {
            if (!DsfTranscoder.TryEnsureWav(fullPath, out var wavPath, out var error))
            {
                HostLog.Warn($"[local] dsf transcode failed {Path.GetFileName(fullPath)}: {error}");
                Respond(e, core, 415, "Unsupported Media Type", "text/plain", System.Text.Encoding.UTF8.GetBytes(error));
                return;
            }

            path = wavPath;
            contentType = "audio/wav";
        }
"""
assert normalized.count(old) == 1, normalized.count(old)
new = """        if (string.Equals(Path.GetExtension(fullPath), ".dsf", StringComparison.OrdinalIgnoreCase))
        {
            if (!DsfTranscoder.TryEnsureWav(fullPath, out var wavPath, out var error))
            {
                HostLog.Warn($"[local] dsf transcode failed {Path.GetFileName(fullPath)}: {error}");
                Respond(e, core, 415, "Unsupported Media Type", "text/plain", System.Text.Encoding.UTF8.GetBytes(error));
                return;
            }

            path = wavPath;
            contentType = "audio/wav";
        }
        else if (string.Equals(Path.GetExtension(fullPath), ".m4a", StringComparison.OrdinalIgnoreCase)
            && AlacTranscoder.IsAlac(fullPath))
        {
            // ALAC 无损 m4a：WebView2 解不了，先转成 PCM WAV 再流式服务
            if (!AlacTranscoder.TryEnsureWav(fullPath, out var alacWavPath, out var alacError))
            {
                HostLog.Warn($"[local] alac transcode failed {Path.GetFileName(fullPath)}: {alacError}");
                Respond(e, core, 415, "Unsupported Media Type", "text/plain", System.Text.Encoding.UTF8.GetBytes(alacError));
                return;
            }

            path = alacWavPath;
            contentType = "audio/wav";
        }
"""
normalized = normalized.replace(old, new)
with io.open(service_path, "w", encoding="utf-8", newline="") as handle:
    handle.write(normalized.replace("\n", "\r\n") if crlf else normalized)
print("OK: localmusic-alac")
