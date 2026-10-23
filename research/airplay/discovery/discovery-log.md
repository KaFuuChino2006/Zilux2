# Zilux2 AirPlay 设备发现 —— 真实网络实测日志

- 采集时间：2026-10-20 06:04:49 +08:00（Asia/Shanghai）
- 采集主机：小智（Windows，dotnet 10.0.12），网卡「以太网」192.168.31.41/24，ifIndex=6，默认网关 192.168.31.1
- 采集程序：`research/airplay/discovery/harness`（同一份 `src/Zilux2/AirPlay/Discovery/*.cs` 源码链接编译）
- 运行命令：`dotnet run -c Debug -- --discover 10`（10 秒真实发现 + Refresh() 立即重查 + 最终快照）
- 本次完整原始输出：`research/airplay/discovery/discovery-raw.log`（628 行，含每个响应报文的十六进制 dump）

## 1. 结果总览

发现 **3 台** AirPlay/RAOP 接收端，回调 3 次（回调 = 设备集合发生变化的次数），`IsRunning=False`（Stop 后状态正确）。

| # | 名称 | IPv4 | SRV 端口 | 服务 | MAC | 型号 | 版本 vs | vv | AirPlay2 | 需要密码 |
|---|------|------|---------|------|-----|------|---------|----|----------|----------|
| 1 | 白色pod | 192.168.31.183 | 7000 | raop + airplay | 82:18:BF:00:18:07 | AudioAccessory5,1 | 980.77.2 | 1 | 是 | 否 |
| 2 | 香风智乃的MacBook Pro | 192.168.31.233 | 7000 | raop + airplay | 2A:13:4A:E7:79:0D | MacBookPro18,3 | 980.77.5 | 0 | 是 | 否 |
| 3 | 黑色pod | 192.168.31.136 | 7000 | raop + airplay | 2A:F9:13:FA:95:56 | AudioAccessory5,1 | 980.77.2 | 1 | 是 | 否 |

两台 HomePod 的型号名为 `AudioAccessory5,1`（HomePod mini 一代/二代同型号 ID），`gpn=卧室` 是房间名；MacBook Pro 型号 `MacBookPro18,3`。

三台的 `_raop._tcp` 与 `_airplay._tcp` 都被发现，且成功归并为一台设备（`Host + 实例名/MAC` 归并，raop 记录优先）。三台的 RAOP SRV 端口均为 7000（不是传统 AirPort 的 5000）——HomePod 与新款 Mac 的 RAOP 服务也监听 7000。

### 关键 TXT（节选，完整见下文/原始日志）

白色pod（RAOP + AirPlay 两份）：
- RAOP：`cn=0,1,2,3` `da=true` `et=0,3,5` `ft=0x4A7FCA00,0x3C354BD0` `md=0,1,2` `am=AudioAccessory5,1` `pk=2d40…66dc` `tp=UDP` `vn=65537` `vs=980.77.2` `ov=27.0` `vv=1`
- AirPlay：`deviceid=82:18:BF:00:18:07` `model=AudioAccessory5,1` `srcvers=980.77.2` `vv=1` `flags=0xa2c04` `features=0x4A7FCA00,0x3C354BD0` `gpn=卧室` `protovers=1.1` `pi=50d72608-…` `psi=8118BF00-…` `gid=92478380-…` `tsid=…` `tsm=1` `fex=AMp/StBLNTwQoa7YDQ` `acl=0` `c=2` `cmv=2`
- `_device-info._tcp`：`model=B520AP`（HomePod mini 硬件型号，只作旁证，本模块不参与归并）

香风智乃的MacBook Pro：
- RAOP：`cn=0,1,2,3` `da=true` `et=0,3,5` `ft=0x4A7FCFD5,0x38174FDE` `md=0,1,2` `am=MacBookPro18,3` `pk=ce57…2004` `tp=UDP` `vn=65537` `vs=980.77.5` `vv=0`
- AirPlay：`deviceid=2A:13:4A:E7:79:0D` `model=MacBookPro18,3` `srcvers=980.77.5` `vv=0` `flags=0x204` `features=0x4A7FCFD5,0x38174FDE` `protovers=1.1` `rsf=0x8` `act=2` `at=4` `pi=00000000-0000-0000-0000-7022fe7ddb96`

黑色pod：
- RAOP：`cn=0,1,2,3` `et=0,3,5` `ft=0x4A7FCA00,0x3C356BD0` `md=0,1,2` `am=AudioAccessory5,1` `pk=a0dc…ef40` `vs=980.77.2` `vv=1`
- AirPlay：`deviceid=2A:F9:13:FA:95:56` `model=AudioAccessory5,1` `srcvers=980.77.2` `flags=0x280404` `gpn=卧室` `protovers=1.1`
- `_device-info._tcp`：`model=B520AP`

