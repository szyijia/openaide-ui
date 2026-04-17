#!/bin/bash

# openAIDE CLI — claude-code 终端交互 + 多模型路由
# 直接进入 claude-code 原生终端 REPL，通过 fetch 拦截实现多模型路由
#
# 用法: ./scripts/cli-cc.sh [选项]
#   --model <name>   指定模型（默认 glm-5.1）
#   --help           显示帮助信息
#
# 环境变量：
#   GLM_API_KEY          智谱 GLM API Key
#   OPENAIDE_MODEL       模型名称（默认 glm-5.1）
#   OPENAIDE_API_KEY     统一 API Key（优先级最高）
#   OPENAIDE_BASE_URL    统一 API Base URL
#   ANTHROPIC_API_KEY    Anthropic API Key
#   DEEPSEEK_API_KEY     DeepSeek API Key
#   DASHSCOPE_API_KEY    通义千问 API Key
#   OPENAI_API_KEY       OpenAI API Key

set -e

# 项目根目录
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE_CODE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/claude-code"

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
debug() { echo -e "${CYAN}[CC-CLI]${NC} $1"; }

# 默认模型
DEFAULT_MODEL="glm-5.1"

# 解析参数
while [[ $# -gt 0 ]]; do
  case $1 in
    --model)
      export OPENAIDE_MODEL="$2"
      shift 2
      ;;
    --help|-h)
      echo -e "${BOLD}openAIDE CLI — claude-code 终端交互 + 多模型路由${NC}"
      echo ""
      echo "用法: ./scripts/cli-cc.sh [选项]"
      echo "  --model <name>   指定模型（默认 $DEFAULT_MODEL）"
      echo "  --help, -h       显示帮助"
      echo ""
      echo "示例："
      echo "  ./scripts/cli-cc.sh                              # 使用 GLM-5.1"
      echo "  ./scripts/cli-cc.sh --model deepseek-chat        # 使用 DeepSeek"
      echo "  ./scripts/cli-cc.sh --model claude-sonnet-4-6    # 使用 Claude"
      echo ""
      echo "支持的模型:"
      echo "  glm-5.1               智谱 GLM (默认, 需要 GLM_API_KEY)"
      echo "  deepseek-chat         DeepSeek (需要 DEEPSEEK_API_KEY)"
      echo "  claude-sonnet-4-6     Anthropic Claude (需要 ANTHROPIC_API_KEY)"
      echo "  qwen-plus             通义千问 (需要 DASHSCOPE_API_KEY)"
      echo "  gpt-4o                OpenAI (需要 OPENAI_API_KEY)"
      echo "  ollama/llama3         Ollama 本地模型 (无需 Key)"
      echo ""
      echo "环境变量:"
      echo "  GLM_API_KEY          智谱 GLM API Key"
      echo "  OPENAIDE_MODEL       模型名称（覆盖 --model 参数）"
      echo "  OPENAIDE_API_KEY     统一 API Key（优先级最高）"
      echo "  OPENAIDE_BASE_URL    统一 API Base URL"
      echo "  ANTHROPIC_API_KEY    Anthropic API Key"
      echo "  DEEPSEEK_API_KEY     DeepSeek API Key"
      echo "  DASHSCOPE_API_KEY    通义千问 API Key"
      echo "  OPENAI_API_KEY       OpenAI API Key"
      echo ""
      echo "相关脚本:"
      echo "  ./scripts/cli.sh           openaide-ui Core CLI"
      echo "  ./scripts/dev-ts.sh        TS 引擎开发 (VS Code)"
      echo "  ./scripts/dev-core.sh      Core 独立启动 (stdio)"
      echo "  ./scripts/dev-rust.sh      Rust 引擎开发 (VS Code)"
      exit 0
      ;;
    *)
      warn "未知参数: $1"
      shift
      ;;
  esac
done

# 设置默认模型
if [ -z "$OPENAIDE_MODEL" ]; then
  export OPENAIDE_MODEL="$DEFAULT_MODEL"
fi

# ========== 环境检查 ==========
info "检查环境..."

# claude-code 目录
if [ ! -d "$CLAUDE_CODE_DIR" ]; then
  error "claude-code 目录不存在: $CLAUDE_CODE_DIR"
fi
info "claude-code: $CLAUDE_CODE_DIR"

# cli.tsx 入口
if [ ! -f "$CLAUDE_CODE_DIR/src/entrypoints/cli.tsx" ]; then
  error "CLI 入口不存在: $CLAUDE_CODE_DIR/src/entrypoints/cli.tsx"
fi

# tsx
if ! command -v tsx &>/dev/null; then
  error "未找到 tsx，请安装: pnpm add -g tsx"
fi
info "tsx: $(tsx --version 2>/dev/null || echo 'available')"

