#!/bin/bash

# ═══════════════════════════════════════════════════════════════
# openAIDE dev-rust.sh — Rust 引擎 (claw-code) 开发启动脚本
# ═══════════════════════════════════════════════════════════════
#
# 用法: ./scripts/dev-rust.sh [选项]
#   --skip-rust    跳过 Rust 编译（使用已有二进制）
#   --skip-build   跳过所有编译（只启动 VSCode）
#   --build-only   仅构建，不启动 VSCode
#   --debug        Rust 使用 debug 模式编译（更快）
#   --check        只检查环境状态
#   --help         显示帮助信息

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXTENSION_PATH="$SCRIPT_DIR/packages/extension"
CLAW_CODE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/claw-code/rust"

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# 启动 Banner
print_banner() {
  echo ""
  echo -e "${CYAN}╔═══════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║${NC}  ${BOLD}${GREEN}🦀 OpenAIDE — Rust 引擎 (claw-code)${NC}                  ${CYAN}║${NC}"
  echo -e "${CYAN}╠═══════════════════════════════════════════════════════╣${NC}"
  echo -e "${CYAN}║${NC}  引擎类型:  ${GREEN}Rust (claw-code bridge)${NC}                   ${CYAN}║${NC}"
  echo -e "${CYAN}║${NC}  编译模式:  ${GREEN}$RUST_PROFILE${NC}$(printf '%*s' $((35 - ${#RUST_PROFILE})) '')${CYAN}║${NC}"
  echo -e "${CYAN}║${NC}  源码路径:  ${YELLOW}claw-code/rust/${NC}                           ${CYAN}║${NC}"
  echo -e "${CYAN}╚═══════════════════════════════════════════════════════╝${NC}"
  echo ""
}

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
      echo -e "${BOLD}openAIDE — Rust 引擎 (claw-code) 开发脚本${NC}"
      echo ""
      echo "用法: ./scripts/dev-rust.sh [选项]"
      echo "  --skip-rust    跳过 Rust 编译（使用已有二进制）"
      echo "  --skip-build   跳过所有编译（只启动 VSCode）"
      echo "  --build-only   仅构建，不启动 VSCode"
      echo "  --debug        Rust 使用 debug 模式编译（更快）"
      echo "  --check        只检查环境状态"
      echo "  --help, -h     显示帮助"
      echo ""
      echo "示例："
      echo "  ./scripts/dev-rust.sh                # 完整构建 + 启动"
      echo "  ./scripts/dev-rust.sh --skip-rust    # 跳过 Rust 编译"
      echo "  ./scripts/dev-rust.sh --debug        # debug 模式编译"
      echo ""
      echo "其他引擎脚本:"
      echo "  ./scripts/dev-ts.sh         TS 引擎 (claude-code)"
      echo "  ./scripts/dev-core.sh       ts-code 引擎 (内置 TS Core)"
      echo "  ./scripts/dev.sh            默认开发环境"
      exit 0
      ;;
    *) warn "未知参数: $arg" ;;
  esac
done

# 查找 VS Code
find_vscode() {
  if command -v code &>/dev/null; then echo "code"; return; fi
  local paths=(
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
    "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders"
    "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
    "/usr/bin/code" "/usr/local/bin/code" "/snap/bin/code"
  )
  for p in "${paths[@]}"; do [ -f "$p" ] && echo "$p" && return; done
  return 1
}

# 环境检查
check_env() {
  info "检查环境..."
  command -v cargo &>/dev/null && info "Rust: $(rustc --version 2>/dev/null)" || error "未找到 cargo"
  command -v node &>/dev/null && info "Node.js: $(node --version)" || error "未找到 node"
  command -v pnpm &>/dev/null && info "pnpm: $(pnpm --version)" || error "未找到 pnpm"
  [ -d "$CLAW_CODE_DIR" ] && info "claw-code: $CLAW_CODE_DIR" || error "claw-code 目录不存在: $CLAW_CODE_DIR"
  if [ -n "$ANTHROPIC_API_KEY" ]; then
    info "ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:0:8}...${ANTHROPIC_API_KEY: -4}"
  else
    warn "未设置 ANTHROPIC_API_KEY"
  fi
}