`SupportsAirPlay2` 判定：白色pod/黑色pod 有 `vv=1`；MacBook 无 vv（`vv=0`）但 `vs=980.77.5 ≥ 130`，因此也判为 AirPlay 2（macOS 自带的 AirPlay 接收端支持 AirPlay 2）。三台均无 `pw`，`IsPasswordProtected=false`。

## 2. 收发统计（本次 10 秒）

- 加入组播组：`224.0.0.251 @ 192.168.31.41（以太网）` + `ff02::fb @ 240e:3b1:c472:80d1::cd2`，打开 IPv4/IPv6 双栈 socket（`IPv4=True, IPv6=True`，接口=1 个活动网卡）。
- 发送查询：3 轮（启动时 1 轮 + 周期 5s 共 2 轮；另有 1 轮由 `Refresh()` 触发；日志中 3 条「已发送」为发送动作条数，目标接口数=2 = IPv4 一份 + IPv6 一份）。
- 收到响应：16 个报文，IPv4 8 个、IPv6 8 个（同一批设备在 v4/v6 各应答一次；也收到 `_device-info._tcp`、`_airplay`、`_raop` 的 PTR/SRV/TXT/A/AAAA/NSEC 记录）。
- 报文 flags 均为 `0x8400`（QR + AA），TTL=4500；各设备会周期性主动通告（响应不仅是查询后的应答）。

响应来源（IPv4，全部来自设备真实地址）：

```
192.168.31.136:5353 if=6 ipv6=False 网卡=以太网 an=3 ns=0 ar=11   ← 黑色pod
192.168.31.183:5353 if=6 ipv6=False 网卡=以太网                    ← 白色pod
192.168.31.233:5353 if=6 ipv6=False 网卡=以太网                    ← MacBook Pro
（对应 IPv6 链路本地/全局地址各 8 条，if=6 同网卡）
```

## 3. 典型响应报文（黑色pod，IPv4）

解析出的记录（`DescribeMessage` 输出，不含 hex）：

```
flags=0x8400 qd=0 an=3 ns=0 ar=11
RR PTR  _airplay._tcp.local  TTL=4500 -> 黑色pod._airplay._tcp.local
RR PTR  _raop._tcp.local     TTL=4500 -> 2AF913FA9556@黑色pod._raop._tcp.local
RR TXT  黑色pod._device-info._tcp.local TTL=4500 [model=B520AP]
RR TXT  黑色pod._airplay._tcp.local TTL=4500 [deviceid=2A:F9:13:FA:95:56, model=AudioAccessory5,1, srcvers=980.77.2, vv=1, flags=0x280404, features=0x4A7FCA00,0x3C354BD0, gpn=卧室, protovers=1.1, …]
RR TXT  2AF913FA9556@黑色pod._raop._tcp.local TTL=4500 [cn=0,1,2,3, et=0,3,5, ft=0x4A7FCA00,0x3C354BD0, sf=0x280404, md=0,1,2, am=AudioAccessory5,1, tp=UDP, vn=65537, vs=980.77.2, ov=27.0, vv=1]
RR SRV  黑色pod._airplay._tcp.local TTL=4500 heisepod.local:7000 (prio=0 weight=0)
RR SRV  2AF913FA9556@黑色pod._raop._tcp.local TTL=4500 heisepod.local:7000 (prio=0 weight=0)
RR Aaaa heisepod.local TTL=4500 fe80::c54:a657:ee6b:7db8
RR A    heisepod.local TTL=4500 192.168.31.136
RR Aaaa heisepod.local TTL=4500 240e:3b1:c472:80d1:cb0:a5ed:b255:d678
RR Aaaa heisepod.local TTL=4500 240e:3b1:c472:80d1::cb1
RR Nsec(47) 黑色pod._airplay._tcp.local TTL=4500 rdata=C02B00050000800040
```

原始字节（前 176 字节；名字压缩指针 `C0 0C`/`C0 15`/`C0 37`/`C0 2B` 明显可见，`2AF913FA9556@黑色pod` 是实例名）：

