#!/bin/bash

# openAIDE (OpenAIDE) 开发启动脚本
# 用法: ./dev.sh [选项]
#   --build-only   仅构建，不启动 VS Code
#   --skip-build   跳过构建，直接启动 VS Code
#   --core-only    仅启动 Agent Core（stdio 模式，用于独立调试）
#   --help         显示帮助信息

set -e

# 脚本位于 scripts/ 目录下，项目根目录为上一级
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXTENSION_PATH="$SCRIPT_DIR/packages/extension"
TS_CODE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/ts-code"

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m' # 无颜色

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
debug() { echo -e "${CYAN}[CORE]${NC} $1"; }

# 解析参数
BUILD_ONLY=false
SKIP_BUILD=false
CORE_ONLY=false

for arg in "$@"; do
  case $arg in
    --build-only)  BUILD_ONLY=true ;;
    --skip-build)  SKIP_BUILD=true ;;
    --core-only)   CORE_ONLY=true ;;
    --help)
      echo "openAIDE (OpenAIDE) 开发启动脚本"
      echo ""
      echo "用法: ./dev.sh [选项]"
      echo "  --build-only   仅构建，不启动 VS Code"
      echo "  --skip-build   跳过构建，直接启动 VS Code"
      echo "  --core-only    仅启动 Agent Core（stdio 模式，用于独立调试）"
      echo "  --help         显示帮助信息"
      echo ""
      echo "Core 独立模式:"
      echo "  ./dev.sh --core-only"
      echo "  启动后可通过 stdin 发送 JSON-RPC 2.0 消息与 Core 交互。"
      echo "  示例: {\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"params\":{}}"
      echo ""
      echo "环境变量:"
      echo "  ANTHROPIC_API_KEY   Anthropic API Key（Claude 模型）"
      echo "  OPENAI_API_KEY      OpenAI API Key（GPT 模型）"
      echo "  OPENAIDE_PROVIDER   LLM 提供者（默认 anthropic）"
      echo "  OPENAIDE_MODEL      模型名称（默认 claude-sonnet-4-20250514）"
      echo ""
      echo "其他脚本:"
      echo "  ./scripts/cli.sh           终端交互式 Agent 对话（CLI 模式）"
      echo "  ./scripts/cli.sh --help    查看 CLI 模式帮助"
      exit 0
      ;;
    *)
      warn "未知参数: $arg"
      ;;
  esac
done

# 查找 VS Code 可执行文件
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

# ========== 构建 ==========
if [ "$SKIP_BUILD" = false ]; then
  info "开始构建..."
  cd "$SCRIPT_DIR"

  # 检查 pnpm
  if ! command -v pnpm &>/dev/null; then
    error "未找到 pnpm，请先安装: npm install -g pnpm"
  fi

  # 检查依赖是否已安装
  if [ ! -d "node_modules" ]; then
    info "安装依赖..."
    pnpm install
  fi

  # 构建 protocol（其他包的前置依赖）
  info "构建 @openaide/protocol..."
  pnpm build:protocol

  if [ "$CORE_ONLY" = true ]; then
    # Core 模式只需构建 protocol + core
    info "构建 ts-code..."
    (cd "$TS_CODE_DIR" && pnpm install && pnpm build)
  else
    # 完整构建
    info "构建 @openaide/extension..."
    pnpm build:extension
  fi

  info "✅ 构建完成！"
fi

if [ "$BUILD_ONLY" = true ]; then
  exit 0
fi

# ========== Core 独立模式 ==========
if [ "$CORE_ONLY" = true ]; then
  info "🚀 启动 Agent Core（stdio 模式）..."
  debug "Core 将通过 stdin/stdout 进行 JSON-RPC 2.0 通信"
  debug "stderr 用于日志输出"
  debug ""
  debug "快速测试 — 复制以下 JSON 粘贴到 stdin:"
  debug '  {"jsonrpc":"2.0","id":1,"method":"ping","params":{"timestamp":'$(date +%s000)'}}'
  debug ""
  debug "按 Ctrl+C 退出"
  debug "─────────────────────────────────────────"

  cd "$SCRIPT_DIR"

  # 使用 tsx 直接运行 TypeScript 源码（开发模式）
  # 也可以用 node dist/bridge-server.js --bridge（编译后模式）
  if command -v tsx &>/dev/null; then
    exec tsx "$TS_CODE_DIR/src/bridge-server.ts" --bridge
  else
    # 回退到编译后的 JS
    if [ -f "$TS_CODE_DIR/dist/bridge-server.js" ]; then
      exec node "$TS_CODE_DIR/dist/bridge-server.js" --bridge
    else
      error "未找到 tsx 命令且 ts-code 未编译。请先运行: cd ts-code && pnpm install && pnpm build"
    fi
  fi
fi

# ========== 启动 VS Code ==========
info "查找 VS Code..."
VSCODE_BIN=$(find_vscode) || error "未找到 VS Code，请确认已安装 VS Code 并将 'code' 命令添加到 PATH 中。
  macOS: 打开 VS Code → Cmd+Shift+P → 输入 'Shell Command: Install code command in PATH'
  或手动指定路径运行: VSCODE_BIN=/path/to/code ./dev.sh --skip-build"

# 支持通过环境变量覆盖
if [ -n "$VSCODE_BIN_OVERRIDE" ]; then
  VSCODE_BIN="$VSCODE_BIN_OVERRIDE"
fi

info "使用 VS Code: $VSCODE_BIN"
info "加载插件路径: $EXTENSION_PATH"
info "🚀 启动开发实例..."

"$VSCODE_BIN" --extensionDevelopmentPath="$EXTENSION_PATH"

info "✅ VS Code 开发实例已启动！"
