using System.Runtime.InteropServices;

namespace Zilux2.Interop;

/// <summary>
/// 主屏开游戏时副屏掉帧的进程侧补救。
///
/// 根因不在页面代码，而是三层调度：
///   1) WDDM 按进程调度 GPU 队列。游戏（尤其独占全屏 / 开了「窗口化游戏优化」）跑满 GPU 后，
///      桌面窗口与普通应用的提交优先级低，DWM 合成被挤压，副屏的 Present 被拖到个位数帧；
///   2) Windows 11 的 EcoQoS（Power Throttling）会把判定为「后台」的进程降到低功耗状态，
///      CPU/GPU 一起限频；
///   3) Chromium / WebView2 自己也有一套后台降级（遮挡计算、renderer backgrounding、EcoQoS）。
///
/// 第 3 层已经由 WebViewHost.BrowserArguments 关掉；本类补第 1、2 层，并且只影响本进程树，
/// 强度是 ABOVE_NORMAL（游戏通常仍是 HIGH），不会反过来抢游戏的帧。
///
/// 具体动作：
///   - 宿主进程 CPU 优先级 ABOVE_NORMAL；
///   - 关闭宿主 EcoQoS（EXECUTION_SPEED / IGNORE_TIMER_RESOLUTION）；
///   - D3DKMTSetProcessSchedulingPriorityClass(ABOVE_NORMAL) 提升 GPU 队列优先级；
///   - timeBeginPeriod(1)：WPF 逐帧补间/歌词动画不再被 15.6ms 的默认定时器量化；
///   - 对 WebView2 的后代进程（browser / gpu / renderer）重复前三条。GPU 进程有独立的
///     调度上下文，只提宿主进程不够。
/// </summary>
internal static class ProcessScheduling
{
    private const uint ProcessSetInformation = 0x0200;
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const int AboveNormalPriorityClass = 0x00008000;
    private const uint Th32csSnapProcess = 0x00000002;
    private const int D3dKmtPriorityAboveNormal = 3;
    private const int ProcessPowerThrottlingClass = 4;
    private const uint PowerThrottlingCurrentVersion = 1;
    private const uint PowerThrottlingExecutionSpeed = 0x1;
    private const uint PowerThrottlingIgnoreTimerResolution = 0x4;

    private static readonly object Gate = new();
    private static readonly HashSet<string> Logged = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>已发现的 WebView2 后代。Chromium 会反复把 renderer 改回 NORMAL/IDLE，
    /// 所以这份名单不是「设一次就完」，而是每秒拿出来重新纠正一遍。</summary>
    private static readonly List<KnownProcess> Known = new();

    private static System.Threading.Timer? _watch;
    private static int _selfApplied;
    private static int _timerRaised;
    private static int _scanBusy;
    private static int _tick;
    private static int _corrections;

    private readonly record struct KnownProcess(uint Pid, string Name);

    /// <summary>进程启动时调用一次；之后由定时器跟进 WebView2 后建的 GPU/renderer 子进程。</summary>
    public static void Apply(string reason)
    {
        if (Interlocked.Exchange(ref _selfApplied, 1) == 0)
        {
            ApplyToCurrentProcess(reason);
        }

        lock (Gate)
        {
            // 固定 1s 一拍、永不停止：Chromium 有自己的可见性评估，会周期性把 renderer
            // 重新降成 NORMAL/IDLE（实测 5s 内就能降回去）。只设一次等于没设。
            _watch ??= new System.Threading.Timer(
                static _ => Tick(),
                null,
                dueTime: 1500,
                period: 1000);
        }
    }

    public static void Dispose()
    {
        lock (Gate)
        {
            _watch?.Dispose();
            _watch = null;
        }

        // 只回收自己抬过的 1ms 定时器精度，别把别的进程的全局状态改掉。
        if (Interlocked.Exchange(ref _timerRaised, 0) == 1)
        {
            try
            {
                TimeEndPeriod(1);
            }
            catch (Exception exception) when (exception is EntryPointNotFoundException or DllNotFoundException)
            {
                // winmm 在精简系统上不可用；没有副作用，忽略。
            }
        }
    }

