# AGENTS.md

## 1. 项目概述

本项目名为 `mainline-tool`，是一个用于 **GMS / Mainline 资源包与本地项目进行差异扫描、风险识别、人工判定和自动合入** 的桌面式 Web 工具。

它不是传统的线上业务系统，而是一个偏内部效率工具，核心目标是：

- 读取一个“待合入资源包目录”；
- 对照一个“当前本地项目目录”；
- 扫描所有文件差异；
- 判断哪些文件可以自动合入，哪些文件必须人工确认；
- 在页面中查看左右对比、编辑本地内容、查看 Git 历史；
- 最终批量或按分组执行合入。

从界面文案和逻辑判断，这个工具主要服务于 Android / GMS / Mainline 资源包合入场景。

## 2. 当前目录现状

当前工作目录：`/home/wsl/Work_space/mainline-tool`

目录内关键文件如下：

- `package.json`：项目依赖与脚本定义
- `package-lock.json`：锁定依赖版本
- `vite.config.js`：Vite 配置，包含 `/api` 代理
- `server.js`：Node.js + Express 后端，承担扫描、比较、读取、保存、合入等核心逻辑
- `src/App.jsx`：前端主界面和主要交互逻辑
- `src/main.jsx`：React 入口
- `src/index.css`：Tailwind v4 入口，仅包含 `@import "tailwindcss";`
- `index.html`：页面入口，标题为“Mainline 自动合入助手”
- `mainline-tool.config.json`：本地配置文件，保存扫描路径和手动状态
- `mainline-tool.config.example.json`：示例配置文件，用于新环境初始化参考
- `start-mainline-tool.sh/.cmd`：启动脚本
- `stop-mainline-tool.sh/.cmd`：停止脚本
- `restart-mainline-tool.sh/.cmd`：重启脚本
- `使用文档.txt`：较早期的搭建说明

补充观察：

- 当前目录 **已经初始化为 Git 仓库**
- 项目内已补充 `.gitignore`
- `node_modules/`、`dist/`、`.vite/` 属于本地依赖/构建产物，不应纳入版本控制
- `mainline-tool.config.json` 属于本机配置，已建议改为仅本地保留，不纳入版本控制

## 3. 技术栈

### 前端

- React 19
- React DOM 19
- Vite 6
- Tailwind CSS 4
- `@tailwindcss/vite`
- `lucide-react` 图标库

### 后端

- Node.js
- Express 5
- `cors`
- `fs-extra`

### 运行模式

这是一个 **前后端分离但同仓开发** 的工具：

- 前端开发服务默认端口：`5173`
- 后端服务默认端口：`3001`
- 前端通过 Vite 代理把 `/api` 请求转发到 `http://localhost:3001`

## 4. package.json 信息

`package.json` 中定义的脚本：

- `npm run dev`：启动前端 Vite 开发服务
- `npm run build`：构建前端
- `npm run preview`：预览前端构建结果
- `npm run server`：启动后端 `server.js`

依赖版本概况：

- `express`: `^5.1.0`
- `react`: `^19.1.0`
- `react-dom`: `^19.1.0`
- `lucide-react`: `^0.511.0`
- `fs-extra`: `^11.3.2`
- `cors`: `^2.8.5`
- `vite`: `^6.3.5`
- `tailwindcss`: `^4.1.5`
- `@tailwindcss/vite`: `^4.1.5`
- `@vitejs/plugin-react`: `^4.4.1`

## 5. 项目核心业务模型

项目围绕两个目录工作：

- `sourceDir`：待合入资源包目录
- `projectDir`：当前本地项目目录

扫描流程大致如下：

1. 递归读取 `sourceDir` 下所有文件
2. 按相对路径映射到 `projectDir`
3. 判断目标文件是否存在
4. 对文本、二进制、归档文件分别采用不同策略比较
5. 给每个文件打状态：
   - `same`：内容一致，无需处理
   - `update`：可自动合入
   - `danger`：存在风险，需人工确认
6. 在前端展示列表、分组、对比视图和操作按钮

## 6. 前端能力总结

前端主文件为 `src/App.jsx`，页面是一个单页应用，主要能力如下：

- 首次加载时读取配置并自动扫描
- 左侧展示差异文件列表
- 按扩展名分组展示文件
- 支持按状态筛选：
  - 全部
  - 人工接入（`danger`）
  - 可合入（`update`）
- 支持按路径搜索
- 支持打开多个文件标签页
- 支持左右双栏对比：
  - 右侧：待合入资源包
  - 左侧：当前本地项目
- 支持滚动同步
- 支持差异导航条跳转
- 支持放大查看模式
- 大文件时自动切换轻量对比模式
- 检测到 GMS 痕迹时可切换为“修改痕迹聚焦模式”
- 对满足条件的文本文件支持直接编辑本地内容
- 支持查看目标文件 Git 历史和单次提交详情
- 支持将文件手动标记为：
  - `danger`
  - `update`
