#!/bin/bash

# ═══════════════════════════════════════════════════════════════
# openAIDE dev-core.sh — ts-code 引擎 (独立 TS 项目) 开发启动脚本
# ═══════════════════════════════════════════════════════════════
#
# 启动 ts-code 引擎的 VSCode 开发实例。
# ts-code 是与 openaide-ui 同级的独立项目。
#
# 用法: ./scripts/dev-core.sh [选项]
#   --skip-build   跳过所有编译（只启动 VSCode）
#   --build-only   仅构建，不启动 VSCode
#   --core-only    仅启动 ts-code Bridge（stdio 模式，用于独立调试）
#   --check        只检查环境状态
#   --model <name> 指定模型
#   --help         显示帮助信息

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXTENSION_PATH="$SCRIPT_DIR/packages/extension"
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

# 启动 Banner
print_banner() {
  echo ""
  echo -e "${CYAN}╔═══════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║${NC}  ${BOLD}${GREEN}📦 OpenAIDE — ts-code 引擎${NC}                          ${CYAN}║${NC}"
  echo -e "${CYAN}╠═══════════════════════════════════════════════════════╣${NC}"
  echo -e "${CYAN}║${NC}  引擎类型:  ${GREEN}TypeScript (ts-code)${NC}                    ${CYAN}║${NC}"
  echo -e "${CYAN}║${NC}  源码路径:  ${YELLOW}ts-code/${NC}                                 ${CYAN}║${NC}"
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
      echo -e "${BOLD}openAIDE — ts-code 引擎开发脚本${NC}"
      echo ""
      echo "用法: ./scripts/dev-core.sh [选项]"
      echo "  --skip-build     跳过构建，直接启动 VSCode"
      echo "  --build-only     仅构建，不启动 VSCode"
      echo "  --core-only      仅启动 ts-code Bridge（stdio 模式，独立调试）"
      echo "  --check          只检查环境状态"
      echo "  --model <name>   指定模型"
      echo "  --help, -h       显示帮助"
      echo ""
      echo "示例："
      echo "  ./scripts/dev-core.sh                          # 完整构建 + 启动 VSCode"
      echo "  ./scripts/dev-core.sh --core-only              # 独立调试 ts-code Bridge"
      echo "  ./scripts/dev-core.sh --skip-build             # 跳过编译直接启动"
      echo "  ./scripts/dev-core.sh --model deepseek-chat    # 指定模型"
      echo ""
      echo "其他引擎脚本:"
      echo "  ./scripts/dev-ts.sh         TS 引擎 (claude-code)"
      echo "  ./scripts/dev-rust.sh       Rust 引擎 (claw-code)"
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
  [ -d "$TS_CODE_DIR" ] && info "ts-code: $TS_CODE_DIR" || error "ts-code 目录不存在: $TS_CODE_DIR"
  [ -f "$TS_CODE_DIR/src/bridge-server.ts" ] && info "bridge-server: ✅" || warn "bridge-server 源码不存在"
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

  info "构建 ts-code..."
  (cd "$TS_CODE_DIR" && pnpm install && pnpm build)

  if [ "$CORE_ONLY" = false ]; then
    info "构建 @openaide/extension..."
    pnpm build:extension
  fi

  info "✅ 构建完成！"
fi

[ "$BUILD_ONLY" = true ] && { info "✅ 构建完成（--build-only 模式）"; exit 0; }

# ========== Core 独立模式 (stdio) ==========
if [ "$CORE_ONLY" = true ]; then
  info "🚀 启动 ts-code Bridge（stdio 模式）..."
  info "通过 stdin/stdout 进行 JSON-RPC 2.0 通信"
  info "按 Ctrl+C 退出"
  echo ""
  cd "$SCRIPT_DIR"

  # 方式 1: 编译后的 JS（优先）
  if [ -f "$TS_CODE_DIR/dist/bridge-server.js" ]; then
    info "使用编译后的 bridge-server.js..."
    exec node "$TS_CODE_DIR/dist/bridge-server.js" --bridge
  fi

  # 方式 2: tsx 直接运行 TypeScript 源码
  if command -v tsx &>/dev/null; then
    info "使用 tsx 运行 bridge-server（开发模式）..."
    exec tsx "$TS_CODE_DIR/src/bridge-server.ts" --bridge
  fi

  # 方式 3: npx tsx
  if npx --no-install tsx --version &>/dev/null 2>&1; then
    info "使用 npx tsx 运行 bridge-server..."
    exec npx tsx "$TS_CODE_DIR/src/bridge-server.ts" --bridge
  fi

  error "未找到可用的运行方式。请先编译 ts-code (pnpm build)，或安装 tsx: pnpm add -g tsx"
fi

# ========== 在 dist/ 下放置 ts-code Bridge wrapper ==========
DIST_DIR="$EXTENSION_PATH/dist"
TS_BRIDGE_BUNDLE="$DIST_DIR/bridge-server.bundle.cjs"

info "生成 ts-code Bridge wrapper: dist/bridge-server.bundle.cjs"
mkdir -p "$DIST_DIR"

# 优先使用编译后的 JS，回退到 tsx
if [ -f "$TS_CODE_DIR/dist/bridge-server.js" ]; then
  TS_CODE_ENTRY="$TS_CODE_DIR/dist/bridge-server.js"
  info "  → 委托到: ts-code/dist/bridge-server.js (编译产物)"
  cat > "$TS_BRIDGE_BUNDLE" << WRAPPER_EOF
#!/usr/bin/env node
// ts-code Bridge wrapper — 由 dev-core.sh 生成
// 委托到 ts-code 编译产物
const { spawn } = require('child_process');
const child = spawn(
  process.execPath,
  ['${TS_CODE_ENTRY}', '--bridge'],
  { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
);
child.on('exit', (code) => process.exit(code || 0));
child.on('error', (err) => { console.error('[ts-code Bridge wrapper]', err.message); process.exit(1); });
WRAPPER_EOF
else
  TSX_BIN=$(command -v tsx 2>/dev/null || echo "tsx")
  info "  → 委托到: tsx + ts-code/src/bridge-server.ts (开发模式)"
  cat > "$TS_BRIDGE_BUNDLE" << WRAPPER_EOF
#!/usr/bin/env node
// ts-code Bridge wrapper — 由 dev-core.sh 生成
// 委托到 tsx 运行 ts-code 源码
const { spawn } = require('child_process');
const child = spawn(
  '${TSX_BIN}',
  ['${TS_CODE_DIR}/src/bridge-server.ts', '--bridge'],
  { stdio: 'inherit', env: { ...process.env } }
);
child.on('exit', (code) => process.exit(code || 0));
child.on('error', (err) => { console.error('[ts-code Bridge wrapper]', err.message); process.exit(1); });
WRAPPER_EOF
fi

# 清理 dist/ 中所有其他引擎产物，确保只保留 ts-code 引擎
info "清理 dist/ 中的其他引擎产物..."
rm -f "$DIST_DIR/openaide-core" "$DIST_DIR/openaide-core.exe" 2>/dev/null
info "✅ dist/ 中仅保留 ts-code 引擎 (bridge-server.bundle.cjs)"

# ========== 启动 VSCode ==========
VSCODE_BIN=$(find_vscode) || error "未找到 VS Code"
[ -n "$VSCODE_BIN_OVERRIDE" ] && VSCODE_BIN="$VSCODE_BIN_OVERRIDE"

info "使用 VS Code: $VSCODE_BIN"
info "加载插件路径: $EXTENSION_PATH"
info "🚀 启动 Extension Development Host（ts-code 引擎）..."
echo ""

"$VSCODE_BIN" --extensionDevelopmentPath="$EXTENSION_PATH" --wait

info "✅ VS Code 开发实例已关闭"