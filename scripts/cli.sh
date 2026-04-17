#!/bin/bash

# openAIDE CLI — 终端交互式 Agent 对话
# 用法: ./scripts/cli.sh [选项]
#   --skip-build   跳过构建，直接启动 CLI
#   --model <name> 指定模型（覆盖 OPENAIDE_MODEL 环境变量）
#   --help         显示帮助信息
#
# 环境变量：
#   ANTHROPIC_API_KEY   Anthropic API Key（Claude 模型）
#   OPENAI_API_KEY      OpenAI API Key（GPT 模型）
#   DEEPSEEK_API_KEY    DeepSeek API Key
#   QWEN_API_KEY        通义千问 API Key
#   GLM_API_KEY         智谱 GLM API Key
#   OPENAIDE_MODEL      模型名称（如 claude-sonnet-4-20250514, gpt-4o, deepseek-chat）

set -e

# 项目根目录
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TS_CODE_DIR="$(cd "$ROOT_DIR/.." && pwd)/ts-code"

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
SKIP_BUILD=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --model)
      export OPENAIDE_MODEL="$2"
      shift 2
      ;;
    --help)
      echo "openAIDE CLI — 终端交互式 Agent 对话"
      echo ""
      echo "用法: ./scripts/cli.sh [选项]"
      echo "  --skip-build     跳过构建，直接启动 CLI"
      echo "  --model <name>   指定模型（覆盖 OPENAIDE_MODEL 环境变量）"
      echo "  --help           显示帮助信息"
      echo ""
      echo "支持的模型示例："
      echo "  claude-sonnet-4-20250514  (需要 ANTHROPIC_API_KEY)"
      echo "  gpt-4o                    (需要 OPENAI_API_KEY)"
      echo "  deepseek-chat             (需要 DEEPSEEK_API_KEY)"
      echo "  glm-4-plus                (需要 GLM_API_KEY)"
      echo "  qwen-plus                 (需要 QWEN_API_KEY)"
      echo ""
      echo "示例："
      echo "  ./scripts/cli.sh                          # 使用默认模型"
      echo "  ./scripts/cli.sh --model gpt-4o           # 指定 GPT-4o"
      echo "  ./scripts/cli.sh --skip-build             # 跳过构建直接启动"
      echo "  OPENAIDE_MODEL=deepseek-chat ./scripts/cli.sh"
      exit 0
      ;;
    *)
      warn "未知参数: $1"
      shift
      ;;
  esac
done

# ========== 构建 ==========
if [ "$SKIP_BUILD" = false ]; then
  info "构建依赖..."
  cd "$ROOT_DIR"

  if ! command -v pnpm &>/dev/null; then
    error "未找到 pnpm，请先安装: npm install -g pnpm"
  fi

  if [ ! -d "node_modules" ]; then
    info "安装依赖..."
    pnpm install
  fi

  # 构建 protocol（core 的前置依赖）
  info "构建 @openaide/protocol..."
  pnpm build:protocol

  info "构建 ts-code..."
  (cd "$TS_CODE_DIR" && pnpm install && pnpm build)

  info "✅ 构建完成！"
fi

# ========== 启动 CLI ==========
info "🚀 启动 OpenAIDE CLI..."

if [ -n "$OPENAIDE_MODEL" ]; then
  info "模型: $OPENAIDE_MODEL"
fi

cd "$ROOT_DIR"

# 优先使用 tsx 直接运行 TypeScript（开发模式）
if command -v tsx &>/dev/null; then
  exec tsx "$TS_CODE_DIR/src/cli.ts"
elif npx --no-install tsx --version &>/dev/null 2>&1; then
  exec npx tsx "$TS_CODE_DIR/src/cli.ts"
else
  # 回退到编译后的 JS
  if [ -f "$TS_CODE_DIR/dist/cli.js" ]; then
    exec node "$TS_CODE_DIR/dist/cli.js"
  else
    error "未找到 tsx 命令且 Core 未编译。请先运行: pnpm install"
  fi
fi
