#!/bin/bash

# openAIDE Bridge 一键测试脚本
# 编译 claw-code Rust bridge → 构建 Extension → 验证 → 启动 VSCode
#
# 用法: ./scripts/test-bridge.sh [选项]
#   --skip-rust    跳过 Rust 编译（使用已有二进制）
#   --skip-build   跳过所有编译（只验证 + 启动 VSCode）
#   --build-only   仅构建，不启动 VSCode
#   --debug        Rust 使用 debug 模式编译（更快）
#   --check        只检查环境状态
#   --help         显示帮助信息
#
# 环境变量：
#   ANTHROPIC_API_KEY   Anthropic API Key（Claude 模型）

set -e

# 脚本位于 scripts/ 目录下，项目根目录为上一级
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXTENSION_PATH="$SCRIPT_DIR/packages/extension"
# claw-code 位于 openaide-ui 的同级目录
CLAW_CODE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/claw-code/rust"

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# 解析参数
SKIP_RUST=false
SKIP_BUILD=false
BUILD_ONLY=false
RUST_PROFILE="release"
CHECK_ONLY=false

for arg in "$@"; do
  case $arg in
    --skip-rust)   SKIP_RUST=true ;;
    --skip-build)  SKIP_BUILD=true ;;
    --build-only)  BUILD_ONLY=true ;;
    --debug)       RUST_PROFILE="debug" ;;
    --check)       CHECK_ONLY=true ;;
    --help|-h)
      echo "openAIDE Bridge 一键测试脚本"
      echo ""
      echo "用法: ./scripts/test-bridge.sh [选项]"
      echo "  --skip-rust    跳过 Rust 编译（使用已有二进制）"
      echo "  --skip-build   跳过所有编译（只验证 + 启动 VSCode）"
      echo "  --build-only   仅构建，不启动 VSCode"
      echo "  --debug        Rust 使用 debug 模式编译（更快）"
      echo "  --check        只检查环境状态"
      echo "  --help, -h     显示帮助"
      echo ""
      echo "示例："
      echo "  ./scripts/test-bridge.sh                # 完整构建 + 启动"
      echo "  ./scripts/test-bridge.sh --skip-rust    # 跳过 Rust 编译"
      echo "  ./scripts/test-bridge.sh --skip-build   # 跳过所有编译"
      echo "  ./scripts/test-bridge.sh --debug        # debug 模式编译 Rust"
      echo "  ./scripts/test-bridge.sh --check        # 只检查环境"
      echo ""
      echo "环境变量:"
      echo "  ANTHROPIC_API_KEY   Anthropic API Key（Claude 模型）"
      exit 0
      ;;
    *)
      warn "未知参数: $arg"
      ;;
  esac
done