- 支持批量合入全部 Ready 文件
- 支持按扩展名分组合入

界面标题为：`GMS资源 自动合入助手`

## 7. 后端能力总结

后端主文件为 `server.js`，它是整个工具的核心逻辑层。

### 7.1 配置管理

配置文件路径固定为：

- `mainline-tool.config.json`

若文件不存在，后端会自动创建默认配置。

配置结构：

```json
{
  "sourceDir": "待合入资源包路径",
  "projectDir": "当前本地项目路径",
  "manualStatuses": {
    "相对路径": "danger 或 update"
  }
}
```

### 7.2 文件扫描与比较

后端会递归扫描 `sourceDir` 下文件，并结合以下规则生成摘要：

- 文本文件：
  - 若任一侧包含 GMS 修改痕迹，则标记 `danger`
  - 若内容一致，则标记 `same`
  - 否则标记 `update`
- 二进制文件：
  - 一致则 `same`
  - 不一致通常为 `update` 或特定情况 `danger`
- `.apk` / `.apks`：
  - 会尝试解析版本信息
  - 若资源版本明确高于本地，则允许自动合入
  - 若版本无法解析或存在回退/不明确，则标记 `danger`
- `.srcjar`：
  - 可展开为文本内容进行查看
- `.apk` / `.apks` / `.apex` / `.jar`：
  - 可列出归档内部条目用于预览

### 7.3 GMS 风险规则

后端定义了 GMS 痕迹匹配规则，命中以下关键词会阻止自动覆盖：

- `//[GMS][数字]`
- `begin-->`
- `end-->`
- `redmine`
- `Redmine`
- `[GMS]`

只要资源文件或本地文件命中这些痕迹，就会优先判为 `danger`。

### 7.4 文本/二进制判断逻辑

后端维护了大量文本扩展名白名单，例如：

- `.xml`
- `.txt`
- `.json`
- `.java`
- `.kt`
- `.js`
- `.ts`
- `.jsx`
- `.tsx`
- `.mk`
- `.bp`
- `.gradle`
- `.py`
- `.sh`
- `.yaml`
- `.go`
- `.rs`

以及二进制扩展名，如：

- `.apk`
- `.apex`
- `.jar`
- `.so`
- `.bin`
- `.img`

若扩展名不明确，会读取文件头做启发式判断。

### 7.5 Git 相关能力

后端支持对 `projectDir` 中对应文件读取 Git 历史：

- 获取文件提交列表
- 获取指定提交详情
- 获取 patch / diff 内容
- 获取仓库 remote URL

注意：

- 这里要求 `projectDir` 本身处于 Git 仓库中
- 当前 `mainline-tool` 项目自身不是 Git 仓库，但它要分析的目标项目通常应当是

### 7.6 页面内编辑能力

后端提供保存接口，可将前端修改后的本地目标文件直接写回 `projectDir`。

限制条件：

- 只允许文本文件
- 不允许 `.srcjar`
- 目标目录不存在时会自动创建目录

### 7.7 自动合入能力

自动合入本质上是把 `sourceDir` 中的文件复制到 `projectDir`，但前置了较严格的跳过逻辑：

- 路径非法则跳过
- 源文件不存在则跳过
- 内容一致则跳过
- `.apk` / `.apks` 版本信息不安全则跳过
- 资源或本地文本含 GMS 痕迹则跳过

合入成功后会返回日志列表。

## 8. 后端 API 清单

从 `server.js` 可确认的接口如下：

- `GET /api/config`
  - 读取当前配置
- `POST /api/config`
  - 保存 `sourceDir` 和 `projectDir`
- `POST /api/status-override`
  - 手动覆盖某个文件状态为 `danger` / `update` / `null`
- `POST /api/status-override/reset`
  - 重置全部手动状态
- `GET /api/scan`
  - 扫描资源包与项目目录差异
  - 支持 `reset_manual=1`
- `GET /api/file-content`
  - 获取某个文件的完整可比对内容
- `GET /api/git-history`
  - 获取文件 Git 历史
- `GET /api/git-history/detail`
  - 获取某次提交详情
- `POST /api/file-content/save`
  - 保存页面编辑后的目标文件内容
- `POST /api/merge`
  - 批量执行自动合入

## 9. 当前配置文件状态

当前 `mainline-tool.config.json` 内容显示：

- `sourceDir`：
  `/home/wsl/Work_space/gms-oem-V-15-202604/`
- `projectDir`：
  `/home/wsl/Work_space/MTK_V/alps-release-v0.mp1.rc-default/alps/vendor/`

当前已有 4 个文件被手动标记为 `danger`，均位于：

- `partner_gms/apps/AndroidSystemIntelligence/`

文件名分别是：

