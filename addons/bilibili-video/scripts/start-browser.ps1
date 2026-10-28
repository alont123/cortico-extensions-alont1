# 用户显式从桌面运行；不改 Coo 配置、不提权、不删除目录。
[CmdletBinding()]
param([string]$DataDir = '', [string]$ExecutableFile = '',
  [ValidateRange(320, 7680)][int]$WindowWidth = 1280,
  [ValidateRange(200, 4320)][int]$WindowHeight = 720,
  [ValidateRange(1, 30)][int]$TimeoutSec = 20)

function Quote-Argument([string]$Value) {
  $builder = New-Object Text.StringBuilder
  [void]$builder.Append('"')
  $slashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') { $slashes++; continue }
    if ($character -eq '"') { [void]$builder.Append(('\' * ($slashes * 2 + 1))) }
    else { [void]$builder.Append(('\' * $slashes)) }
    $slashes = 0
    [void]$builder.Append($character)
  }
  [void]$builder.Append(('\' * ($slashes * 2)))
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Get-PlainDirectory([string]$Path, [switch]$Create) {
  if (Test-Path -LiteralPath $Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw '目录必须是普通文件夹，不能是链接或其他文件。请使用真实的数据目录。'
    }
  } elseif ($Create) { $item = New-Item -ItemType Directory -Path $Path -ErrorAction Stop }
  else { throw ('数据目录不存在：' + $Path) }
  return [IO.Path]::GetFullPath($item.FullName)
}

function Find-Browsers([string]$Configured) {
  if (-not [string]::IsNullOrWhiteSpace($Configured)) {
    $file = [IO.Path]::GetFullPath($Configured)
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw '指定的浏览器程序不存在。' }
    return @($file)
  }
  $candidates = @()
  $roots = @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:ProgramW6432, $env:LOCALAPPDATA) | Where-Object { $_ }
  foreach ($root in $roots) {
    foreach ($part in @('Microsoft\Edge', 'Google\Chrome', 'Microsoft\Edge Beta', 'Microsoft\Edge Dev', 'Google\Chrome Beta', 'Google\Chrome SxS', 'Chromium')) {
      $name = if ($part.StartsWith('Microsoft')) { 'msedge.exe' } else { 'chrome.exe' }
      $candidates += Join-Path $root ($part + '\Application\' + $name)
    }
  }
  foreach ($name in @('msedge.exe', 'chrome.exe', 'chromium.exe')) {
    $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue
    if ($command) { $candidates += @($command | ForEach-Object { $_.Source }) }
  }
  return @($candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -Unique)
}

function Read-Endpoint([string]$Profile, [int]$RequestTimeoutMs = 1000) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $file = Join-Path $Profile 'DevToolsActivePort'
  $stat = Get-Item -LiteralPath $file -Force -ErrorAction Stop
  if ($stat.PSIsContainer -or ($stat.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $stat.Length -gt 4096) {
    throw 'DevToolsActivePort 不是安全的小型常规文件。'
  }
  $lines = @([IO.File]::ReadAllLines($file))
  if ($lines.Count -lt 2 -or $lines[0] -notmatch '^\d{1,5}$' -or $lines[1] -notmatch '^/devtools/browser/[A-Za-z0-9_-]+$') { throw 'DevToolsActivePort 格式无效。' }
  $port = [int]$lines[0]
  if ($port -lt 1 -or $port -gt 65535) { throw '调试端口超出范围。' }
  $request = [Net.HttpWebRequest]::Create('http://127.0.0.1:' + $port + '/json/version')
  $request.Proxy = $null
  $request.AllowAutoRedirect = $false
  $request.Timeout = [Math]::Max(1, $RequestTimeoutMs)
  $request.ReadWriteTimeout = $request.Timeout
  $response = $null; $stream = $null
  $buffer = New-Object IO.MemoryStream
  try {
    $response = $request.GetResponse()
    if ([int]$response.StatusCode -ne 200) { throw ('调试端点 HTTP ' + [int]$response.StatusCode) }
    $stream = $response.GetResponseStream()
    $chunk = New-Object byte[] 4096
    while ($true) {
      $remaining = $RequestTimeoutMs - $watch.ElapsedMilliseconds
      if ($remaining -le 0) { throw '调试端点响应超时。' }
      if ($stream.CanTimeout) { $stream.ReadTimeout = [int]$remaining }
      $count = $stream.Read($chunk, 0, $chunk.Length)
      if ($count -le 0) { break }
      if ($buffer.Length + $count -gt 65536) { throw '调试端点响应超过 64 KiB。' }
      $buffer.Write($chunk, 0, $count)
    }
    $version = [Text.Encoding]::UTF8.GetString($buffer.ToArray()) | ConvertFrom-Json -ErrorAction Stop
    if (-not $version -or $version.Browser -notmatch 'Chrome|Chromium|Edg' -or -not $version.webSocketDebuggerUrl) { throw '端口不是可用的 Chrome/Edge 调试服务。' }
    $ws = [Uri]$version.webSocketDebuggerUrl
    if ($ws.Scheme -ne 'ws' -or $ws.Host -notin @('127.0.0.1', 'localhost', '[::1]', '::1') -or $ws.UserInfo -or $ws.Query -or $ws.Fragment) { throw '调试 WebSocket 必须是无凭据的本机地址。' }
    if ($ws.Port -ne $port -or $ws.AbsolutePath -cne $lines[1]) { throw 'HTTP WebSocket 与 DAP 的端口/路径不对应。' }
    return [pscustomobject]@{ Port = $port; WebSocket = $ws.AbsoluteUri; Browser = [string]$version.Browser }
  } finally {
    if ($stream) { $stream.Dispose() }; if ($response) { $response.Dispose() }
    $buffer.Dispose(); $request.Abort()
  }
}

function Wait-Endpoint([string]$Profile, [int]$TimeoutMs) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $lastError = '尚未读取到 DevToolsActivePort'
  do {
    try { return Read-Endpoint $Profile ([Math]::Min(1000, [Math]::Max(1, $TimeoutMs - $watch.ElapsedMilliseconds))) }
    catch { $lastError = $_.Exception.Message }
    $left = $TimeoutMs - $watch.ElapsedMilliseconds
    if ($left -gt 0) { Start-Sleep -Milliseconds ([Math]::Min(100, $left)) }
  } while ($watch.ElapsedMilliseconds -lt $TimeoutMs)
  throw ('端口未就绪或健康检查失败：' + $lastError)
}

function Invoke-BrowserHelper {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$DataDir, [string]$ExecutableFile = '',
    [ValidateRange(320, 7680)][int]$WindowWidth = 1280,
    [ValidateRange(200, 4320)][int]$WindowHeight = 720,
    [ValidateRange(1, 30)][int]$TimeoutSec = 20)
  if ([string]::IsNullOrWhiteSpace($DataDir)) { throw '请明确指定 Coo 部署的数据目录。' }
  $dataRoot = Get-PlainDirectory ([IO.Path]::GetFullPath($DataDir))
  $browsers = @(Find-Browsers $ExecutableFile)
  if ($browsers.Count -eq 0) { throw '没找到 Chrome/Edge，请用 -ExecutableFile 指定完整程序路径。' }
  $pluginRoot = Get-PlainDirectory (Join-Path $dataRoot 'bilibili-video') -Create
  $root = Get-PlainDirectory (Join-Path $pluginRoot 'external-browser') -Create
  $watch = [Diagnostics.Stopwatch]::StartNew(); $lastError = ''
  foreach ($browser in $browsers) {
    if ($watch.ElapsedMilliseconds -ge $TimeoutSec * 1000) { break }
    $token = [guid]::NewGuid().ToString('N')
    $profile = Get-PlainDirectory (Join-Path $root ('browser-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $token)) -Create
    $marker = @{ schema = 1; owner = 'cortico-world-bilibili-video-alont1:external-v1'; token = $token; root = $root; name = (Split-Path $profile -Leaf); createdAt = [DateTime]::UtcNow.ToString('o') }
    [IO.File]::WriteAllText((Join-Path $profile '.cortico-external-browser.json'), ($marker | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
    $arguments = @('--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', ('--user-data-dir=' + $profile),
      '--no-first-run', '--no-default-browser-check', '--disable-infobars', '--hide-crash-restore-bubble',
      ('--window-size=' + $WindowWidth + ',' + $WindowHeight), '--autoplay-policy=no-user-gesture-required', '--disable-features=Translate',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', 'about:blank')
    try {
      Write-Host ('尝试浏览器：' + $browser)
      $child = Start-Process -FilePath $browser -ArgumentList (($arguments | ForEach-Object { Quote-Argument $_ }) -join ' ') -WindowStyle Normal -PassThru -ErrorAction Stop
      $endpoint = Wait-Endpoint $profile ([Math]::Min(8000, [Math]::Max(1, $TimeoutSec * 1000 - $watch.ElapsedMilliseconds)))
      $connection = [ordered]@{ schema = 1; token = $token; cdpUrl = ('http://127.0.0.1:' + $endpoint.Port); websocket = $endpoint.WebSocket;
        browser = $endpoint.Browser; executable = $browser; profile = $profile; dataDir = $dataRoot; launcherPid = $child.Id; createdAt = [DateTime]::UtcNow.ToString('o') }
      $connectionFile = Join-Path $pluginRoot 'external-browser-connection.json'
      if (Test-Path -LiteralPath $connectionFile) {
        $existing = Get-Item -LiteralPath $connectionFile -Force
        if ($existing.PSIsContainer -or ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '连接记录不能是链接或目录。' }
      }
      $temporaryFile = Join-Path $pluginRoot ('.external-browser-connection-' + $token + '.tmp')
      foreach ($target in @($temporaryFile, $connectionFile)) {
        if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($target)) -ne $pluginRoot) { throw '连接记录路径超出专用目录。' }
      }
      [IO.File]::WriteAllText($temporaryFile, ($connection | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
      # ReplaceFile preserves the previous record if replacement fails; Move-Item -Force deletes it first.
      if (Test-Path -LiteralPath $connectionFile) {
        # PowerShell 5.1 binds $null to an empty string for this overload; use a true null backup path.
        [IO.File]::Replace($temporaryFile, $connectionFile, [NullString]::Value)
      } else {
        [IO.File]::Move($temporaryFile, $connectionFile)
      }
      return [pscustomobject]$connection
    } catch { $lastError = $_.Exception.Message; Write-Warning ('本次未就绪；资料目录保留：' + $profile) }
  }
  throw ('浏览器未就绪：' + $lastError + '。没有修改 Coo 配置或删除目录；已出现的专用窗口请自行关闭。')
}

# Dot-sourcing loads functions without starting a browser, for isolated tests.
if ($MyInvocation.InvocationName -ne '.') {
  $ErrorActionPreference = 'Stop'
  try {
    if ([string]::IsNullOrWhiteSpace($DataDir)) { $DataDir = Read-Host '请输入 Coo 部署的 data 目录（不是程序安装目录）' }
    $connection = Invoke-BrowserHelper -DataDir $DataDir -ExecutableFile $ExecutableFile -WindowWidth $WindowWidth -WindowHeight $WindowHeight -TimeoutSec $TimeoutSec
    Write-Host ('cdpUrl = ' + $connection.cdpUrl)
    Write-Host ('连接记录 = ' + (Join-Path $connection.dataDir 'bilibili-video\external-browser-connection.json'))
    Write-Host '把 cdpUrl 填入 B 站视频「配置→接管已开的浏览器」，再点「打开浏览器」。'
    Write-Host '此窗口归你控制；关闭插件只关插件的新标签页。重跑 helper 后请更新端口。'
    exit 0
  } catch {
    [Console]::Error.WriteLine('启动失败：' + $_.Exception.Message)
    [Console]::Error.WriteLine('没有自动修改配置、删除目录或更改安全策略。请检查程序路径、权限和专用浏览器窗口。')
    exit 1
  }
}