    private static void ApplyToCurrentProcess(string reason)
    {
        var pid = (uint)Environment.ProcessId;
        var handle = OpenProcess(ProcessSetInformation | ProcessQueryLimitedInformation, false, pid);
        if (handle == IntPtr.Zero)
        {
            HostLog.Warn($"sched.self open failed pid={pid} win32={Marshal.GetLastWin32Error()}");
            return;
        }

        try
        {
            var cpu = SetPriorityClass(handle, AboveNormalPriorityClass);
            var eco = DisableEcoQos(handle);
            var gpu = TrySetGpuPriority(handle);
            var timer = RaiseTimerResolution();
            HostLog.Info($"sched.self reason={reason} cpu={cpu} eco={eco} gpu={gpu} timer1ms={timer}");
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    /// <summary>
    /// 1s 一拍。每 10 拍（10s）重新扫一次全系统进程表，把新起的 WebView2 子进程纳入名单；
    /// 其余拍只对已登记名单做纠正——快照要遍历几百个进程，纠正只需要几次系统调用。
    /// </summary>
    private static void Tick()
    {
        if (Interlocked.Exchange(ref _scanBusy, 1) == 1)
        {
            return;
        }

        try
        {
            var n = Interlocked.Increment(ref _tick);
            if (n == 1 || n % 10 == 0)
            {
                RefreshOwnedProcesses();
            }
            else
            {
                CorrectKnownProcesses();
            }
        }
        catch (Exception exception)
        {
            HostLog.Warn($"sched.tick failed: {exception.GetType().Name}: {exception.Message}");
        }
        finally
        {
            Interlocked.Exchange(ref _scanBusy, 0);
        }
    }

    /// <summary>重建「本进程树里的 WebView2 后代」名单。GPU 进程和 renderer 是渐次起的，
    /// WebView2 也会在页面重建时换掉 renderer，所以这份名单需要定期刷新。</summary>
    private static void RefreshOwnedProcesses()
    {
        var processes = SnapshotProcesses();
        if (processes.Count == 0)
        {
            return;
        }

        var children = new Dictionary<uint, List<uint>>(processes.Count);
        foreach (var (pid, info) in processes)
        {
            if (!children.TryGetValue(info.Parent, out var list))
            {
                children[info.Parent] = list = new List<uint>(4);
            }

            list.Add(pid);
        }

        var owned = new List<KnownProcess>(8);
        var self = (uint)Environment.ProcessId;
        var seen = new HashSet<uint> { self };
        var queue = new Queue<uint>();
        queue.Enqueue(self);
        while (queue.Count > 0)
        {
            var parent = queue.Dequeue();
            if (!children.TryGetValue(parent, out var list))
            {
                continue;
            }

            foreach (var child in list)
            {
                if (!seen.Add(child))
                {
                    continue;
                }

                queue.Enqueue(child);
                if (processes.TryGetValue(child, out var info) &&
                    info.Name.Contains("msedgewebview2", StringComparison.OrdinalIgnoreCase))
                {
                    owned.Add(new KnownProcess(child, info.Name));
                }
            }
        }

        lock (Gate)
        {
            Known.Clear();
            Known.AddRange(owned);
        }

        foreach (var item in owned)
        {
            LogDiscovery(item);
        }

        CorrectKnownProcesses();
    }

    /// <summary>
    /// 把名单里的进程再拉回 ABOVE_NORMAL / 非 EcoQoS / GPU 高优先级。
    /// 已经正确的进程不重复写优先级（只是读一次），但 EcoQoS 与 GPU 优先级每次重写，
    /// 因为它们的读回接口在新系统上不可靠，写的代价又只有一次内存写。
    /// </summary>
    private static void CorrectKnownProcesses()
    {
        KnownProcess[] snapshot;
        lock (Gate)
        {
            snapshot = Known.ToArray();
        }

        if (snapshot.Length == 0)
        {
            return;
        }

        var corrected = 0;
        foreach (var item in snapshot)
        {
            var handle = OpenProcess(
                ProcessSetInformation | ProcessQueryLimitedInformation,
                false,
                item.Pid);
            if (handle == IntPtr.Zero)
            {
                // 进程已退出（renderer 重建很常见）：从名单里摘掉，下一轮快照会补新的。
                Forget(item.Pid);
                continue;
            }

            try
            {
                if (GetPriorityClass(handle) != AboveNormalPriorityClass &&
                    SetPriorityClass(handle, AboveNormalPriorityClass))
                {
                    corrected += 1;
                }

                DisableEcoQos(handle);
                TrySetGpuPriority(handle);
            }
            finally
            {
                CloseHandle(handle);
            }
        }

        if (corrected == 0)
        {
            return;
        }

        var total = Interlocked.Add(ref _corrections, corrected);
        // 每纠满 100 次打一行：这行数字直接说明「Chromium 在反复降级，而我们在持续拉回」。
        if (total % 100 < corrected)
        {
            HostLog.Info($"sched.correct total={total} last={corrected} known={snapshot.Length}");
        }
    }

    private static void Forget(uint pid)
    {
        lock (Gate)
        {
            Known.RemoveAll(item => item.Pid == pid);
        }
    }

    private static void LogDiscovery(KnownProcess item)
    {
        var key = $"{item.Pid}:{item.Name}";
        lock (Gate)
        {
            if (!Logged.Add(key))
            {
                return;
            }
        }

        HostLog.Info($"sched.webview pid={item.Pid} exe={item.Name}");
    }

    private static bool DisableEcoQos(IntPtr handle)
    {
        var state = new ProcessPowerThrottlingState
        {
            Version = PowerThrottlingCurrentVersion,
            // ControlMask 声明「这两个开关由我控制」，StateMask 为 0 表示全部关闭。
            ControlMask = PowerThrottlingExecutionSpeed | PowerThrottlingIgnoreTimerResolution,
            StateMask = 0
        };
        return SetProcessInformation(
            handle,
            ProcessPowerThrottlingClass,
            ref state,
            (uint)Marshal.SizeOf<ProcessPowerThrottlingState>());
    }

    private static bool TrySetGpuPriority(IntPtr handle)
    {
        try
        {
            // 返回 NTSTATUS，0 才是成功；老系统没有这个导出，EntryPointNotFoundException 是正常情况。
            return D3DKMTSetProcessSchedulingPriorityClass(handle, D3dKmtPriorityAboveNormal) == 0;
        }
        catch (Exception exception) when (exception is EntryPointNotFoundException or DllNotFoundException)
        {
            return false;
        }
    }

    private static bool RaiseTimerResolution()
    {
        try
        {
            if (TimeBeginPeriod(1) != 0)
            {
                return false;
            }

            Interlocked.Exchange(ref _timerRaised, 1);
            return true;
        }
        catch (Exception exception) when (exception is EntryPointNotFoundException or DllNotFoundException)
        {
            return false;
        }
    }

    private static Dictionary<uint, ProcessInfo> SnapshotProcesses()
    {
        var result = new Dictionary<uint, ProcessInfo>(512);
        var snapshot = CreateToolhelp32Snapshot(Th32csSnapProcess, 0);
        if (snapshot == new IntPtr(-1))
        {
            return result;
        }

        try
        {
            var entry = new ProcessEntry32W { dwSize = (uint)Marshal.SizeOf<ProcessEntry32W>() };
            if (!Process32FirstW(snapshot, ref entry))
            {
                return result;
            }

            do
            {
                result[entry.th32ProcessID] = new ProcessInfo(entry.th32ParentProcessID, entry.szExeFile ?? string.Empty);
            }
            while (Process32NextW(snapshot, ref entry));
        }
        finally
        {
            CloseHandle(snapshot);
        }

        return result;
    }

    private readonly record struct ProcessInfo(uint Parent, string Name);

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessPowerThrottlingState
    {
        public uint Version;
        public uint ControlMask;
        public uint StateMask;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetPriorityClass(IntPtr hProcess, int dwPriorityClass);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int GetPriorityClass(IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetProcessInformation(
        IntPtr hProcess,
        int processInformationClass,
        ref ProcessPowerThrottlingState processInformation,
        uint processInformationSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool Process32FirstW(IntPtr hSnapshot, ref ProcessEntry32W lppe);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool Process32NextW(IntPtr hSnapshot, ref ProcessEntry32W lppe);

    [DllImport("gdi32.dll", SetLastError = true, ExactSpelling = true)]
    private static extern int D3DKMTSetProcessSchedulingPriorityClass(IntPtr hProcess, int priority);

    [DllImport("winmm.dll", EntryPoint = "timeBeginPeriod", SetLastError = true)]
    private static extern uint TimeBeginPeriod(uint uPeriod);

    [DllImport("winmm.dll", EntryPoint = "timeEndPeriod", SetLastError = true)]
    private static extern uint TimeEndPeriod(uint uPeriod);
}