# API Key 检查
echo ""
info "API Key 状态:"
HAS_KEY=false

if [ -n "$OPENAIDE_API_KEY" ]; then
  info "  OPENAIDE_API_KEY: ${OPENAIDE_API_KEY:0:8}...${OPENAIDE_API_KEY: -4}"
  HAS_KEY=true
fi

# 根据模型检查对应的 Key
case "$OPENAIDE_MODEL" in
  glm-*)
    if [ -n "$GLM_API_KEY" ]; then
      info "  GLM_API_KEY: ${GLM_API_KEY:0:8}...${GLM_API_KEY: -4}"
      HAS_KEY=true
    else
      warn "  GLM_API_KEY 未设置（当前模型: $OPENAIDE_MODEL）"
      warn "  设置方法: export GLM_API_KEY='xxx.xxx'"
    fi
    ;;
  deepseek-*)
    if [ -n "$DEEPSEEK_API_KEY" ]; then
      info "  DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY:0:8}...${DEEPSEEK_API_KEY: -4}"
      HAS_KEY=true
    else
      warn "  DEEPSEEK_API_KEY 未设置（当前模型: $OPENAIDE_MODEL）"
      warn "  设置方法: export DEEPSEEK_API_KEY='sk-xxx'"
    fi
    ;;
  claude-*|sonnet|opus|haiku)
    if [ -n "$ANTHROPIC_API_KEY" ]; then
      info "  ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:0:8}...${ANTHROPIC_API_KEY: -4}"
      HAS_KEY=true
    else
      warn "  ANTHROPIC_API_KEY 未设置（当前模型: $OPENAIDE_MODEL）"
      warn "  设置方法: export ANTHROPIC_API_KEY='sk-ant-xxx'"
    fi
    ;;
  qwen-*)
    if [ -n "$DASHSCOPE_API_KEY" ]; then
      info "  DASHSCOPE_API_KEY: ${DASHSCOPE_API_KEY:0:8}...${DASHSCOPE_API_KEY: -4}"
      HAS_KEY=true
    else
      warn "  DASHSCOPE_API_KEY 未设置（当前模型: $OPENAIDE_MODEL）"
      warn "  设置方法: export DASHSCOPE_API_KEY='sk-xxx'"
    fi
    ;;
  gpt-*|o1-*|o3-*|o4-*)
    if [ -n "$OPENAI_API_KEY" ]; then
      info "  OPENAI_API_KEY: ${OPENAI_API_KEY:0:8}...${OPENAI_API_KEY: -4}"
      HAS_KEY=true
    else
      warn "  OPENAI_API_KEY 未设置（当前模型: $OPENAIDE_MODEL）"
      warn "  设置方法: export OPENAI_API_KEY='sk-xxx'"
    fi
    ;;
  ollama/*)
    info "  Ollama 本地模型，无需 API Key"
    HAS_KEY=true
    ;;
  *)
    warn "  未知模型前缀: $OPENAIDE_MODEL，请确认 API Key 已设置"
    ;;
esac

if [ "$HAS_KEY" = false ]; then
  echo ""
  warn "⚠️  未设置任何 API Key，AI 对话将不可用"
  warn "   请先设置对应的 API Key 后再启动"
  warn "   例如: export GLM_API_KEY='xxx.xxx' && ./scripts/cli-cc.sh"
  exit 1
fi

# ========== 启动 claude-code CLI ==========
echo ""
info "🚀 启动 claude-code 终端交互（多模型路由）..."
info "模型: $OPENAIDE_MODEL"
echo ""
debug "通过 fetch 拦截器将 claude-code 接入多模型路由"
debug "进入终端 REPL，输入消息即可开始对话，按 Ctrl+C 退出"
debug "─────────────────────────────────────────"
echo ""

cd "$SCRIPT_DIR"

# 使用 tsx 直接运行 openAIDE CLI 入口（终端交互 + 多模型路由）
# 不走 cli.tsx（它依赖 bun:bundle，Node.js/tsx 无法识别）
# 直接运行 cli-openaide.tsx，它会注册 bun:bundle mock 并启动终端 REPL
if command -v tsx &>/dev/null; then
  info "使用 tsx 运行 openAIDE CLI..."
  exec tsx --tsconfig "$CLAUDE_CODE_DIR/tsconfig.json" "$CLAUDE_CODE_DIR/src/bridge-adapter/cli-openaide.tsx"
fi

# 回退到 npx tsx
if npx --no-install tsx --version &>/dev/null 2>&1; then
  info "使用 npx tsx 运行 openAIDE CLI..."
  exec npx tsx --tsconfig "$CLAUDE_CODE_DIR/tsconfig.json" "$CLAUDE_CODE_DIR/src/bridge-adapter/cli-openaide.tsx"
fi

error "未找到可用的运行方式。请安装 tsx: pnpm add -g tsx"