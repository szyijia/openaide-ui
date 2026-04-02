# OpenAIDE 图标资源说明

## 概述

OpenAIDE 需要为 macOS、Linux、Windows 以及 Web/Server 四个平台提供不同格式和尺寸的图标。
项目提供了一键生成脚本 `generate-icons.sh`，可从单个 SVG 或 PNG 源文件自动生成所有平台所需的图标文件。

## 快速使用

```bash
# 从 SVG 生成（推荐，矢量无损缩放）
./scripts/generate-icons.sh assets/logo.svg

# 从 PNG 生成（建议源图片不小于 1024x1024）
./scripts/generate-icons.sh /path/to/icon.png
```

生成的图标会自动输出到 `packages/ide/resources/` 目录下，构建 IDE 时 `build.sh` 会自动使用这些图标。

## 依赖工具

| 工具 | 用途 | 安装方式 |
|------|------|----------|
| `rsvg-convert` | SVG 转 PNG 渲染 | `brew install librsvg` |
| `iconutil` | PNG 转 macOS `.icns` | macOS 系统自带 |
| `magick` / `convert` | 生成 `.ico`、`.bmp` 等格式 | `brew install imagemagick` |

> 注意：如果源文件是 PNG 格式，则不需要 `rsvg-convert`。

## 输出文件清单

所有文件输出到 `packages/ide/resources/` 目录：

```
packages/ide/resources/
├── icon.svg                    # 通用 SVG 图标
├── darwin/
│   └── code.icns               # macOS 应用图标
├── linux/
│   ├── code.png                # Linux PNG 图标 (256x256)
│   └── code.svg                # Linux SVG 图标
├── win32/
│   ├── code.ico                # Windows 应用图标 (多尺寸)
│   ├── code_70x70.png          # Windows 磁贴小图标
│   ├── code_150x150.png        # Windows 磁贴大图标
│   ├── inno-big-{100~250}.bmp  # Inno Setup 安装向导左侧大图 (7个DPI版本)
│   └── inno-small-{100~250}.bmp # Inno Setup 安装向导右上角小图 (7个DPI版本)
└── server/
    ├── code-192.png            # Web 图标 (192x192)
    ├── code-512.png            # Web 图标 (512x512)
    └── favicon.ico             # 网页 Favicon (16+32+48)
```

## 各平台图标规格

### macOS (`darwin/code.icns`)

macOS `.icns` 文件包含以下尺寸（含 Retina @2x 版本）：

| 文件名 | 尺寸 | 说明 |
|--------|------|------|
| `icon_16x16.png` | 16×16 | 标准 |
| `icon_16x16@2x.png` | 32×32 | Retina |
| `icon_32x32.png` | 32×32 | 标准 |
| `icon_32x32@2x.png` | 64×64 | Retina |
| `icon_128x128.png` | 128×128 | 标准 |
| `icon_128x128@2x.png` | 256×256 | Retina |
| `icon_256x256.png` | 256×256 | 标准 |
| `icon_256x256@2x.png` | 512×512 | Retina |
| `icon_512x512.png` | 512×512 | 标准 |
| `icon_512x512@2x.png` | 1024×1024 | Retina |

通过 `iconutil -c icns` 打包为单个 `.icns` 文件。

### Linux (`linux/`)

| 文件 | 尺寸 | 格式 | 说明 |
|------|------|------|------|
| `code.png` | 256×256 | PNG | 桌面环境应用图标 |
| `code.svg` | 矢量 | SVG | 桌面环境矢量图标（仅 SVG 源文件时生成） |

### Windows (`win32/`)

#### 应用图标 (`code.ico`)

`.ico` 文件内嵌以下尺寸：

| 尺寸 | 用途 |
|------|------|
| 16×16 | 标题栏、任务栏小图标 |
| 32×32 | 桌面图标（标准 DPI） |
| 48×48 | 资源管理器中等图标 |
| 64×64 | 资源管理器大图标 |
| 128×128 | 高 DPI 显示 |
| 256×256 | 超大图标视图 |

#### 磁贴图标

| 文件 | 尺寸 | 用途 |
|------|------|------|
| `code_70x70.png` | 70×70 | Windows 开始菜单小磁贴 |
| `code_150x150.png` | 150×150 | Windows 开始菜单中磁贴 |

#### Inno Setup 安装程序图标

安装向导需要不同 DPI 缩放比例的 BMP 图标（白色背景，图标居中）：

**inno-big（安装向导左侧竖长图）：**

| 文件 | 尺寸 | DPI 缩放 |
|------|------|----------|
| `inno-big-100.bmp` | 164×314 | 100% |
| `inno-big-125.bmp` | 192×386 | 125% |
| `inno-big-150.bmp` | 246×459 | 150% |
| `inno-big-175.bmp` | 273×556 | 175% |
| `inno-big-200.bmp` | 328×604 | 200% |
| `inno-big-225.bmp` | 355×700 | 225% |
| `inno-big-250.bmp` | 410×797 | 250% |

**inno-small（安装向导右上角小图标）：**

| 文件 | 尺寸 | DPI 缩放 |
|------|------|----------|
| `inno-small-100.bmp` | 55×55 | 100% |
| `inno-small-125.bmp` | 64×68 | 125% |
| `inno-small-150.bmp` | 83×80 | 150% |
| `inno-small-175.bmp` | 92×97 | 175% |
| `inno-small-200.bmp` | 110×106 | 200% |
| `inno-small-225.bmp` | 119×123 | 225% |
| `inno-small-250.bmp` | 138×140 | 250% |

### Server/Web (`server/`)

| 文件 | 尺寸 | 用途 |
|------|------|------|
| `code-192.png` | 192×192 | PWA 图标 / Web Manifest |
| `code-512.png` | 512×512 | PWA 启动画面图标 |
| `favicon.ico` | 16+32+48 | 浏览器标签页 Favicon |

## 构建集成

`packages/ide/build.sh` 中的 `apply_branding` 函数会在构建时自动将 `packages/ide/resources/` 下的图标复制到 VSCodium 的对应目录中，覆盖默认图标。无需手动操作。

## 更换图标

如需更换 OpenAIDE 的图标，只需：

1. 准备新的 SVG 或 PNG 源文件（推荐 SVG，PNG 建议不小于 1024×1024）
2. 运行脚本重新生成：
   ```bash
   ./scripts/generate-icons.sh path/to/new-icon.svg
   ```
3. 重新构建 IDE：
   ```bash
   ./scripts/build-desktop.sh
   ```