if $CHECK_ONLY; then check_env; exit 0; fi

# 打印 Banner
print_banner

# ========== Step 1: 编译 Rust bridge ==========
BINARY_PATH="$CLAW_CODE_DIR/target/$RUST_PROFILE/claw"

if [ "$SKIP_BUILD" = false ] && [ "$SKIP_RUST" = false ]; then
  info "编译 claw-code Rust bridge ($RUST_PROFILE)..."
  CARGO_ARGS="-p rusty-claude-cli"
  [ "$RUST_PROFILE" = "release" ] && CARGO_ARGS="$CARGO_ARGS --release"
  (cd "$CLAW_CODE_DIR" && cargo build $CARGO_ARGS)
  [ -f "$BINARY_PATH" ] || error "编译失败：二进制文件不存在"
  info "✅ Rust bridge 编译完成: $(du -h "$BINARY_PATH" | cut -f1)"
else
  [ -f "$BINARY_PATH" ] || error "Rust 二进制不存在: $BINARY_PATH"
  info "跳过 Rust 编译，使用已有二进制: $(du -h "$BINARY_PATH" | cut -f1)"
fi

# ========== Step 2: 构建 Extension ==========
if [ "$SKIP_BUILD" = false ]; then
  info "构建 Extension..."
  cd "$SCRIPT_DIR"
  command -v pnpm &>/dev/null || error "未找到 pnpm"
  [ -d "node_modules" ] || { info "安装依赖..."; pnpm install; }

  info "构建 @openaide/protocol..."
  pnpm build:protocol

  info "构建 @openaide/extension..."
  pnpm build:extension
  info "✅ Extension 构建完成！"
else
  [ -f "$EXTENSION_PATH/dist/extension.js" ] || error "Extension 尚未构建"
  info "跳过 Extension 构建"
fi

[ "$BUILD_ONLY" = true ] && { info "✅ 构建完成（--build-only 模式）"; exit 0; }

# ========== Step 3: 清理 dist/ 中所有引擎产物，放入 claw-code ==========
DIST_DIR="$EXTENSION_PATH/dist"
info "清理 dist/ 中的所有引擎产物..."
rm -f "$DIST_DIR/bridge-server.bundle.cjs" 2>/dev/null
rm -f "$DIST_DIR/openaide-core" "$DIST_DIR/openaide-core.exe" 2>/dev/null

info "软链 claw-code 二进制到 dist/openaide-core..."
ln -sf "$BINARY_PATH" "$DIST_DIR/openaide-core"
info "✅ dist/ 中仅保留 claw-code 引擎 (openaide-core → $BINARY_PATH)"

# ========== Step 4: 快速验证 — ping 测试 ==========
info "验证 Bridge — 发送 ping..."
PING_REQUEST='{"jsonrpc":"2.0","id":1,"method":"ping","params":{"timestamp":'$(date +%s000)'}}'
PING_RESULT=$(echo "$PING_REQUEST" | "$BINARY_PATH" --bridge 2>/dev/null || true)

if echo "$PING_RESULT" | grep -q '"status":"ready"'; then
  info "✅ Bridge ping 通过！"
else
  warn "Bridge ping 未返回预期结果（不影响 VSCode 使用）"
fi

# ========== Step 5: 启动 VSCode ==========
VSCODE_BIN=$(find_vscode) || error "未找到 VS Code"
[ -n "$VSCODE_BIN_OVERRIDE" ] && VSCODE_BIN="$VSCODE_BIN_OVERRIDE"

info "使用 VS Code: $VSCODE_BIN"
info "加载插件路径: $EXTENSION_PATH"
info "🚀 启动 Extension Development Host（Rust 引擎）..."
echo ""

"$VSCODE_BIN" --extensionDevelopmentPath="$EXTENSION_PATH"

info "✅ VS Code 开发实例已启动！"