```
0000: 00 00 84 00 00 00 00 03 00 00 00 0B 08 5F 61 69  |............._ai|
0010: 72 70 6C 61 79 04 5F 74 63 70 05 6C 6F 63 61 6C  |rplay._tcp.local|
0020: 00 00 0C 00 01 00 00 11 94 00 0C 09 E9 BB 91 E8  |................|
0030: 89 B2 70 6F 64 C0 0C 05 5F 72 61 6F 70 C0 15 00  |..pod..._raop...|
0040: 0C 00 01 00 00 11 94 00 19 16 32 41 46 39 31 33  |..........2AF913|
0050: 46 41 39 35 35 36 40 E9 BB 91 E8 89 B2 70 6F 64  |FA9556@......pod|
0060: C0 37 09 E9 BB 91 E8 89 B2 70 6F 64 0C 5F 64 65  |.7.......pod._de|
0070: 76 69 63 65 2D 69 6E 66 6F C0 15 00 10 00 01 00  |vice-info.......|
0080: 00 11 94 00 0D 0C 6D 6F 64 65 6C 3D 42 35 32 30  |......model=B520|
0090: 41 50 C0 2B 00 10 80 01 00 00 11 94 01 FE 05 61  |AP.+...........a|
00A0: 63 6C 3D 30 18 62 74 61 64 64 72 3D 35 45 3A 42  |cl=0.btaddr=5E:B|
```

要点：
- 响应 **不含 Question 段**（QDCOUNT=0）；PTR 在 Answer 段，SRV/TXT/A/AAAA 在 Additional 段，NSEC(47) 是 mDNS 的否定缓存记录，解析器必须能跳过未知类型。
- 一条 PTR 记录里同时包含 airplay 与 raop 两类服务，说明单台设备一次通告就够归并。
- A 记录优先于 AAAA（模块选 IPv4 作为 `Host`，IPv6 只作旁证）；同一 host 有 3 条 AAAA（含 link-local 与两个全局/临时地址），模块按"同名多记录"去重并优先 A。

## 4. 自测（手工构造字节，非真实网络）

`dotnet run -c Debug -- --selftest` 全部通过，覆盖：
1. 查询报文构造（QDCOUNT、PTR/IN/QM、可被自身解析）；2. 响应解析（压缩指针、PTR/SRV/TXT/A/AAAA/NSEC、同名多 A、TXT 多条目）；3. raop+airplay 归并 + `AirPlayDeviceInfo` 映射（MAC 作 Id、端口优先 raop、Model/密码/AirPlay2 派生）；4. goodbye（TTL=0 删除 raop 后回落 airplay:7000，名称不变）；5. cache-flush（新 A 覆盖旧 IP）；6. TTL 过期后设备消失；7. TXT 派生助手（features 低 32 位在前、版本主号、MAC 归一化、raop 实例名拆分、pw、`md` 元数据类型 vs `model` 型号）；8. 畸形报文（越界指针/自指指针/截断报文不崩且不返回假数据）。

## 5. 已知坑（本次实测暴露）

1. **`md` 不是型号**：真实 RAOP TXT 的 `md=0,1,2` 表示"支持的元数据类型"（文本/封面/进度），型号在 AirPlay TXT 的 `model=`（HomePod mini=`AudioAccessory5,1`，MacBook=`MacBookPro18,3`）；RAOP 侧 `am=` 是型号名。最初实现误把 `md` 当 Model，导致三台设备显示 `Model=0,1,2` —— 已修：Model 取 `model` → `am` 兜底，`md` 单独暴露为 `MetadataTypes`（int 列表）。
2. **端口不是 5000**：三台设备 RAOP SRV 端口都是 7000，`Port` 按"raop 端口优先"取到 7000 是正确的（Host 集成时 RAOP RTSP 直连该端口）。
3. **同一设备双栈应答**：每台设备在 IPv4/IPv6 各产生一个报文，缓存层用 `(名称+记录数据)` 去重并刷新 TTL，否则设备列表会重复。
4. **mDNS 响应也可能来自本机**（本机装有 Apple Bonjour mDNSResponder 常驻 5353）：模块用"查询标志 + 源地址是否本机"过滤，避免自问自答。
5. **多网卡**：本机只有「以太网」处于 Up，WLAN/虚拟 WFP 适配器大量存在且 `GetIPv4Properties()` 会抛 `NetworkInformationException 10043`，接口枚举必须逐个 try/catch。
6. **IPv6 组播**：`ff02::fb` 的查询需要带 scope-id（接口 index），`IPV6_MULTICAST_IF` 传 int ifIndex；IPv4 的 `IP_MULTICAST_IF` 必须传 4 字节地址，传 `IPAddress` 对象会抛 ArgumentException。
7. **本机 5353 被占用**（msedge/steamwebhelper/mDNSResponder）：必须 `SO_REUSEADDR` 绑定 `0.0.0.0:5353`，不能独占。
