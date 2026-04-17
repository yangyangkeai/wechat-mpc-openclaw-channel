# publish.ps1

Write-Host "检查 npm 登录状态..." -ForegroundColor Cyan
$npmUser = npm whoami 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "未检测到 npm 登录，请先登录..." -ForegroundColor Yellow
    npm login
    if ($LASTEXITCODE -ne 0) {
        Write-Host "npm 登录失败，退出发布！" -ForegroundColor Red
        Write-Host "按任意键退出..."
        $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
        exit $LASTEXITCODE
    }
} else {
    Write-Host "当前已登录 npm 用户: $npmUser" -ForegroundColor Green
}

Write-Host "开始构建项目..." -ForegroundColor Cyan
pnpm build

# 检查构建命令的退出状态码
if ($LASTEXITCODE -ne 0) {
    Write-Host "构建失败，取消发布！" -ForegroundColor Red
    Write-Host "按任意键退出..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit $LASTEXITCODE
}

Write-Host "正在发布包至 npm..." -ForegroundColor Cyan
npm publish --access public

# 检查发布命令的退出状态码
if ($LASTEXITCODE -ne 0) {
    Write-Host "发布失败！" -ForegroundColor Red
    Write-Host "按任意键退出..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit $LASTEXITCODE
}

Write-Host "发布成功！" -ForegroundColor Green
Write-Host "按任意键退出..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