# 查找 VS Code 可执行文件（复用 dev.sh 的逻辑）
find_vscode() {
  # 1. 尝试 PATH 中的 code 命令
  if command -v code &>/dev/null; then
    echo "code"
    return
  fi

  # 2. macOS 常见安装路径
  local mac_paths=(
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
    "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders"
    "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  )
  for p in "${mac_paths[@]}"; do
    if [ -f "$p" ]; then
      echo "$p"
      return
    fi
  done

  # 3. Linux 常见路径
  local linux_paths=(
    "/usr/bin/code"
    "/usr/local/bin/code"
    "/snap/bin/code"
  )
  for p in "${linux_paths[@]}"; do
    if [ -f "$p" ]; then
      echo "$p"
      return
    fi
  done

  return 1
}

# ========== 环境检查 ==========
check_env() {
  info "检查环境..."

  # Rust
  command -v cargo &>/dev/null || error "未找到 cargo，请先安装 Rust: https://rustup.rs"
  info "Rust: $(rustc --version 2>/dev/null)"

  # Node.js
  command -v node &>/dev/null || error "未找到 node，请先安装 Node.js >= 20"
  info "Node.js: $(node --version)"

  # pnpm
  command -v pnpm &>/dev/null || error "未找到 pnpm，请运行: npm install -g pnpm"
  info "pnpm: $(pnpm --version)"

  # 项目目录
  [ -d "$CLAW_CODE_DIR" ] || error "claw-code 目录不存在: $CLAW_CODE_DIR"
  info "claw-code: $CLAW_CODE_DIR"

  # ANTHROPIC_API_KEY
  if [ -n "$ANTHROPIC_API_KEY" ]; then
    info "ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:0:8}...${ANTHROPIC_API_KEY: -4}"
  else
    warn "未设置 ANTHROPIC_API_KEY，AI 对话将不可用"
    warn "  设置方法: export ANTHROPIC_API_KEY='sk-ant-xxx...'"
  fi

  # 已有构建产物
  local binary_path="$CLAW_CODE_DIR/target/$RUST_PROFILE/claw"
  if [ -f "$binary_path" ]; then
    info "Rust 二进制 ($RUST_PROFILE): $(du -h "$binary_path" | cut -f1)"
  else
    warn "Rust 二进制 ($RUST_PROFILE) 尚未编译"
  fi

  if [ -f "$EXTENSION_PATH/dist/extension.js" ]; then
    info "Extension: $(du -h "$EXTENSION_PATH/dist/extension.js" | cut -f1)"
  else
    warn "Extension 尚未构建"
  fi
}

# --check 模式：只检查环境
if $CHECK_ONLY; then
  check_env
  exit 0
fi

# ========== Step 1: 编译 Rust bridge ==========
BINARY_PATH="$CLAW_CODE_DIR/target/$RUST_PROFILE/claw"

if [ "$SKIP_BUILD" = false ] && [ "$SKIP_RUST" = false ]; then
  info "编译 claw-code Rust bridge ($RUST_PROFILE)..."

  CARGO_ARGS="-p claw-cli"
  [ "$RUST_PROFILE" = "release" ] && CARGO_ARGS="$CARGO_ARGS --release"

  (cd "$CLAW_CODE_DIR" && cargo build $CARGO_ARGS)

  [ -f "$BINARY_PATH" ] || error "编译失败：二进制文件不存在"
  info "✅ Rust bridge 编译完成: $(du -h "$BINARY_PATH" | cut -f1)"
else
  [ -f "$BINARY_PATH" ] || error "Rust 二进制不存在: $BINARY_PATH，请先运行不带 --skip-rust 的命令"
  info "跳过 Rust 编译，使用已有二进制: $(du -h "$BINARY_PATH" | cut -f1)"
fi

# ========== Step 2: 构建 Extension ==========
if [ "$SKIP_BUILD" = false ]; then
  info "构建 Extension..."
  cd "$SCRIPT_DIR"

  # 检查依赖
  if [ ! -d "node_modules" ]; then
    info "安装依赖..."
    pnpm install
  fi

  # 构建 protocol（前置依赖）
  info "构建 @openaide/protocol..."
  pnpm build:protocol

  # 构建 extension
  info "构建 @openaide/extension..."
  pnpm build:extension

  info "✅ Extension 构建完成！"
else
  [ -f "$EXTENSION_PATH/dist/extension.js" ] || error "Extension 尚未构建，请先运行不带 --skip-build 的命令"
  info "跳过 Extension 构建，使用已有产物"
fi

if [ "$BUILD_ONLY" = true ]; then
  info "✅ 构建完成（--build-only 模式）"
  exit 0
fi

# ========== Step 3: 快速验证 — ping 测试 ==========
info "验证 Bridge — 发送 ping..."

PING_REQUEST='{"jsonrpc":"2.0","id":1,"method":"ping","params":{"timestamp":'$(date +%s000)'}}'
PING_RESULT=$(echo "$PING_REQUEST" | "$BINARY_PATH" --bridge 2>/dev/null || true)

if echo "$PING_RESULT" | grep -q '"status":"ready"'; then
  info "✅ Bridge ping 通过！"
  if command -v python3 &>/dev/null; then
    echo "$PING_RESULT" | python3 -m json.tool 2>/dev/null | sed 's/^/  /'
  else
    echo "  $PING_RESULT"
  fi
else
  warn "Bridge ping 未返回预期结果（不影响 VSCode 使用）"
  [ -n "$PING_RESULT" ] && warn "输出: $PING_RESULT"
fi

# ========== Step 4: 启动 VSCode ==========
info "查找 VS Code..."
VSCODE_BIN=$(find_vscode) || error "未找到 VS Code，请确认已安装并将 'code' 命令添加到 PATH。
  macOS: 打开 VS Code → Cmd+Shift+P → 输入 'Shell Command: Install code command in PATH'
  或手动指定: VSCODE_BIN_OVERRIDE=/path/to/code ./scripts/test-bridge.sh --skip-build"

# 支持通过环境变量覆盖
if [ -n "$VSCODE_BIN_OVERRIDE" ]; then
  VSCODE_BIN="$VSCODE_BIN_OVERRIDE"
fi

info "使用 VS Code: $VSCODE_BIN"
info "加载插件路径: $EXTENSION_PATH"
info "🚀 启动 Extension Development Host..."

"$VSCODE_BIN" --extensionDevelopmentPath="$EXTENSION_PATH"

info "✅ VS Code 开发实例已启动！"
echo ""
echo -e "${CYAN}使用说明:${NC}"
echo -e "  1. 在左侧活动栏找到 ${GREEN}OpenAIDE${NC} 图标并点击"
echo -e "  2. 在聊天面板中输入消息开始对话"
echo -e "  3. 查看 Output 面板查看日志"
echo -e "  4. 按 ${GREEN}Cmd+Shift+I${NC} 打开开发者工具查看 [Bridge] 日志"
