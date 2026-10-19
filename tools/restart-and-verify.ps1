# ---------------------------------------------------------------------------
# 未央观察站：一键重启并自我验证
#
# 为什么要做成"自我验证"：
#   之前反复出现"看起来重启了，其实旧进程还占着 8787 端口在跑"的情况，
#   而判断代码新旧的唯一权威依据是运行进程自己报告的 backend.codeVersion。
#   所以这个脚本在重启后会去 /api/state 读这个字段，和磁盘上 src\server.js
#   的实际大小/时间对比，直接打印 PASS 或 FAIL。不需要看任何日志文件。
#
# 用法（在本项目目录下右键"在终端中打开"，或 PowerShell 里 cd 过来）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\restart-and-verify.ps1
#
# 参数（一般不需要）：
#   -Port 8788   换端口，便于在不动正式后台的情况下试跑本脚本
#   -Root <路径> 指定项目根；默认按脚本位置推算，所以要把脚本复制出去跑时
#                必须显式传 -Root，否则会算错目录。
#   -Scan        额外触发一次扫描并打印 logs\scan.log（默认跳过，见第 7 步说明）
# ---------------------------------------------------------------------------
param(
  [int]$Port = 8787,
  [string]$Root = '',
  [switch]$Scan
)

$ErrorActionPreference = 'Stop'
# 默认：tools\ 的上一级就是项目根。复制到别处运行时靠 -Root 覆盖。
$root = if ($Root) { $Root } else { Split-Path -Parent $PSScriptRoot }
Set-Location -LiteralPath $root

$port = $Port
$serverFile = Join-Path $root 'src\server.js'
$scanLog = Join-Path $root 'logs\scan.log'

Write-Host ''
Write-Host '=== 1. 重启前：谁在监听 ' -NoNewline -ForegroundColor Cyan
Write-Host "$port" -NoNewline -ForegroundColor White
Write-Host ' ===' -ForegroundColor Cyan

$listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -eq 0) {
  Write-Host '  没有进程在监听。' -ForegroundColor Yellow
} else {
  foreach ($l in $listeners) {
    $proc = Get-Process -Id $l.OwningProcess -ErrorAction SilentlyContinue
    $started = if ($proc) { $proc.StartTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '未知' }
    Write-Host "  PID $($l.OwningProcess)  启动于 $started"
  }
}

Write-Host ''
Write-Host '=== 2. 停止旧进程 ===' -ForegroundColor Cyan
foreach ($l in $listeners) {
  try {
    Stop-Process -Id $l.OwningProcess -Force -ErrorAction Stop
    Write-Host "  已停止 PID $($l.OwningProcess)" -ForegroundColor Green
  } catch {
    Write-Host "  停止 PID $($l.OwningProcess) 失败：$($_.Exception.Message)" -ForegroundColor Red
  }
}

# 等端口真正释放，否则新进程会 EADDRINUSE 起不来。
Write-Host '  等待端口释放...' -NoNewline
$released = $false
for ($i = 0; $i -lt 30; $i += 1) {
  Start-Sleep -Milliseconds 500
  if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { $released = $true; break }
  Write-Host '.' -NoNewline
}
Write-Host ''
if ($released) { Write-Host '  端口已释放。' -ForegroundColor Green }
else { Write-Host '  端口仍被占用 —— 新进程可能起不来。' -ForegroundColor Yellow }

Write-Host ''
Write-Host '=== 3. 启动新后台 ===' -ForegroundColor Cyan
# 用 node 直接启动 src\server.js：绕开 npm / .cmd 包装层，
# 这样 stdout 会留在本窗口，同时新代码自己会把诊断写进 logs\scan.log。
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $portable = Join-Path $env:LOCALAPPDATA 'weiyang-node\node.exe'
  if (Test-Path -LiteralPath $portable) { $node = $portable }
}
if (-not $node) { throw '找不到 node.exe。请先安装 Node.js，或用 run-monitor.cmd 启动。' }
Write-Host "  使用 $node"

$outLog = Join-Path $root 'logs\console.log'
New-Item -ItemType Directory -Force -Path (Join-Path $root 'logs') | Out-Null
# 必须把端口通过环境变量传下去：src\server.js 读的是 process.env.PORT。
# 漏掉这步时，-Port 只影响本脚本的探测地址，新进程仍会去绑 8787，
# 然后发现"已有后台在跑"就直接退出 —— 看起来像启动失败，实际是测错了端口。
$env:PORT = "$port"
$proc = Start-Process -FilePath $node -ArgumentList 'src\server.js' -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError (Join-Path $root 'logs\console-err.log')
Write-Host "  已启动，PID $($proc.Id)" -ForegroundColor Green

Write-Host ''
Write-Host '=== 4. 等待服务就绪 ===' -ForegroundColor Cyan
$state = $null
for ($i = 0; $i -lt 40; $i += 1) {
  Start-Sleep -Seconds 1
  try {
    $state = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/state" -TimeoutSec 3
    break
  } catch { Write-Host '.' -NoNewline }
}
Write-Host ''

