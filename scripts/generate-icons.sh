#!/usr/bin/env bash
#
# generate-icons.sh — 从 SVG 或 PNG 源文件生成三个平台的图标资源
#
# 用法:
#   ./scripts/generate-icons.sh <源图片路径>
#   ./scripts/generate-icons.sh assets/logo.svg
#   ./scripts/generate-icons.sh /path/to/icon.png
#
# 支持的输入格式: SVG, PNG
# 输出目录: packages/ide/resources/{darwin,linux,win32}
#
# 依赖:
#   - rsvg-convert (librsvg)  — SVG 转 PNG
#   - iconutil                — PNG 转 icns (macOS 自带)
#   - magick (ImageMagick 7+) — 生成 ico/bmp 等格式
#
# macOS 安装依赖: brew install librsvg imagemagick
#

set -euo pipefail

# ─── 颜色输出 ───

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $*"; }

# ─── 路径设置 ───

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RESOURCES_DIR="$ROOT_DIR/packages/ide/resources"
TMPDIR_ICONS="$(mktemp -d)"

cleanup() {
  rm -rf "$TMPDIR_ICONS"
}
trap cleanup EXIT

# ─── 参数检查 ───

if [ $# -lt 1 ]; then
  echo "用法: $0 <源图片路径 (SVG 或 PNG)>"
  echo ""
  echo "示例:"
  echo "  $0 assets/logo.svg"
  echo "  $0 /path/to/icon.png"
  exit 1
fi

SOURCE_FILE="$1"

# 支持相对路径
if [[ ! "$SOURCE_FILE" = /* ]]; then
  SOURCE_FILE="$ROOT_DIR/$SOURCE_FILE"
fi

if [ ! -f "$SOURCE_FILE" ]; then
  log_error "源文件不存在: $SOURCE_FILE"
  exit 1
fi

# 检测文件类型
FILE_EXT="${SOURCE_FILE##*.}"
FILE_EXT=$(echo "$FILE_EXT" | tr '[:upper:]' '[:lower:]')

if [[ "$FILE_EXT" != "svg" && "$FILE_EXT" != "png" ]]; then
  log_error "不支持的文件格式: .$FILE_EXT (仅支持 SVG 和 PNG)"
  exit 1
fi

log_info "源文件: $SOURCE_FILE (格式: $FILE_EXT)"

# ─── 依赖检查 ───

check_deps() {
  local missing=()

  if [[ "$FILE_EXT" == "svg" ]]; then
    command -v rsvg-convert >/dev/null 2>&1 || missing+=("rsvg-convert (brew install librsvg)")
  fi

  command -v iconutil >/dev/null 2>&1 || missing+=("iconutil (macOS 自带)")

  # ImageMagick 7 (magick) 或 6 (convert)
  if ! command -v magick >/dev/null 2>&1 && ! command -v convert >/dev/null 2>&1; then
    missing+=("imagemagick (brew install imagemagick)")
  fi

  if [ ${#missing[@]} -gt 0 ]; then
    log_error "缺少以下依赖:"
    for dep in "${missing[@]}"; do
      echo "  - $dep"
    done
    exit 1
  fi
}

check_deps

# ─── 工具函数 ───

# 从源文件生成指定尺寸的 PNG
render_png() {
  local size=$1
  local output=$2

  if [[ "$FILE_EXT" == "svg" ]]; then
    rsvg-convert -w "$size" -h "$size" "$SOURCE_FILE" -o "$output"
  else
    # PNG 输入，用 ImageMagick 缩放
    im_convert "$SOURCE_FILE" -resize "${size}x${size}" "$output"
  fi
}

# 兼容 ImageMagick 6/7 的 convert 命令
im_convert() {
  if command -v magick >/dev/null 2>&1; then
    magick "$@"
  else
    convert "$@"
  fi
}

# ─── 生成 macOS 图标 (.icns) ───

generate_darwin() {
  log_info "生成 macOS 图标..."

  local iconset="$TMPDIR_ICONS/icon.iconset"
  mkdir -p "$iconset"

  # macOS iconset 标准尺寸
  local sizes=(16 32 128 256 512)
  for size in "${sizes[@]}"; do
    render_png "$size" "$iconset/icon_${size}x${size}.png"
    # @2x 版本 (Retina)
    local double=$((size * 2))
    render_png "$double" "$iconset/icon_${size}x${size}@2x.png"
  done

  # 生成 .icns
  local output_dir="$RESOURCES_DIR/darwin"
  mkdir -p "$output_dir"
  iconutil -c icns "$iconset" -o "$output_dir/code.icns"

  log_success "macOS 图标: $output_dir/code.icns"
}

# ─── 生成 Linux 图标 (.png + .svg) ───

generate_linux() {
  log_info "生成 Linux 图标..."

  local output_dir="$RESOURCES_DIR/linux"
  mkdir -p "$output_dir"

  # 256x256 PNG
  render_png 256 "$output_dir/code.png"

  # SVG (如果源文件是 SVG 则直接复制，否则跳过)
  if [[ "$FILE_EXT" == "svg" ]]; then
    cp "$SOURCE_FILE" "$output_dir/code.svg"
    log_success "Linux 图标: $output_dir/code.png, $output_dir/code.svg"
  else
    log_success "Linux 图标: $output_dir/code.png"
    log_warn "源文件非 SVG，跳过 Linux SVG 图标生成"
  fi
}

# ─── 生成 Windows 图标 (.ico + .png + .bmp) ───

generate_win32() {
  log_info "生成 Windows 图标..."

  local output_dir="$RESOURCES_DIR/win32"
  mkdir -p "$output_dir"

  # 1. 生成 code.ico (多尺寸)
  local ico_sizes=(16 32 48 64 128 256)
  local ico_inputs=()
  for size in "${ico_sizes[@]}"; do
    local tmp_png="$TMPDIR_ICONS/ico_${size}.png"
    render_png "$size" "$tmp_png"
    ico_inputs+=("$tmp_png")
  done
  im_convert "${ico_inputs[@]}" "$output_dir/code.ico"
  log_success "Windows ICO: $output_dir/code.ico"

  # 2. 生成磁贴图标
  render_png 70 "$output_dir/code_70x70.png"
  render_png 150 "$output_dir/code_150x150.png"
  log_success "Windows 磁贴: code_70x70.png, code_150x150.png"

  # 3. 生成 Inno Setup 安装向导 BMP 图标
  # inno-big: 安装向导左侧竖长图 (白色背景，图标居中)
  # 格式: "缩放比例 宽x高"
  local big_entries="100:164x314 125:192x386 150:246x459 175:273x556 200:328x604 225:355x700 250:410x797"
  for entry in $big_entries; do
    local scale=${entry%%:*}
    local size=${entry#*:}
    local w=${size%x*}
    local h=${size#*x}
    # 图标尺寸取宽高中较小值
    local icon_size=$((w < h ? w : h))
    local tmp_png="$TMPDIR_ICONS/inno_big_${scale}.png"
    render_png "$icon_size" "$tmp_png"
    im_convert "$tmp_png" -gravity center -background white -extent "${w}x${h}" "BMP3:$output_dir/inno-big-${scale}.bmp"
  done
  log_success "Windows Inno-big BMP: inno-big-{100..250}.bmp"

  # inno-small: 安装向导右上角小图标 (白色背景，图标居中)
  local small_entries="100:55x55 125:64x68 150:83x80 175:92x97 200:110x106 225:119x123 250:138x140"
  for entry in $small_entries; do
    local scale=${entry%%:*}
    local size=${entry#*:}
    local w=${size%x*}
    local h=${size#*x}
    local icon_size=$((w < h ? w : h))
    local tmp_png="$TMPDIR_ICONS/inno_small_${scale}.png"
    render_png "$icon_size" "$tmp_png"
    im_convert "$tmp_png" -gravity center -background white -extent "${w}x${h}" "BMP3:$output_dir/inno-small-${scale}.bmp"
  done
  log_success "Windows Inno-small BMP: inno-small-{100..250}.bmp"
}

# ─── 生成通用图标 (icon.svg) ───

generate_common() {
  log_info "生成通用图标..."

  if [[ "$FILE_EXT" == "svg" ]]; then
    cp "$SOURCE_FILE" "$RESOURCES_DIR/icon.svg"
    log_success "通用图标: $RESOURCES_DIR/icon.svg"
  else
    log_warn "源文件非 SVG，跳过通用 icon.svg 生成"
  fi
}

# ─── 生成 Web/Server 图标 ───

generate_server() {
  log_info "生成 Server 图标..."

  local output_dir="$RESOURCES_DIR/server"
  mkdir -p "$output_dir"

  render_png 192 "$output_dir/code-192.png"
  render_png 512 "$output_dir/code-512.png"

  # 生成 favicon.ico (16 + 32 + 48)
  local tmp16="$TMPDIR_ICONS/fav16.png"
  local tmp32="$TMPDIR_ICONS/fav32.png"
  local tmp48="$TMPDIR_ICONS/fav48.png"
  render_png 16 "$tmp16"
  render_png 32 "$tmp32"
  render_png 48 "$tmp48"
  im_convert "$tmp16" "$tmp32" "$tmp48" "$output_dir/favicon.ico"

  log_success "Server 图标: code-192.png, code-512.png, favicon.ico"
}

# ─── 主流程 ───

main() {
  echo ""
  echo "═══════════════════════════════════════════"
  echo "  OpenAIDE 图标生成工具"
  echo "═══════════════════════════════════════════"
  echo ""

  generate_common
  generate_darwin
  generate_linux
  generate_win32
  generate_server

  echo ""
  echo "═══════════════════════════════════════════"
  log_success "🎉 所有平台图标生成完成！"
  echo ""
  echo "输出目录: $RESOURCES_DIR/"
  echo ""
  echo "  icon.svg              — 通用 SVG 图标"
  echo "  darwin/code.icns      — macOS 应用图标"
  echo "  linux/code.png        — Linux PNG 图标"
  echo "  linux/code.svg        — Linux SVG 图标"
  echo "  win32/code.ico        — Windows 应用图标"
  echo "  win32/code_*.png      — Windows 磁贴图标"
  echo "  win32/inno-*.bmp      — Windows 安装程序图标"
  echo "  server/code-*.png     — Web/Server 图标"
  echo "  server/favicon.ico    — 网页 Favicon"
  echo ""
  echo "提示: 重新构建 IDE 时，build.sh 会自动使用这些图标。"
  echo "═══════════════════════════════════════════"
}

main
