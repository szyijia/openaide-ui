#!/usr/bin/env bash
#
# OpenAIDE IDE — VSCodium 构建脚本
#
# 用法:
#   ./build.sh [platform]
#
# 平台:
#   macos   — macOS (Universal Binary, .dmg)
#   windows — Windows (x64, .exe NSIS 安装器)
#   linux   — Linux (x64, .deb + .rpm + .AppImage)
#   all     — 所有平台
#
# 前置条件:
#   - Node.js >= 20
#   - pnpm >= 9
#   - Python 3 (VSCodium 构建依赖)
#   - macOS: Xcode Command Line Tools
#   - Windows: Visual Studio Build Tools
#   - Linux: build-essential, rpm, fakeroot
#

set -euo pipefail

# GitHub Token — 用于避免 GitHub API 限流 (403)
# 构建过程中需要从 GitHub 下载扩展，未认证请求限额仅 60 次/小时
# 请通过环境变量传入，不要在脚本里硬编码：
#   export GITHUB_TOKEN=ghp_xxxxx && ./build.sh
export GITHUB_TOKEN="${GITHUB_TOKEN:-}"
if [ -z "${GITHUB_TOKEN}" ]; then
  echo "[warn] GITHUB_TOKEN is empty — GitHub API rate limit (60/hr) may be hit during build" >&2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
IDE_DIR="$SCRIPT_DIR"
BUILD_DIR="$ROOT_DIR/build"
VSCODIUM_DIR="$BUILD_DIR/vscodium"
VSCODIUM_REPO="https://github.com/VSCodium/vscodium.git"
VSCODIUM_TAG="1.99.32846"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ─── 步骤 1: 检查依赖 ───