Write-Host ''
Write-Host '=== 5. 验证代码版本 ===' -ForegroundColor Cyan
$st = Get-Item -LiteralPath $serverFile
Write-Host "  磁盘 src\server.js : $($st.Length) 字节, 修改于 $($st.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ'))"

if (-not $state) {
  Write-Host ''
  Write-Host '  FAIL: 后台没有响应 /api/state。' -ForegroundColor Red
  foreach ($f in @('logs\console.log', 'logs\console-err.log')) {
    $p = Join-Path $root $f
    if (Test-Path -LiteralPath $p) {
      Write-Host "  --- $f 末尾 ---" -ForegroundColor Yellow
      Get-Content -LiteralPath $p -Encoding UTF8 -Tail 20 | ForEach-Object { Write-Host "    $_" }
    }
  }
  exit 1
}

$actual = $state.backend.codeVersion
Write-Host "  实际 codeVersion  : $actual"

# 比较规则：只比"字节数 + 修改时间"，且**时间允许 1 秒误差**。
#
# 为什么不做字符串全等：进程的指纹来自 Node 的 stat.mtime.toISOString()，
# 磁盘这边来自 PowerShell 的 LastWriteTimeUtc，两者对毫秒的舍入不一定一致
# （实测出现过 .221Z 与 .222Z）。字符串全等会把完全正确的重启误报成 FAIL ——
# 这个假 FAIL 真的踩到过，比没有验证更糟：会让人去追一个不存在的问题。
$expectedParts = "$($st.Length)@$($st.LastWriteTimeUtc.Ticks)"
$actualParts = $null
if ($actual -match '^(\d+)@(.+)$') {
  try {
    $actualParts = "$($matches[1])@$([datetime]::Parse($matches[2]).ToUniversalTime().Ticks)"
  } catch { $actualParts = $null }
}

Write-Host ''
if (-not $actual) {
  Write-Host '  FAIL —— 运行中的进程不报告 codeVersion，仍是旧代码。' -ForegroundColor Red
  Write-Host "         说明监听 $port 的是另一个进程（自启动遗留？）。" -ForegroundColor Yellow
} elseif ($actualParts -and $actualParts -eq $expectedParts) {
  Write-Host '  PASS —— 后台正在运行的就是磁盘上这份代码。' -ForegroundColor Green
} elseif ($actualParts) {
  $actualTicks = [long]($actualParts -split '@')[1]
  $expectedTicks = [long]($expectedParts -split '@')[1]
  $diffSeconds = [math]::Abs(($actualTicks - $expectedTicks) / 10000000)
  if ($diffSeconds -le 2) {
    Write-Host "  PASS —— 代码一致（时间差 $([math]::Round($diffSeconds,2)) 秒，属毫秒舍入误差）。" -ForegroundColor Green
  } else {
    Write-Host "  FAIL —— 运行中的代码与磁盘不一致（时间相差 $([math]::Round($diffSeconds,0)) 秒）。" -ForegroundColor Red
    Write-Host '         运行的可能是较早的版本，请确认没有第二个后台进程。' -ForegroundColor Yellow
  }
} else {
  Write-Host '  FAIL —— 无法解析 codeVersion，视为不一致。' -ForegroundColor Red
}

Write-Host ''
Write-Host '=== 6. 诊断文件 ===' -ForegroundColor Cyan
if (Test-Path -LiteralPath $scanLog) {
  Write-Host "  logs\scan.log 已生成：" -ForegroundColor Green
  # 必须显式 -Encoding UTF8：Node 写的是 UTF-8，而 PowerShell 5.1 的 Get-Content
  # 默认按本地 ANSI 代码页解码，中文会变成"鏈ぎ瑙傚療绔欏凡鍚姩"这种乱码，
  # 等于把最有用的诊断信息废掉（实测踩到过）。
  Get-Content -LiteralPath $scanLog -Encoding UTF8 -Tail 25 | ForEach-Object { Write-Host "    $_" }
} else {
  Write-Host '  logs\scan.log 尚未生成（新代码启动时就会写第一行，请稍等几秒后重看）。' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '=== 7. 触发一次扫描 ===' -ForegroundColor Cyan
if (-not $Scan) {
  # 默认不触发：扫描要驱动浏览器，正常约 40 秒，但若浏览器起不来会反复重试，
  # 能把脚本拖住好几分钟。重启本身已经会跑一次扫描，所以这里默认跳过。
  Write-Host '  已跳过（启动时已自动扫描过一次）。需要额外扫一次请加 -Scan 参数。' -ForegroundColor DarkGray
} else {
  try {
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/scan" -Method Post -TimeoutSec 120
    Write-Host '  扫描完成。' -ForegroundColor Green
  } catch {
    Write-Host "  扫描请求失败（不影响代码版本判定）：$($_.Exception.Message)" -ForegroundColor Yellow
  }
  if (Test-Path -LiteralPath $scanLog) {
    Write-Host ''
    Write-Host '  --- logs\scan.log 最新内容 ---' -ForegroundColor Yellow
    Get-Content -LiteralPath $scanLog -Encoding UTF8 -Tail 30 | ForEach-Object { Write-Host "    $_" }
  }
}
Write-Host ''
