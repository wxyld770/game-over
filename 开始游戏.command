#!/bin/zsh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "需要先安装 Node.js 18 或更新版本。"
  read -r "?按回车键关闭窗口…"
  exit 1
fi
OPEN_BROWSER=1 npm start
