#!/bin/bash

# openAIDE Core 终端对话脚本
# 直接启动 ts-code 的 Agent 引擎，在终端中与 AI 对话
# ts-code 是与 openaide-ui 同级的独立项目
#
# 用法: ./scripts/run-core.sh [选项]
#   --skip-build   跳过构建，直接启动 Core
#   --build-only   仅构建，不启动 Core
#   --model <name> 指定模型（覆盖 OPENAIDE_MODEL 环境变量）
#   --help         显示帮助信息
#
# 环境变量：
#   ANTHROPIC_API_KEY   Anthropic API Key（Claude 模型）
#   OPENAI_API_KEY      OpenAI API Key（GPT 模型）
#   DEEPSEEK_API_KEY    DeepSeek API Key
#   GLM_API_KEY         智谱 GLM API Key
#   QWEN_API_KEY        通义千问 API Key
#   DASHSCOPE_API_KEY   通义千问 API Key（备用）
#   OPENAIDE_MODEL      模型名称（如 claude-sonnet-4-20250514, gpt-4o, deepseek-chat, glm-4-plus）
#   OPENAIDE_API_KEY    统一 API Key（优先级最高）
#   OPENAIDE_BASE_URL   统一 API Base URL

set -e

# 脚本位于 scripts/ 目录下，项目根目录为上一级
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TS_CODE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/ts-code"

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# 解析参数
SKIP_BUILD=false
BUILD_ONLY=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-build)  SKIP_BUILD=true; shift ;;
    --build-only)  BUILD_ONLY=true; shift ;;
    --model)
      export OPENAIDE_MODEL="$2"
      shift 2
      ;;
    --help|-h)
      echo -e "${BOLD}openAIDE Core — 终端 AI 对话${NC}"
      echo ""
      echo "用法: ./scripts/run-core.sh [选项]"
      echo ""
      echo "选项:"
      echo "  --skip-build     跳过构建，直接启动 Core"
      echo "  --build-only     仅构建，不启动 Core"
      echo "  --model <name>   指定模型（覆盖 OPENAIDE_MODEL 环境变量）"
      echo "  --help, -h       显示帮助"
      echo ""
      echo "示例："
      echo "  ./scripts/run-core.sh                           # 完整构建 + 启动对话"
      echo "  ./scripts/run-core.sh --skip-build              # 跳过编译直接启动"
      echo "  ./scripts/run-core.sh --model deepseek-chat     # 指定 DeepSeek 模型"
      echo "  ./scripts/run-core.sh --build-only              # 仅构建"
      echo ""
      echo "支持的模型示例："
      echo "  claude-sonnet-4-20250514   Anthropic Claude (需要 ANTHROPIC_API_KEY)"
      echo "  gpt-4o                     OpenAI GPT-4o (需要 OPENAI_API_KEY)"
      echo "  deepseek-chat              DeepSeek (需要 DEEPSEEK_API_KEY)"
      echo "  glm-4-plus                 智谱 GLM (需要 GLM_API_KEY)"
      echo "  qwen-plus                  通义千问 (需要 DASHSCOPE_API_KEY)"
      echo "  ollama/llama3              Ollama 本地模型 (无需 Key)"
      echo ""
      echo "交互命令："
      echo "  /quit, /exit, /q   退出对话"
      echo "  /clear             清空对话历史"
      echo "  /usage             查看 Token 用量"
      echo "  /help              显示交互帮助"
      echo ""
      echo "相关脚本："
      echo "  ./scripts/dev-core.sh     Core stdio Bridge 模式 (JSON-RPC)"
      echo "  ./scripts/dev.sh          完整开发环境启动（含 VS Code）"
      echo "  ./scripts/dev-rust.sh     Rust 引擎 (claw-code) 开发"
      echo "  ./scripts/dev-ts.sh       TS 引擎 (claude-code) 开发"
      echo "  ./scripts/cli.sh          终端交互式 Agent 对话（同此脚本功能）"
      echo ""
      echo "环境变量："
      echo "  ANTHROPIC_API_KEY   Anthropic API Key（Claude 模型，默认）"
      echo "  OPENAIDE_MODEL      模型名称"
      echo "  OPENAIDE_API_KEY    统一 API Key（优先级最高）"
      echo "  OPENAIDE_BASE_URL   统一 API Base URL"
      echo "  DEEPSEEK_API_KEY    DeepSeek API Key"
      echo "  GLM_API_KEY         智谱 GLM API Key"
      echo "  DASHSCOPE_API_KEY   通义千问 API Key"
      echo "  OPENAI_API_KEY      OpenAI API Key"
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

  # 构建 protocol（core 的前置依赖）
  info "构建 @openaide/protocol..."
  pnpm build:protocol

  # 构建 core
  info "构建 ts-code..."
  (cd "$TS_CODE_DIR" && pnpm install && pnpm build)

  info "✅ 构建完成！"
fi

if [ "$BUILD_ONLY" = true ]; then
  info "✅ 构建完成（--build-only 模式）"
  exit 0
fi

# ========== 启动 Core 终端对话 ==========
echo ""
info "🚀 启动 Agent Core 终端对话..."
echo ""

cd "$SCRIPT_DIR"

# 优先使用 tsx 直接运行 TypeScript（开发模式，推荐）
if command -v tsx &>/dev/null; then
  exec tsx "$TS_CODE_DIR/src/cli.ts"
fi

# 使用 npx tsx
if npx --no-install tsx --version &>/dev/null 2>&1; then
  exec npx tsx "$TS_CODE_DIR/src/cli.ts"
fi

# 回退到编译后的 JS
if [ -f "$TS_CODE_DIR/dist/cli.js" ]; then
  exec node "$TS_CODE_DIR/dist/cli.js"
fi

error "未找到可用的运行方式。请安装 tsx: pnpm add -g tsx，或先编译 ts-code"
