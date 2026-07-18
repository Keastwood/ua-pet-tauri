param(
    [switch]$PullOnly
)

$ErrorActionPreference = "Stop"

$PetRepo = Split-Path -Parent $PSScriptRoot
$WorkspaceRoot = if ($env:DGATES_WORKSPACE) {
    $env:DGATES_WORKSPACE
} else {
    Split-Path -Parent $PetRepo
}

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )
    & git -C $Repository @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Git 命令失败：git -C `"$Repository`" $($Arguments -join ' ')"
    }
}

function Find-MonitorRepo {
    if ($env:DGATES_MONITOR_PATH) {
        return $env:DGATES_MONITOR_PATH
    }

    $Candidates = @(
        (Join-Path $WorkspaceRoot "ua-monitor"),
        (Join-Path $WorkspaceRoot "monitor"),
        (Join-Path $HOME "uatools\monitor"),
        (Join-Path $HOME "myprojs\ua-monitor")
    )
    foreach ($Candidate in $Candidates) {
        if (-not (Test-Path (Join-Path $Candidate ".git"))) {
            continue
        }
        $Remote = & git -C $Candidate remote get-url origin 2>$null
        if ($LASTEXITCODE -eq 0 -and $Remote -like "*Keastwood/ua-monitor.git*") {
            return $Candidate
        }
    }
    return (Join-Path $WorkspaceRoot "ua-monitor")
}

function Ensure-Repo {
    param(
        [string]$Path,
        [string]$Remote
    )
    if (Test-Path (Join-Path $Path ".git")) {
        return
    }
    if (Test-Path $Path) {
        throw "目录已存在但不是 Git 仓库：$Path"
    }
    Write-Host "首次使用，正在克隆 $Remote..."
    & git clone $Remote $Path
    if ($LASTEXITCODE -ne 0) {
        throw "克隆失败：$Remote"
    }
}

function Ensure-GitIdentity {
    param([string]$Path)
    $Name = & git -C $Path config user.name
    if (-not $Name) {
        Invoke-Git $Path config user.name "Codex Workspace Sync"
    }
    $Email = & git -C $Path config user.email
    if (-not $Email) {
        Invoke-Git $Path config user.email "codex-sync@local"
    }
}

function Sync-Repo {
    param(
        [string]$Label,
        [string]$Path
    )
    Write-Host ""
    Write-Host "[$Label] $Path"
    Invoke-Git $Path fetch --prune origin

    $Changes = & git -C $Path status --porcelain
    if ($LASTEXITCODE -ne 0) {
        throw "无法读取仓库状态：$Path"
    }
    if (-not $PullOnly -and $Changes) {
        Ensure-GitIdentity $Path
        Invoke-Git $Path add -A
        & git -C $Path diff --cached --quiet
        if ($LASTEXITCODE -ne 0) {
            $Device = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { [Environment]::MachineName }
            $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss K"
            Invoke-Git $Path commit -m "chore(sync): checkpoint from $Device at $Timestamp"
        }
    }

    $Branch = & git -C $Path branch --show-current
    if ($LASTEXITCODE -ne 0 -or -not $Branch) {
        throw "仓库当前不在普通分支上：$Path"
    }
    try {
        Invoke-Git $Path pull --rebase --autostash origin $Branch
    } catch {
        Write-Host ""
        Write-Host "同步在变基冲突处停止，没有覆盖文件。" -ForegroundColor Yellow
        Write-Host "请在 $Path 中解决冲突后运行：git rebase --continue"
        throw
    }

    if (-not $PullOnly) {
        Invoke-Git $Path push origin $Branch
    }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "没有找到 Git。请先安装 Git for Windows。"
}

$MonitorRepo = Find-MonitorRepo
Ensure-Repo $MonitorRepo "https://github.com/Keastwood/ua-monitor.git"
Ensure-Repo $PetRepo "https://github.com/Keastwood/ua-pet-tauri.git"

Sync-Repo "监控服务" $MonitorRepo
Sync-Repo "桌宠" $PetRepo

if ($PullOnly) {
    Write-Host "`n两个项目已下载到最新版本。"
} else {
    Write-Host "`n两个项目已完成双向同步。"
}
