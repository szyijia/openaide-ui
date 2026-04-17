#!/bin/bash

# ═══════════════════════════════════════════════════════════════
# openAIDE dev-ts.sh — TS 引擎 (claude-code) 开发启动脚本
# ═══════════════════════════════════════════════════════════════
#
# 用法: ./scripts/dev-ts.sh [选项]
#   --skip-build   跳过所有编译（只启动 VSCode）
#   --build-only   仅构建，不启动 VSCode
#   --core-only    仅启动 TS Bridge（stdio 模式，用于独立调试）
#   --check        只检查环境状态
#   --model <name> 指定模型
#   --help         显示帮助信息

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXTENSION_PATH="$SCRIPT_DIR/packages/extension"
CLAUDE_CODE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/claude-code"
TS_CODE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/ts-code"

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

# 启动 Banner — 明确显示当前引擎
print_banner() {
  echo ""
  echo -e "${CYAN}╔═══════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║${NC}  ${BOLD}${GREEN}🟢 OpenAIDE — TS 引擎 (claude-code)${NC}                  ${CYAN}║${NC}"
  echo -e "${CYAN}╠═══════════════════════════════════════════════════════╣${NC}"
  echo -e "${CYAN}║${NC}  引擎类型:  ${GREEN}TypeScript (claude-code bridge-adapter)${NC}  ${CYAN}║${NC}"
  echo -e "${CYAN}║${NC}  源码路径:  ${YELLOW}$(basename "$CLAUDE_CODE_DIR")/${NC}                          ${CYAN}║${NC}"
  [ -n "$OPENAIDE_MODEL" ] && \
  echo -e "${CYAN}║${NC}  当前模型:  ${GREEN}$OPENAIDE_MODEL${NC}$(printf '%*s' $((30 - ${#OPENAIDE_MODEL})) '')${CYAN}║${NC}"
  echo -e "${CYAN}╚═══════════════════════════════════════════════════════╝${NC}"
  echo ""
}

# 解析参数
SKIP_BUILD=false
BUILD_ONLY=false
CORE_ONLY=false
CHECK_ONLY=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-build)  SKIP_BUILD=true; shift ;;
    --build-only)  BUILD_ONLY=true; shift ;;
    --core-only)   CORE_ONLY=true; shift ;;
    --check)       CHECK_ONLY=true; shift ;;
    --model)       export OPENAIDE_MODEL="$2"; shift 2 ;;
    --help|-h)
      echo -e "${BOLD}openAIDE — TS 引擎 (claude-code) 开发脚本${NC}"
      echo ""
      echo "用法: ./scripts/dev-ts.sh [选项]"
      echo "  --skip-build     跳过编译，直接启动 VSCode"
      echo "  --build-only     仅构建，不启动 VSCode"
      echo "  --core-only      仅启动 TS Bridge（stdio 模式，独立调试）"
      echo "  --check          只检查环境状态"
      echo "  --model <name>   指定模型"
      echo "  --help, -h       显示帮助"
      echo ""
      echo "示例："
      echo "  ./scripts/dev-ts.sh                          # 完整构建 + 启动"
      echo "  ./scripts/dev-ts.sh --core-only              # 独立调试 TS Bridge"
      echo "  ./scripts/dev-ts.sh --skip-build             # 跳过编译直接启动"
      echo ""
      echo "其他引擎脚本:"
      echo "  ./scripts/dev-rust.sh       Rust 引擎 (claw-code)"
      echo "  ./scripts/dev-core.sh       ts-code 引擎 (内置 TS Core)"
      echo "  ./scripts/dev.sh            默认开发环境"
      exit 0
      ;;
    *) warn "未知参数: $1"; shift ;;
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
  command -v node &>/dev/null && info "Node.js: $(node --version)" || error "未找到 node"
  command -v pnpm &>/dev/null && info "pnpm: $(pnpm --version)" || error "未找到 pnpm"
  command -v tsx &>/dev/null && info "tsx: available" || warn "未找到 tsx（可选）"
  [ -d "$CLAUDE_CODE_DIR" ] && info "claude-code: $CLAUDE_CODE_DIR" || error "claude-code 目录不存在: $CLAUDE_CODE_DIR"
  [ -f "$CLAUDE_CODE_DIR/src/bridge-adapter/entry.ts" ] && info "bridge-adapter: ✅" || error "bridge-adapter 源码不存在"
}