check_dependencies() {
  log_info "检查构建依赖..."

  local missing=()

  command -v node >/dev/null 2>&1 || missing+=("node")
  command -v pnpm >/dev/null 2>&1 || missing+=("pnpm")
  # Windows 上 Python 3 可能叫 python 而非 python3
  if ! command -v python3 >/dev/null 2>&1; then
    if command -v python >/dev/null 2>&1 && python --version 2>&1 | grep -q "Python 3"; then
      log_info "检测到 python (Python 3)，创建 python3 别名"
    else
      missing+=("python3")
    fi
  fi
  command -v git >/dev/null 2>&1 || missing+=("git")

  if [ ${#missing[@]} -gt 0 ]; then
    log_error "缺少以下依赖: ${missing[*]}"
    exit 1
  fi

  log_success "依赖检查通过"
}

# ─── 步骤 2: 克隆 VSCodium ───

clone_vscodium() {
  if [ -d "$VSCODIUM_DIR" ]; then
    log_info "VSCodium 源码已存在，跳过克隆"
    return
  fi

  log_info "克隆 VSCodium ($VSCODIUM_TAG)..."
  mkdir -p "$BUILD_DIR"
  git clone --depth 1 --branch "$VSCODIUM_TAG" "$VSCODIUM_REPO" "$VSCODIUM_DIR"
  log_success "VSCodium 克隆完成"
}

# ─── 步骤 3: 获取 VS Code 源码 ───

fetch_vscode() {
  log_info "获取 VS Code 源码..."

  cd "$VSCODIUM_DIR"

  # 设置 VSCodium 构建所需的环境变量
  export VSCODE_QUALITY="stable"
  export CI_BUILD="no"

  # 运行 VSCodium 的 get_repo.sh 来克隆 VS Code 源码
  if [ ! -d "$VSCODIUM_DIR/vscode" ]; then
    bash get_repo.sh
    log_success "VS Code 源码获取完成"
  else
    log_info "VS Code 源码已存在，重置到干净状态..."
    cd "$VSCODIUM_DIR/vscode"
    git checkout -- .
    git clean -fd --exclude='.build' --exclude='node_modules'
    cd "$VSCODIUM_DIR"
    log_success "VS Code 源码已重置"
  fi

  cd "$ROOT_DIR"
}

# ─── 步骤 4: 应用品牌定制 ───

apply_branding() {
  log_info "应用OpenAIDE品牌定制..."

  # 覆盖 VSCodium 的 product.json（在 prepare_vscode.sh 之前）
  cp "$IDE_DIR/product.json" "$VSCODIUM_DIR/product.json"

  # 复制图标资源到 VSCodium 的 src/stable 目录（prepare_vscode.sh 会将其复制到 vscode/）
  local stable_resources="$VSCODIUM_DIR/src/stable/resources"
  if [ -d "$stable_resources" ]; then
    # 替换主图标 SVG
    if [ -f "$IDE_DIR/resources/icon.svg" ]; then
      cp "$IDE_DIR/resources/icon.svg" "$stable_resources/icon.svg"
      log_info "已替换 icon.svg"
    fi
    # 替换 macOS 应用图标 (.icns)
    if [ -f "$IDE_DIR/resources/darwin/code.icns" ]; then
      cp "$IDE_DIR/resources/darwin/code.icns" "$stable_resources/darwin/code.icns"
      log_info "已替换 macOS 应用图标 (code.icns)"
    fi
    # 替换 Linux 图标
    if [ -f "$IDE_DIR/resources/linux/code.png" ]; then
      cp "$IDE_DIR/resources/linux/code.png" "$stable_resources/linux/code.png"
      log_info "已替换 Linux PNG 图标"
    fi
    if [ -f "$IDE_DIR/resources/linux/code.svg" ]; then
      cp "$IDE_DIR/resources/linux/code.svg" "$stable_resources/linux/code.svg"
      log_info "已替换 Linux SVG 图标"
    fi
    # 替换 Windows 图标 (.ico, .png, .bmp)
    if [ -d "$IDE_DIR/resources/win32" ]; then
      for f in "$IDE_DIR/resources/win32"/*; do
        local fname=$(basename "$f")
        cp "$f" "$stable_resources/win32/$fname" 2>/dev/null || true
      done
      log_info "已替换 Windows 图标资源"
    fi
  fi

  # 如果 vscode/ 目录已存在，也直接复制图标到其中（确保覆盖）
  if [ -d "$VSCODIUM_DIR/vscode" ]; then
    # 替换 vscode/resources 下的图标
    if [ -f "$IDE_DIR/resources/darwin/code.icns" ]; then
      cp "$IDE_DIR/resources/darwin/code.icns" "$VSCODIUM_DIR/vscode/resources/darwin/code.icns" 2>/dev/null || true
    fi
    if [ -f "$IDE_DIR/resources/linux/code.png" ]; then
      cp "$IDE_DIR/resources/linux/code.png" "$VSCODIUM_DIR/vscode/resources/linux/code.png" 2>/dev/null || true
    fi
    if [ -f "$IDE_DIR/resources/linux/code.svg" ]; then
      cp "$IDE_DIR/resources/linux/code.svg" "$VSCODIUM_DIR/vscode/resources/linux/code.svg" 2>/dev/null || true
    fi
    # 替换 vscode/resources/win32 下的图标
    if [ -d "$IDE_DIR/resources/win32" ]; then
      for f in "$IDE_DIR/resources/win32"/*; do
        local fname=$(basename "$f")
        cp "$f" "$VSCODIUM_DIR/vscode/resources/win32/$fname" 2>/dev/null || true
      done
    fi
    # 复制到 workbench media 目录
    local vscode_media="$VSCODIUM_DIR/vscode/src/vs/workbench/browser/media"
    mkdir -p "$vscode_media"
    if [ -f "$IDE_DIR/resources/icon.svg" ]; then
      cp "$IDE_DIR/resources/icon.svg" "$vscode_media/openaide-icon.svg"
    fi
  fi

  # 复制自定义补丁到 VSCodium 的 patches/user/ 目录
  # prepare_vscode.sh 会在应用完 VSCodium 自带补丁后，自动应用 patches/user/ 下的补丁
  if [ -d "$IDE_DIR/patches" ]; then
    mkdir -p "$VSCODIUM_DIR/patches/user"
    for patch in "$IDE_DIR/patches"/*.patch; do
      if [ -f "$patch" ]; then
        log_info "复制用户补丁到 VSCodium: $(basename "$patch")"
        cp "$patch" "$VSCODIUM_DIR/patches/user/"
      fi
    done
  fi

  log_success "品牌定制完成"
}

# ─── 步骤 5: 构建 Extension ───

build_extension() {
  log_info "构建OpenAIDE Extension..."

  # 构建 ts-code（独立项目，TypeScript 编译 + esbuild 打包为单文件 bundle）
  local ts_code_dir="$ROOT_DIR/../ts-code"
  (cd "$ts_code_dir" && pnpm install && pnpm build)
  (cd "$ts_code_dir" && pnpm bundle)

  # 构建 Extension
  (cd "$ROOT_DIR" && pnpm --filter @openaide/extension build)

  # 将 Extension 复制到 VSCodium 的 vscode/extensions/ 目录（作为内置扩展）
  local ext_dir="$VSCODIUM_DIR/vscode/extensions/openaide-ai"
  mkdir -p "$ext_dir/dist"
  cp -r "$ROOT_DIR/packages/extension/dist" "$ext_dir/"
  cp "$ROOT_DIR/packages/extension/package.json" "$ext_dir/"

  # 复制 Agent Core bundle（Extension 通过 fork() 启动此文件作为子进程）
  cp "$ts_code_dir/dist/bridge-server.bundle.cjs" "$ext_dir/dist/"
  log_info "已复制 Agent Core bundle 到扩展目录"

  # 修正 package.json 中的扩展名称和依赖（VS Code 不支持 npm scope 格式和 workspace 依赖）
  if command -v jq >/dev/null 2>&1; then
    local tmp_json
    tmp_json=$(jq '.name = "openaide-ai" | del(.dependencies) | del(.devDependencies)' "$ext_dir/package.json")
    echo "$tmp_json" > "$ext_dir/package.json"
    log_info "已修正扩展 package.json（名称 + 移除 workspace 依赖）"
  else
    # 没有 jq 时用 sed 替换（兼容 macOS/Linux/Windows Git Bash）
    if [[ "$(uname -s)" == "Darwin" ]]; then
      sed -i '' 's/"name": "@openaide\/extension"/"name": "openaide-ai"/' "$ext_dir/package.json"
    else
      sed -i 's/"name": "@openaide\/extension"/"name": "openaide-ai"/' "$ext_dir/package.json"
    fi
  fi

  log_success "Extension 构建完成"
}

# ─── 步骤 6: 构建 IDE ───

build_ide() {
  local platform="${1:-$(detect_platform)}"

  log_info "构建OpenAIDE IDE (平台: $platform)..."

  cd "$VSCODIUM_DIR"

  # 设置 VSCodium 构建所需的公共环境变量
  export SHOULD_BUILD=yes
  export VSCODE_QUALITY="stable"
  export CI_BUILD="no"
  export SHOULD_BUILD_REH="no"
  export SHOULD_BUILD_REH_WEB="no"

  # 设置 RELEASE_VERSION（VSCodium 构建流程必需）
  # prepare_vscode.sh 会将此版本号写入 vscode/package.json 的 version 字段
  # Windows 构建时 rcedit 需要有效的版本号来设置 FileVersion
  export RELEASE_VERSION="${VSCODIUM_TAG}"
  log_info "RELEASE_VERSION=$RELEASE_VERSION"

  case "$platform" in
    macos)
      # macOS 不支持直接构建 universal，需按实际架构构建（x64 或 arm64）
      if [[ "$(uname -m)" == "arm64" ]]; then
        export VSCODE_ARCH=arm64
      else
        export VSCODE_ARCH=x64
      fi
      export OS_NAME=osx
      ;;
    windows)
      # 支持从环境变量接收架构（CI 可传入 arm64）
      export VSCODE_ARCH="${VSCODE_ARCH:-x64}"
      export OS_NAME=windows
      ;;
    linux)
      export VSCODE_ARCH="${VSCODE_ARCH:-x64}"
      export OS_NAME=linux
      ;;
    *)
      log_error "不支持的平台: $platform"
      exit 1
      ;;
  esac

  log_info "环境变量: OS_NAME=$OS_NAME, VSCODE_ARCH=$VSCODE_ARCH, VSCODE_QUALITY=$VSCODE_QUALITY"

  # 执行 VSCodium 的构建脚本
  bash build.sh

  log_success "IDE 构建完成"

  cd "$ROOT_DIR"

  # 复制产物
  copy_artifacts "$platform"
}

# ─── 步骤 7: 复制构建产物 ───

copy_artifacts() {
  local platform="$1"
  local output_dir="$ROOT_DIR/dist"
  mkdir -p "$output_dir"

  log_info "复制构建产物到 $output_dir..."

  case "$platform" in
    macos)
      # 复制 .app 目录（构建产物在 VSCode-darwin-{arch}/ 下）
      local arch_dir
      if [[ "$(uname -m)" == "arm64" ]]; then
        arch_dir="$VSCODIUM_DIR/VSCode-darwin-arm64"
      else
        arch_dir="$VSCODIUM_DIR/VSCode-darwin-x64"
      fi
      if [ -d "$arch_dir" ]; then
        cp -r "$arch_dir"/*.app "$output_dir/" 2>/dev/null || true
      fi
      # 如果有 zip/dmg 也复制
      cp -r "$VSCODIUM_DIR"/VSCodium-darwin-*.zip "$output_dir/" 2>/dev/null || true
      cp -r "$VSCODIUM_DIR"/*.dmg "$output_dir/" 2>/dev/null || true
      ;;
    windows)
      # 复制 NSIS 安装器 (.exe)
      cp -r "$VSCODIUM_DIR"/*.exe "$output_dir/" 2>/dev/null || true
      # 复制 MSI 安装器
      cp -r "$VSCODIUM_DIR"/*.msi "$output_dir/" 2>/dev/null || true
      # 复制 zip 便携版
      cp -r "$VSCODIUM_DIR"/*.zip "$output_dir/" 2>/dev/null || true
      # 如果以上都没有，尝试复制构建出的整个目录（便携版）
      local win_dir="$VSCODIUM_DIR/VSCode-win32-${VSCODE_ARCH:-x64}"
      if [ -d "$win_dir" ] && ! ls "$output_dir"/*.exe &>/dev/null && ! ls "$output_dir"/*.zip &>/dev/null; then
        log_info "未找到安装包，复制便携版目录..."
        cp -r "$win_dir" "$output_dir/OpenAIDE-win32-${VSCODE_ARCH:-x64}" 2>/dev/null || true
      fi
      ;;
    linux)
      cp -r "$VSCODIUM_DIR"/*.deb "$output_dir/" 2>/dev/null || true
      cp -r "$VSCODIUM_DIR"/*.rpm "$output_dir/" 2>/dev/null || true
      cp -r "$VSCODIUM_DIR"/*.AppImage "$output_dir/" 2>/dev/null || true
      cp -r "$VSCODIUM_DIR"/*.tar.gz "$output_dir/" 2>/dev/null || true
      ;;
  esac

  log_success "产物已复制到 $output_dir"
}

# ─── 辅助函数 ───

detect_platform() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux) echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) echo "linux" ;;
  esac
}

# ─── 主流程 ───

main() {
  local platform="${1:-}"

  echo ""
  echo "╔══════════════════════════════════════╗"
  echo "║     OpenAIDE IDE — VSCodium 构建工具      ║"
  echo "╚══════════════════════════════════════╝"
  echo ""

  check_dependencies
  clone_vscodium
  fetch_vscode
  apply_branding
  build_extension

  if [ -z "$platform" ] || [ "$platform" = "all" ]; then
    platform=$(detect_platform)
    log_info "自动检测平台: $platform"
  fi

  build_ide "$platform"

  echo ""
  log_success "🎉 OpenAIDE IDE 构建完成！"
  echo ""
}

main "$@"
