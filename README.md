# Magpie 鲸鲸余额挂件

一个常驻桌面的悬浮挂件，实时显示 [Magpie](https://usemagpie.ai) 本机网关里各供应商的余额与用量。
它只**读取**本机 Magpie 的缓存接口（`/v1/magpie/quotas` 与 `/v1/magpie/usage`），不拦截、不代理你的请求。

## 功能

- **桌面气泡**：右下角常驻一只小鲸，实时显示当前供应商余额；点击展开详情（用量、重置时间、本次费用等）。
- **多供应商**：左键点击详情可切换供应商；中键点击气泡可临时切到下一个供应商，松手后自动回到「跟随正在使用的 API」。
- **币种 / 汇率**：可对**每个供应商**单独指定它实际计费用的是人民币还是美元。
  - 指定 **人民币 (¥)**：余额数值原样以 `¥` 显示；
  - 指定 **美元 ($)**：数值当作美元，按你填的汇率换算成人民币，仍以 `¥` 显示。
  - 详情页右上角、刷新按钮左侧有一个 `¥` / `$` 小图标显示当前供应商的币种：**左键切换**人民币/美元，**右键**手动输入/更新美元兑人民币汇率（不联网，纯手动）。
  - 各供应商的币种与汇率各自独立保存，互不影响。

## 下载与使用

到 [Releases](https://github.com/BBBBBSM/magpie-balance-bubble/releases) 下载 `Magpie-Whale-Bubble-*-portable.exe`（免安装绿色版），双击即可运行。

前置条件：本机已在运行 Magpie，且其网关地址可访问（默认 `http://127.0.0.1:3425`，可用环境变量 `MAGPIE_GATEWAY` 覆盖）。

## 从源码运行

```sh
npm install
npm start
```

## 从源码打包

```sh
npm run dist
```

生成的绿色版 `.exe` 在 `dist/` 目录。

## 图像素材来源

本项目的角色图像素材（`assets/icon.png`、`assets/tray.png`、`assets/role.png` 等）复用自 **dsh-whale-widget**（作者 MeteorNOX），按其 MIT 许可使用，原始许可见 `assets/LICENSE-dsh-whale-widget`。

## 许可证

本项目代码以 MIT 许可发布；复用的图像素材遵循其原始 MIT 许可（Copyright © 2026 MeteorNOX）。