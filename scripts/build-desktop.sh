#!/bin/bash

# openAIDE IDE 桌面版构建脚本
# 基于 VSCodium 构建独立桌面应用
#
# 用法:
#   ./build-desktop.sh [平台]
#
# 平台选项:
#   macos     — macOS Universal Binary (.dmg)
#   windows   — Windows x64 (.exe NSIS 安装器)
#   linux     — Linux x64 (.deb + .rpm + .AppImage)
#   (不指定)  — 自动检测当前平台
#
# 前置条件:
#   - Node.js >= 20
#   - pnpm >= 9
#   - Python 3
#   - git
#   - macOS: Xcode Command Line Tools
#   - Windows: Visual Studio Build Tools
#   - Linux: build-essential, rpm, fakeroot
#
# 构建产物输出到: ./dist/

set -e

# 脚本位于 scripts/ 目录下，项目根目录为上一级
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IDE_BUILD_SCRIPT="$SCRIPT_DIR/packages/ide/build.sh"

# 检测当前平台
detect_platform() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux) echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) echo "linux" ;;
  esac
}

CURRENT_PLATFORM="$(detect_platform)"

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# 显示帮助
show_help() {
  echo ""
  echo "╔══════════════════════════════════════════╗"
  echo "║     openAIDE IDE — 桌面版构建工具              ║"
  echo "╚══════════════════════════════════════════╝"
  echo ""
  echo "用法: ./build-desktop.sh [选项]"
  echo ""
  echo "平台选项:"
  echo "  macos       构建 macOS 版本 (Universal Binary, .dmg)"
  echo "  windows     构建 Windows 版本 (x64, .exe)"
  echo "  linux       构建 Linux 版本 (x64, .deb/.rpm/.AppImage)"
  echo "  (不指定)    自动检测当前平台"
  echo ""
  echo "其他选项:"
  echo "  --help      显示此帮助信息"
  echo "  --check     仅检查构建依赖，不执行构建"
  echo "  --clean     清理构建缓存后重新构建"
  echo ""
  echo "构建产物输出到: ./dist/"
  echo ""
  echo "示例:"
  echo "  ./build-desktop.sh              # 自动检测平台并构建"
  echo "  ./build-desktop.sh macos        # 构建 macOS 版本"
  echo "  ./build-desktop.sh --check      # 检查依赖是否满足"
  echo "  ./build-desktop.sh --clean      # 清理缓存后构建"
  echo ""
}