- `AndroidSystemIntelligence_Features_arm.apk`
- `AndroidSystemIntelligence_Features_arm64.apk`
- `AndroidSystemIntelligence_Infrastructure_arm.apk`
- `AndroidSystemIntelligence_Infrastructure_arm64.apk`

## 10. 启动与停止方式

### Linux / WSL 脚本

- `start-mainline-tool.sh`
  - 后台启动后端日志到 `/tmp/mainline-tool-backend.log`
  - 后台启动前端日志到 `/tmp/mainline-tool-frontend.log`
- `stop-mainline-tool.sh`
  - 通过 `pgrep` + `kill` 停止包含项目路径的 `vite` / `server.js` 进程
- `restart-mainline-tool.sh`
  - 先停再启

### Windows `.cmd` 脚本

通过 `wsl.exe bash -lc ...` 调用 WSL 内项目目录完成启动/停止。

Windows 启动脚本会提示：

- 后端通常在 `http://localhost:3001`
- 前端通常在 `http://localhost:5173`

## 11. 外部命令与环境依赖

这个项目除了 Node 依赖，还依赖系统环境中若干命令：

- `git`
  - 用于读取目标项目文件历史
- `unzip`
  - 用于读取归档内容和 `.apks` / `.srcjar`
- `aapt`
  - 用于解析 APK badging 信息
- `pgrep`
  - 启停脚本中使用
- `kill`
  - 启停脚本中使用

因此仅安装 `npm` 依赖并不足以覆盖全部功能，若缺少 `git` / `unzip` / `aapt`，部分能力会失效。

## 12. 文件类型处理策略

项目对不同文件类型的处理方式不同：

- 普通文本文件：
  - 可直接做全文对比
  - 在满足条件时可编辑本地内容
- 二进制文件：
  - 可展示十六进制预览
- 归档文件：
  - 可展示内部条目列表
- `.srcjar`：
  - 会将归档内部可识别文本文件拼接后展示
- `.apk` / `.apks`：
  - 除差异外，还会尝试比较版本号和 SDK 信息

## 13. 前端实现特点

从 `src/App.jsx` 可以看出，前端已做了不少针对大文件和复杂差异的体验优化：

- 自定义 diff 行合并逻辑
- 行内差异高亮
- 大文件轻量模式
- 超长列表虚拟滚动
- 左右面板滚动同步
- 差异缩略导航条
- 打开文件标签管理
- 全屏对比浮层
- Git 提交详情预览

这说明项目已经超出“简单文件列表工具”，更接近一个专用的合入工作台。

## 14. Git 仓库整理状态

当前仓库整理策略如下：

- 应纳入 Git：
  - 源码
  - 启停脚本
  - `package.json`
  - `package-lock.json`
  - `AGENTS.md`
  - `使用文档.txt`
  - `mainline-tool.config.example.json`
- 不纳入 Git：
  - `node_modules/`
  - `dist/`
  - `.vite/`
  - `mainline-tool.config.json`
  - `.codex`

## 15. 已知限制与注意事项

- 当前项目没有 README，知识主要分散在源码和 `使用文档.txt`
- `server.js` 代码量较大，前后端职责比较集中，后端核心逻辑尚未拆模块
- `src/App.jsx` 也是大文件，UI、状态管理、diff 算法和交互耦合较高
- 许多关键能力直接依赖本地绝对路径和本机工具链，更像“本地专用工具”而不是可直接分发的通用产品
- Vite watch 特别忽略了 `mainline-tool.config.json`，避免改配置时触发前端热更新噪音

## 16. `使用文档.txt` 的定位

`使用文档.txt` 更像项目早期的搭建备忘录，主要说明：

- 这是 React + Vite + Tailwind + Node/Express 的项目
- 如何创建项目
- 如何配置 Tailwind v4
- 如何启动前端和后端

它提供了一些历史背景，但内容并不等同于当前完整实现说明。

## 17. 对后续维护者/Agent 的建议

如果后续要继续维护本项目，建议优先掌握以下入口：

1. 先看 `server.js`
   - 这里决定扫描规则、状态判定、合入限制和文件读取策略
2. 再看 `src/App.jsx`
   - 这里决定页面交互、对比逻辑、编辑流和 Git 历史展示
3. 看 `mainline-tool.config.json`
   - 了解当前实际使用的资源目录与项目目录
4. 看启动脚本
   - 了解真实运行方式是否依赖 WSL / 本地终端

若后续要改造项目，优先级建议如下：

- 拆分 `server.js` 为配置、扫描、Git、归档、合入等模块
- 拆分 `src/App.jsx` 为 sidebar、diff viewer、history modal、config form 等组件
- 增加 README
- 增加 `.gitignore`
- 将路径和环境依赖说明补齐
- 如没有特殊要求，修改的时候不破坏原有的样式