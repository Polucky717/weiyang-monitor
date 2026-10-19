param(
  [int]$Port = 8787,
  [string]$Root = ''
)

# 重新登录：停后台 -> 打开浏览器登录 -> 保存会话 -> 重启后台 -> 验证。
#
# 为什么要写成一条命令：后台运行时浏览器配置目录被占用，直接 npm run login 会因为
# 配置被锁而失败；手动"关后台 -> 登录 -> 再开后台"容易漏步骤（忘了关后台就登录、
# 或登录后忘了重启）。所以这里把顺序固定下来，用户只需要双击一个入口。
#
# 关于等待：loginFlow 会打开可见窗口，等用户在窗口里完成登录后**回终端按 Enter**
# 才保存会话。本脚本用 Start-Process 直接跑 npm，控制台窗口会现出来，用户在那个
# 窗口里按 Enter 即可；这里同步等待该窗口退出。

$ErrorActionPreference = 'Continue'
$root = if ($Root) { $Root } else { Split-Path -Parent $PSScriptRoot }
Set-Location -LiteralPath $root

function Write-Section($text) {
  Write-Host ''
  Write-Host "=== $text ===" -ForegroundColor Cyan
}

Write-Host '未央观察站 —— 重新登录' -ForegroundColor White
Write-Host "项目目录：$root"

# ---------- 1. 停掉正在运行的后台 ----------
Write-Section '1. 停止正在运行的后台'
$stopped = 0
try {
  $listeners = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    $procId = $listener.OwningProcess
    if ($procId -and $procId -ne 0) {
      $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if ($proc) {
        Write-Host "  停止 PID=$procId ($($proc.ProcessName))"
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        $stopped += 1
      }
    }
  }
} catch {
  Write-Host "  （查询监听端口失败：$($_.Exception.Message)）" -ForegroundColor Yellow
}
if ($stopped -eq 0) { Write-Host '  没有发现占用该端口的后台。' }

# 等待端口真正释放：浏览器配置目录的锁要等进程彻底退出才会松开，
# 立刻启动登录会因为配置被占用而失败。
$released = $false
for ($i = 0; $i -lt 20; $i += 1) {
  Start-Sleep -Milliseconds 500
  $still = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if (-not $still) { $released = $true; break }
}
if ($released) { Write-Host '  端口已释放。' -ForegroundColor Green }
else { Write-Host '  端口仍被占用，登录可能因此失败。' -ForegroundColor Yellow }

# 再等一会，让残留的浏览器进程把配置目录真正放开。
Start-Sleep -Seconds 2

# ---------- 2. 登录 ----------
Write-Section '2. 打开浏览器登录'
Write-Host '  接下来会弹出一个浏览器窗口，请在里面完成未央雨课堂登录。' -ForegroundColor Yellow
Write-Host '  登录完成后，回到新出现的那个命令行窗口按 Enter 保存会话。' -ForegroundColor Yellow
Write-Host ''
Write-Host '  正在启动 ...' -ForegroundColor Gray

$npmCmd = 'npm.cmd'
$loginLog = Join-Path $root 'logs\relogin-console.log'
New-Item -ItemType Directory -Force -Path (Join-Path $root 'logs') | Out-Null
# 不加 -RedirectStandardOutput：需要让用户能看到"按 Enter"的提示并在那个窗口里操作。
# 用 -Wait 同步等待，登录窗口关闭后本脚本才继续。
try {
  $loginProc = Start-Process -FilePath $npmCmd -ArgumentList @('run', 'login') -WorkingDirectory $root -PassThru
  $loginProc.WaitForExit()
  $loginExit = $loginProc.ExitCode
} catch {
  Write-Host "  启动登录失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host '  请手动执行：npm run login' -ForegroundColor Yellow
  $loginExit = -1
}

if ($loginExit -eq 0) {
  Write-Host '  登录流程已结束。' -ForegroundColor Green
} else {
  Write-Host "  登录流程退出码=$loginExit，可能没有完成登录。" -ForegroundColor Yellow
}

