# 安装指南

openAIDE IDE 支持 macOS、Windows 和 Linux 三大平台。

## 系统要求

| 平台 | 最低要求 |
|------|---------|
| **macOS** | macOS 10.15+ (Catalina)，Intel 或 Apple Silicon |
| **Windows** | Windows 10 1903+，64 位 |
| **Linux** | Ubuntu 20.04+ / Fedora 36+ / Arch Linux，64 位 |

**通用要求**：
- 内存：4 GB（推荐 8 GB+）
- 磁盘：500 MB 可用空间
- 网络：需要访问 LLM API（或使用本地模型）

## macOS

### DMG 安装

1. 从 [官网下载页](https://openaide.io/download) 下载 `.dmg` 文件
2. 双击打开 DMG
3. 将 **openAIDE** 拖入 **Applications** 文件夹
4. 首次打开时，右键点击应用 → 选择「打开」（绕过 Gatekeeper）

### Homebrew

```bash
brew install --cask openaide
```

### 命令行安装脚本

```bash
curl -fsSL https://openaide.io/install.sh | bash
```

安装完成后，`openaide` 命令会自动添加到 PATH。

## Windows

### EXE 安装器

1. 从 [官网下载页](https://openaide.io/download) 下载 `.exe` 安装器
2. 运行安装器，按提示完成安装
3. 安装器会自动：
   - 创建桌面快捷方式
   - 添加到开始菜单
   - 注册 `openaide` 命令到 PATH
   - 注册文件关联

### winget

```powershell
winget install OpenAIDE.IDE
```

### 便携版

下载 `.zip` 便携版，解压到任意目录即可使用，无需安装。

## Linux

### Debian / Ubuntu (.deb)

```bash
# 添加仓库
curl -fsSL https://openaide.io/gpg | sudo gpg --dearmor -o /usr/share/keyrings/openaide.gpg
echo "deb [signed-by=/usr/share/keyrings/openaide.gpg] https://openaide.io/apt stable main" | sudo tee /etc/apt/sources.list.d/openaide.list

# 安装
sudo apt update
sudo apt install openaide
```

### Fedora / RHEL (.rpm)

```bash
sudo dnf install https://openaide.io/download/latest/openaide.rpm
```

### Arch Linux

```bash
# AUR
yay -S openaide-ide

# 或使用 paru
paru -S openaide-ide
```

### AppImage

```bash
# 下载
wget https://openaide.io/download/latest/openaide.AppImage

# 添加执行权限
chmod +x openaide.AppImage

# 运行
./openaide.AppImage
```

## 从源码构建

如果你想从源码构建openAIDE IDE：

### 前置条件

- Node.js ≥ 20
- pnpm ≥ 9
- Python 3
- Git
- 平台原生构建工具（Xcode / Visual Studio / gcc）

### 构建步骤

```bash
# 克隆仓库
git clone https://github.com/nicepkg/openaide.git
cd openaide

# 安装依赖
pnpm install

# 构建核心引擎和扩展
pnpm build:core
pnpm build:extension

# 构建 IDE（首次约 30-60 分钟）
pnpm build:ide
```

构建产物输出到 `dist/` 目录。

## 更新

openAIDE内置自动更新机制：

1. 当有新版本时，状态栏会显示更新提示
2. 点击提示即可下载并安装更新
3. 更新完成后重启 IDE 即可

### 手动更新

```bash
# macOS (Homebrew)
brew upgrade openaide

# Linux (apt)
sudo apt update && sudo apt upgrade openaide

# Windows (winget)
winget upgrade OpenAIDE.IDE
```

## 卸载

::: code-group

```bash [macOS]
# Homebrew
brew uninstall openaide

# 手动
rm -rf /Applications/OpenAIDE.app
rm -rf ~/.openaide
```

```bash [Windows]
# 通过控制面板卸载，或
winget uninstall OpenAIDE.IDE

# 清理配置
rmdir /s %USERPROFILE%\.openaide
```

```bash [Linux]
# Debian/Ubuntu
sudo apt remove openaide

# Fedora
sudo dnf remove openaide

# 清理配置
rm -rf ~/.openaide
```

:::

## 故障排除

### macOS: "无法打开，因为无法验证开发者"

右键点击应用 → 选择「打开」→ 在弹出对话框中点击「打开」。

### Linux: 无法启动

确保安装了必要的依赖：

```bash
# Ubuntu/Debian
sudo apt install libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 libsecret-1-0
```

### 代理设置

如果你在代理环境下，配置 HTTP 代理：

```bash
export HTTP_PROXY=http://proxy:port
export HTTPS_PROXY=http://proxy:port
```

或在openAIDE设置中配置：`设置 → 代理 → HTTP Proxy`
