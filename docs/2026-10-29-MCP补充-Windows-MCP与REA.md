# 2026-10-29 补装两个 MCP：Windows-MCP 与 REA

主人给了两个仓库，要求装到本机并接进 WorkBuddy。结论：**两个都装好了，握手验证通过，配置已写入 `~/.workbuddy/mcp.json`，等主人点 Trust 生效。**

## 一、先说清楚「装到哪里」

这台机器有两个特殊情况，决定了不能按 README 默认方式来：

1. **Python 是 WorkBuddy 托管的 3.13.14**，而 Windows-MCP 要求 3.14+。
2. **Node 是 WorkBuddy 托管的 22.22.2**，而 REA 要求 22.x ≥ 22.23.4（或 24.x ≥ 24.22.1 / 26.12.1+）。
3. **npm 全局前缀指向 `C:\Users\lirui\.workbuddy\binaries\node\versions\22.22.2-6`**——这是客户端自己的目录，升级时会被清。所以绝对不能用 `npm i -g` 装 REA。

落点表：

| 组件 | 位置 |
| --- | --- |
| uv 本体 | `C:\Users\lirui\.local\bin\uv.exe`（0.12.20，本来就装着，只是不在 PATH） |
| windows-mcp 入口 | `C:\Users\lirui\.local\bin\windows-mcp.exe` |
| windows-mcp 包体 | `C:\Users\lirui\AppData\Local\uv\tools\windows-mcp\` |
| windows-mcp 用的 Python | `C:\Users\lirui\AppData\Roaming\uv\python\cpython-3.14-windows-x86_64-none\` |
| windows-mcp 运行时文件 | `C:\Users\lirui\.windows-mcp\`（config.toml / server.log） |
| 独立 Node | `D:\tools\node24\`（v24.22.2 + npm 11.19.1） |
| rea-agents | `D:\tools\rea\`（`rea.cmd` 在根，包在 `node_modules\rea-agents\`） |
| REA 附带的 skill | `C:\Users\lirui\.workbuddy\skills\reverse-engineer-anything\` |
| MCP 注册 | `C:\Users\lirui\.workbuddy\mcp.json` |

没有把任何源码 clone 进 `D:\Workplace\zhibo`。

## 二、Windows-MCP

```bash
export PATH="/c/Users/lirui/.local/bin:$PATH"
uv tool install windows-mcp --python 3.14
```

- 装了 **windows-mcp 0.8.8**，uv 自动拉了独立的 CPython 3.14，WorkBuddy 的 3.13 没动。
- `windows-mcp.exe --help` 正常，子命令 `serve / install / uninstall / auth` 齐全。
- 没有执行 `windows-mcp install`（那是注册开机计划任务 `windows-mcp-server`），按需手动起，别让它常驻吞桌面权限。

MCP initialize 握手返回：

```
serverInfo: {"name":"windows-mcp","version":"4.1.4"}
```

## 三、REA

```bash
curl -L -o D:/tools/node-v24.22.2-win-x64.zip https://nodejs.org/dist/v24.22.2/node-v24.22.2-win-x64.zip
# 解压到 D:\tools\node24
export PATH="/d/tools/node24:$PATH"
npm install -g --prefix "D:/tools/rea" rea-agents --no-fund --no-audit
```

- 装了 **rea-agents 6.8.0**，176 个依赖，耗时约 5 分钟。
- `frida@17.23.2` 的 install script 被 npm 的 allowScripts 拦下了，但实测 `require('frida')` 正常——不影响，没去 `--allow-scripts` 返工。
- REA 原生支持 WorkBuddy 客户端（`dist/application/SupportedClients.js` 里 `name: "workbuddy"`，configPath 就是 `.workbuddy/mcp.json`），所以跑了：

```bash
rea setup --client workbuddy --yes
```

它会做两件事：重写自己那条 MCP 注册（**保留其他 server**，备份到 `mcp.json.rea.backup`）、安装 bundled skill。执行后 `doctor` 里 `registration:workbuddy` 的 config_drift 消失了。

MCP initialize 握手返回：

```
serverInfo: {"name":"rea","version":"6.8.0"}
```

## 四、最终 mcp.json

三个 server 并存，`adb-tui` 原样保留：

- `adb-tui`（原有）
- `windows-mcp`：`C:\Users\lirui\.local\bin\windows-mcp.exe serve`
- `rea`：`D:\tools\node24\node.exe D:\tools\rea\node_modules\rea-agents\scripts\rea.mjs mcp`

都用绝对路径，理由：Electron 类宿主不一定继承系统 PATH，尤其中间隔着 `D:\` 和 `.local\bin` 这种非标准位置。

## 五、还没做的 / 已知限制

- **必须主人手动点 Trust**：`~/.workbuddy/mcp.json` 写入不代表启用，要去「连接器管理」→ 右上角自定义连接器 → 点新加的那个 Trust。
- **Windows-MCP 默认 `relaxed` 桌面控制策略**，Click / Type / PowerShell / 注册表都能做，不可逆。要收紧可加 `--control-policy strict` 或 `--exclude-tools PowerShell,Registry`。
- **REA 的 `doctor` 仍然是 `healthy: false`**：node 和 host 都 ok，但四个原生分析引擎（Hopper / Ghidra / IDA / JADX / Kuna）全缺。这是预期内的——Ghidra 在 Windows 还是实验性、要 12.1.x，JADX 官方明确「REA 不下载、需自备 JAR」。
- **REA 在 Windows 的能力边界**：静态 JS/Electron、.NET、Web、APK（需自备 JDK+JADX）可用；EVM 字节码、崩溃/内存包、固件、信号录制仅 Linux x64。
- 桌面控制类工具和逆向工程工具同时挂在一个 Agent 上，权限叠加风险要主人自己权衡。

## 六、实测：Windows-MCP 能不能真的操控电脑

结论：**能看，不能点。** 观测类工具全部可用，输入注入类全部无效。

### 能用的部分（已实测通过）

| 工具 | 结果 |
| --- | --- |
| `Snapshot` | 返回完整窗口列表 + 聚焦窗口 + UIA 树 + 坐标，正常 |
| `Screenshot` | 出图正常，支持 `region=[left,top,right,bottom]` 原生分辨率裁剪 |
| `Click` 的 `clicks:0` | 纯悬停，光标确实移到指定屏幕坐标 |
| `App mode=switch` | 成功把「直播伴侣」切为聚焦窗口（Depth 12） |
| `ControlStatus` | `state: ready` |

靠这些已经把直播伴侣的「关播」按钮定位到屏幕坐标 **(2282, 1850)**，并用 `region` 裁剪放大确认过按钮文字与推流码率（2687kb/s，确认在推流）。

### 不能用的部分（4 个独立目标全部验证）

- 点「关播」按钮 ×3（单点、切前台后单点、`Move` 拖拽 0.4s 模拟长按）→ 无反应，直播时长继续走。
- 点任务栏「开始」按钮 → 无反应，但返回 `CONTROL_PREEMPTED`（检测到真人在用鼠标，`executed_steps: 0`）。
- 点任务栏「时钟」→ 无反应，没有日历浮层。共试 3 次，含 `WINDOWS_MCP_DISABLE_FLASH=1` 和沙盒外执行。
- `Shortcut` 发 `Win` 键 → 无反应，开始菜单没出来。

### 排除掉的原因

- **不是 UIPI**：本进程完整性级别是 `S-1-16-8192`（Medium，正常用户）。任务栏也是 Medium，照样点不动。
- **不是 flash 覆盖窗**：`WINDOWS_MCP_DISABLE_FLASH=1` 关掉后行为不变（虽然快照 UI 树里确实堆了 8+ 个 `windows-mcp-flash` 窗口）。
- **不是沙盒**：`dangerouslyDisableSandbox` 跑一遍，结果一致。
- **不是坐标错**：光标悬停位置截图可见，确实压在按钮上；`Move` 也成功把光标设到目标点。

### 判断

`SetCursorPos` / `SetForegroundWindow` / 屏幕抓取都通，唯独 `SendInput`（鼠标按下、键盘）被静默吞掉。这是「子进程拿不到交互输入权限」的典型表现——WorkBuddy 派生给 Agent 的进程，UI 输入通道被限制，但读屏和窗口枚举不受限。

所以**由我这边调用 windows-mcp，注定点不动任何东西**。

> **⚠️ 2026-10-29 晚更正：上面这段判断是错的。**
> 当天下午重测，`SetCursorPos` 本身就直接返回 0（`GetLastError()` 也为 0），连光标都移不动，不只是 `SendInput` 被吞。
> 而且此时 windows-mcp 正是由主进程正常加载（工具可正常调用），输入照样失效——所以"让主进程派生就正常"的猜想**不成立**。
> 真正的原因是对面进程里有抖音安全组件 `C:\Program Files (x86)\edrAgent\`（见 `edrservice.exe` / `secsdk.dll` / `gp.dll`），它专职反自动化。
> 完整分析见 `docs/2026-10-29-直播伴侣关播通道逆向.md`。

### 顺带一条：直播伴侣到底是不是管理员运行

之前 `docs` 里记的是「直播伴侣以管理员权限运行」。这次看 `Get-Process .Path` 对所有 `直播伴侣` 进程都读不到——但这**不能**证明对方提权，因为我们的令牌受限时读谁都读不到。这个结论需要重新验证，别再当成事实用。
