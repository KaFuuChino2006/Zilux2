using System;
using AirPlayCryptoHarness;

// 测试向量入口：逐项运行并打印 PASS/FAIL；失败时返回非 0 退出码。
// 过滤：dotnet run --project research/airplay/crypto/harness -- <关键字>
var filter = args.Length > 0 ? args[0] : null;
var runner = new TestRunner();
Tests_Curve.Register(runner);
Tests_Misc.Register(runner);
// 后续模块的测试在各自 Tests_*.cs 里注册（TLV8/SRP/HAP 帧/RAOP AES 等）
Tests_Crypto.Register(runner);
var exitCode = runner.Run(filter);
return exitCode;