if $CHECK_ONLY; then check_env; exit 0; fi

# 打印 Banner
print_banner

# ========== 构建 ==========
if [ "$SKIP_BUILD" = false ]; then
  info "开始构建..."
  cd "$SCRIPT_DIR"
  command -v pnpm &>/dev/null || error "未找到 pnpm"
  [ -d "node_modules" ] || { info "安装依赖..."; pnpm install; }

  info "构建 @openaide/protocol..."
  pnpm build:protocol

  if [ "$CORE_ONLY" = true ]; then
    info "构建 ts-code..."
    (cd "$TS_CODE_DIR" && pnpm install && pnpm build)
  else
    info "构建 @openaide/extension..."
    pnpm build:extension
  fi
  info "✅ 构建完成！"
fi

[ "$BUILD_ONLY" = true ] && { info "✅ 构建完成（--build-only 模式）"; exit 0; }

# ========== Core 独立模式 (stdio) ==========
if [ "$CORE_ONLY" = true ]; then
  info "🚀 启动 TS Bridge Adapter（stdio 模式）..."
  info "通过 stdin/stdout 进行 JSON-RPC 2.0 通信"
  echo ""
  cd "$SCRIPT_DIR"
  if command -v tsx &>/dev/null; then
    exec tsx "$CLAUDE_CODE_DIR/src/bridge-adapter/entry.ts" --bridge
  elif npx --no-install tsx --version &>/dev/null 2>&1; then
    exec npx tsx "$CLAUDE_CODE_DIR/src/bridge-adapter/entry.ts" --bridge
  elif [ -f "$TS_CODE_DIR/dist/bridge-server.js" ]; then
    exec node "$TS_CODE_DIR/dist/bridge-server.js" --bridge
  fi
  error "未找到可用的运行方式。请安装 tsx: pnpm add -g tsx"
fi

# ========== 在 dist/ 下放置 TS Bridge wrapper ==========
DIST_DIR="$EXTENSION_PATH/dist"
TS_BRIDGE_BUNDLE="$DIST_DIR/bridge-server.bundle.cjs"

info "生成 TS Bridge wrapper: dist/bridge-server.bundle.cjs"
TSX_BIN=$(command -v tsx 2>/dev/null || echo "tsx")
mkdir -p "$DIST_DIR"
cat > "$TS_BRIDGE_BUNDLE" << WRAPPER_EOF
#!/usr/bin/env node
// TS Bridge wrapper — 由 dev-ts.sh 生成
// 将 stdio 透传到 claude-code bridge-adapter (tsx)
const { spawn } = require('child_process');
const child = spawn(
  '${TSX_BIN}',
  ['${CLAUDE_CODE_DIR}/src/bridge-adapter/entry.ts', '--bridge'],
  { stdio: 'inherit', env: { ...process.env } }
);
child.on('exit', (code) => process.exit(code || 0));
child.on('error', (err) => { console.error('[TS Bridge wrapper]', err.message); process.exit(1); });
WRAPPER_EOF

# 清理 dist/ 中所有其他引擎产物，确保只保留 claude-code 引擎
info "清理 dist/ 中的其他引擎产物..."
rm -f "$DIST_DIR/openaide-core" "$DIST_DIR/openaide-core.exe" 2>/dev/null
info "✅ dist/ 中仅保留 claude-code 引擎 (bridge-server.bundle.cjs)"

# ========== 启动 VSCode ==========
VSCODE_BIN=$(find_vscode) || error "未找到 VS Code"
[ -n "$VSCODE_BIN_OVERRIDE" ] && VSCODE_BIN="$VSCODE_BIN_OVERRIDE"

info "使用 VS Code: $VSCODE_BIN"
info "加载插件路径: $EXTENSION_PATH"
info "🚀 启动 Extension Development Host（TS 引擎）..."
echo ""

"$VSCODE_BIN" --extensionDevelopmentPath="$EXTENSION_PATH" --wait

info "✅ VS Code 开发实例已关闭"