$marker = Join-Path $root '.weiyang-login-complete'
if (Test-Path -LiteralPath $marker) {
  $saved = Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host "  会话标记时间：$($saved.completedAt)" -ForegroundColor Green
} else {
  Write-Host '  没有找到登录标记，登录可能没有完成。' -ForegroundColor Red
}

# ---------- 3. 重启后台 ----------
Write-Section '3. 重启后台'
$env:PORT = "$Port"
$outLog = Join-Path $root 'logs\console.log'
$errLog = Join-Path $root 'logs\console-err.log'
try {
  Start-Process -FilePath 'node' -ArgumentList @('src\server.js') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog | Out-Null
  Write-Host '  已启动 node src\server.js（窗口隐藏）'
} catch {
  Write-Host "  启动失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host '  请手动双击 restart-monitor.cmd' -ForegroundColor Yellow
  exit 1
}

# ---------- 4. 等它起来 ----------
Write-Section '4. 等待后台响应'
$state = $null
for ($i = 0; $i -lt 40; $i += 1) {
  Start-Sleep -Seconds 1
  try {
    $state = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -TimeoutSec 3
    Write-Host "  第 $($i + 1) 次探测：已响应" -ForegroundColor Green
    break
  } catch {
    Write-Host "  第 $($i + 1) 次探测：还没起来 ..." -ForegroundColor Gray
  }
}

if (-not $state) {
  Write-Host ''
  Write-Host '  FAIL：后台没有响应。' -ForegroundColor Red
  foreach ($f in @('logs\console.log', 'logs\console-err.log')) {
    $p = Join-Path $root $f
    if (Test-Path -LiteralPath $p) {
      Write-Host "  --- $f 末尾 ---" -ForegroundColor Yellow
      Get-Content -LiteralPath $p -Encoding UTF8 -Tail 20 | ForEach-Object { Write-Host "    $_" }
    }
  }
  exit 1
}

# ---------- 5. 验证登录是否真的生效 ----------
Write-Section '5. 验证登录态'
Write-Host "  后台状态   : $($state.backend.status)"
Write-Host "  需要登录   : $($state.backend.authRequired)"
Write-Host "  上次错误   : $($state.backend.error)"
Write-Host "  积分页板块 : $($state.points.Count) 个"
if ($state.points) {
  foreach ($p in $state.points) { Write-Host "      $($p.section)  $($p.current)/$($p.target)" }
}

Write-Host ''
Write-Host '  现在触发一次扫描，看接口是否还 401（最多等 90 秒）...' -ForegroundColor Gray
$scanError = $null
try {
  Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/scan" -Method Post -TimeoutSec 120 | Out-Null
} catch {
  $scanError = $_.Exception.Message
}
if ($scanError) { Write-Host "  扫描请求出错：$scanError" -ForegroundColor Yellow }

$scanLog = Join-Path $root 'logs\scan.log'
if (Test-Path -LiteralPath $scanLog) {
  $tail = Get-Content -LiteralPath $scanLog -Encoding UTF8 -Tail 25
  Write-Host ''
  Write-Host '  --- logs\scan.log 末尾 ---' -ForegroundColor Yellow
  foreach ($line in $tail) { Write-Host "    $line" }

  $loginGone = -not ($tail | Where-Object { $_ -match '没有登[录陆]' })
  $gotBoards = $tail | Where-Object { $_ -match '\[积分页\].*板块数=([1-9]\d*)' }
  Write-Host ''
  if ($gotBoards) {
    Write-Host '  PASS —— 积分页抓到板块数据了，登录已恢复正常。' -ForegroundColor Green
  } elseif ($loginGone) {
    Write-Host '  积分页这次没有报"您没有登陆"，但也没抓到板块，请把上面的日志发给开发者。' -ForegroundColor Yellow
  } else {
    Write-Host '  FAIL —— 接口仍然返回"您没有登陆"，登录可能没有真正保存成功。' -ForegroundColor Red
    Write-Host '  请确认在浏览器窗口里已经完成登录、并且回到命令行按了 Enter。' -ForegroundColor Yellow
  }
}

Write-Host ''