# 检查依赖
check_deps() {
  info "检查构建依赖..."
  local all_ok=true

  # Node.js
  if command -v node &>/dev/null; then
    local node_ver
    node_ver=$(node -v)
    success "Node.js: $node_ver"
  else
    echo -e "  ${RED}✗${NC} Node.js 未安装 (需要 >= 20)"
    all_ok=false
  fi

  # pnpm
  if command -v pnpm &>/dev/null; then
    local pnpm_ver
    pnpm_ver=$(pnpm -v)
    success "pnpm: v$pnpm_ver"
  else
    echo -e "  ${RED}✗${NC} pnpm 未安装 (需要 >= 9)，运行: npm install -g pnpm"
    all_ok=false
  fi

  # Python 3
  if command -v python3 &>/dev/null; then
    local py_ver
    py_ver=$(python3 --version)
    success "Python: $py_ver"
  else
    echo -e "  ${RED}✗${NC} Python 3 未安装"
    all_ok=false
  fi

  # git
  if command -v git &>/dev/null; then
    local git_ver
    git_ver=$(git --version)
    success "Git: $git_ver"
  else
    echo -e "  ${RED}✗${NC} git 未安装"
    all_ok=false
  fi

  # jq (可选，用于修正 package.json)
  if command -v jq &>/dev/null; then
    success "jq: $(jq --version) (可选)"
  else
    warn "jq 未安装 (可选，建议安装以获得更好的构建体验)"
  fi

  # Rust (构建 CLI tunnel 需要)
  if command -v rustc &>/dev/null; then
    local rust_ver
    rust_ver=$(rustc --version)
    success "Rust: $rust_ver"
  else
    warn "Rust 未安装 (构建 CLI tunnel 需要)，运行: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  fi

  # 平台特定检查
  case "$CURRENT_PLATFORM" in
    macos)
      if xcode-select -p &>/dev/null; then
        success "Xcode Command Line Tools: 已安装"
      else
        echo -e "  ${RED}✗${NC} Xcode Command Line Tools 未安装，运行: xcode-select --install"
        all_ok=false
      fi
      ;;
    windows)
      # 检查 Visual Studio Build Tools
      if command -v cl.exe &>/dev/null || [ -n "${VSINSTALLDIR:-}" ] || [ -d "/c/Program Files/Microsoft Visual Studio" ] || [ -d "/c/Program Files (x86)/Microsoft Visual Studio" ]; then
        success "Visual Studio Build Tools: 已检测到"
      else
        echo -e "  ${RED}✗${NC} Visual Studio Build Tools 未安装"
        echo -e "      下载: https://visualstudio.microsoft.com/visual-cpp-build-tools/"
        echo -e "      安装时勾选 'Desktop development with C++'"
        all_ok=false
      fi
      # 检查 WiX Toolset (构建 MSI 安装器需要)
      if command -v candle.exe &>/dev/null || command -v wix &>/dev/null; then
        success "WiX Toolset: 已安装 (可选，用于构建 MSI)"
      else
        warn "WiX Toolset 未安装 (可选，用于构建 MSI 安装器)"
      fi
      # 检查 NSIS (构建 EXE 安装器需要)
      if command -v makensis &>/dev/null; then
        success "NSIS: 已安装"
      else
        warn "NSIS 未安装 (可选，用于构建 EXE 安装器)"
      fi
      ;;
    linux)
      if dpkg -l build-essential &>/dev/null 2>&1; then
        success "build-essential: 已安装"
      else
        warn "build-essential 可能未安装，运行: sudo apt-get install build-essential"
      fi
      ;;
  esac

  echo ""
  if [ "$all_ok" = true ]; then
    success "✅ 所有依赖检查通过！可以开始构建。"
  else
    error "❌ 部分依赖缺失，请先安装后再构建。"
  fi
}

# 清理构建缓存
clean_build() {
  info "清理构建缓存..."
  rm -rf "$SCRIPT_DIR/build/vscodium"
  rm -rf "$SCRIPT_DIR/dist"
  success "构建缓存已清理"
}

# ─── 主流程 ───

PLATFORM=""
CHECK_ONLY=false
DO_CLEAN=false

for arg in "$@"; do
  case $arg in
    --help|-h)
      show_help
      exit 0
      ;;
    --check)
      CHECK_ONLY=true
      ;;
    --clean)
      DO_CLEAN=true
      ;;
    macos|windows|linux)
      PLATFORM="$arg"
      ;;
    *)
      warn "未知参数: $arg"
      show_help
      exit 1
      ;;
  esac
done

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     openAIDE IDE — 桌面版构建工具              ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# 仅检查依赖
if [ "$CHECK_ONLY" = true ]; then
  check_deps
  exit 0
fi

# 清理
if [ "$DO_CLEAN" = true ]; then
  clean_build
fi

# 确保依赖已安装
cd "$SCRIPT_DIR"
if [ ! -d "node_modules" ]; then
  info "安装项目依赖..."
  pnpm install
fi

# 检查构建脚本是否存在
if [ ! -f "$IDE_BUILD_SCRIPT" ]; then
  error "构建脚本不存在: $IDE_BUILD_SCRIPT"
fi

# 如果 CI 传入了 VSCODE_ARCH 环境变量，导出给子脚本使用
if [ -n "${VSCODE_ARCH:-}" ]; then
  export VSCODE_ARCH
  info "使用指定架构: VSCODE_ARCH=$VSCODE_ARCH"
fi

# 执行构建
info "🚀 开始构建openAIDE IDE 桌面版..."
echo ""

if [ -n "$PLATFORM" ]; then
  bash "$IDE_BUILD_SCRIPT" "$PLATFORM"
else
  bash "$IDE_BUILD_SCRIPT"
fi

echo ""
success "🎉 构建完成！产物位于: $SCRIPT_DIR/dist/"
echo ""
echo "提示: 如果构建过程中遇到问题，可以运行以下命令排查:"
echo "  ./build-desktop.sh --check    # 检查依赖"
echo "  ./build-desktop.sh --clean    # 清理缓存后重试"
echo ""
