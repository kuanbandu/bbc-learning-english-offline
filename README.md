# BBC 轻松英语 · 离线学习包

把 [BBC Learning English](https://www.bbc.co.uk/learningenglish) 的**音频 + 文稿**一次性抓到本机，做成一个**可以在手机上离线使用的 App**（PWA，也能打包成安卓 APK）。

默认覆盖 **41 个节目**（入门 / 中级 / 高级课程 + 首页精选的 6 Minute English、The English We Speak 等）。

抓完之后：手机上不需要联网、不需要访问 BBC、不消耗流量，坐地铁也能听。

> 仓库里只有**代码**，不含抓取产物。`content/`（音频与文稿）被 `.gitignore` 排除——版权归 BBC，请不要上传。克隆后自己跑 `npm run build` 即可生成。

---

## 一、你需要什么

| 项目 | 说明 |
| --- | --- |
| 电脑 | Windows / macOS / Linux 都行 |
| Node.js | ≥ 18（推荐 20+）。[下载](https://nodejs.org) |
| 网络 | **能打开 bbc.co.uk 的网络**。国内通常直连不通，请自行准备合规的代理 |
| 手机 | 与电脑连同一个 WiFi（仅安装时用一次） |

> 只有"抓取"这一步需要能访问 BBC。抓完生成的离线包，手机端**完全不需要联网**。

---

## 二、四步跑起来

### 第 1 步：配置代理（如果需要）

打开 `config.json`，把代理地址填进去（Node 24 原生支持，无需装任何东西）：

```json
"proxy": "http://127.0.0.1:7897"
```

本地代理是 **127.0.0.1**（回环地址），别写成 `172.0.0.1`。端口按你的客户端实际端口改（Clash 默认 7890、7897 等）。不需要代理就留空 `""`。

> 填错地址的表现是：curl 能通但脚本报 `fetch failed`。可用 `curl -x http://127.0.0.1:7897 -o nul -w "%{http_code}" https://www.bbc.co.uk/learningenglish/chinese/easy_course` 验证（返回 200 才对）。

### 第 2 步：先做一次诊断（强烈建议）

```bash
npm run probe
```

它会抓取目录页并打印解析结果，**同时把原始 HTML 存到 `.cache/dump/`**。

- 如果 `音频` 一栏显示了链接、 `文稿句数` 大于 0 → 解析成功，直接进第 3 步。
- 如果显示 `(未找到)` → 把 `.cache/dump/` 里的 HTML 发给我（或自行比对），我按真实结构调整 `src/lib/parse.mjs` 的规则。

也可以指定任意页面诊断：

```bash
npm run probe -- https://www.bbc.co.uk/learningenglish/chinese/features/real-easy-english
```

### 第 3 步：抓取课程（音频 + 文稿）

```bash
npm run courses     # 解析目录页，得到节目清单
npm run crawl       # 逐集抓取音频直链与文稿
npm run download    # 把音频下载到本机
```

默认从四个入口采集（可在 `config.json` 的 `startUrls` 里增删）：

| 入口 | 拿到的节目 |
| --- | --- |
| `/learningenglish` 首页精选 | **6 Minute English**、**The English We Speak**、**Learning English from the News**、Weather、The Reading Room、Beating Speaking Anxiety、Test Your Level |
| `/learningenglish/chinese/easy_course` | Real Easy English、London Challenge 系列、English in a Minute(emw)、Tenses/Prepositions with Georgie |
| `/learningenglish/hard_course` | Documentaries(Our World in English)、**The Listening Room**、Towards Advanced、English You Need、Shakespeare 习语、Work English（办公室英语/求职/商务）、Real life English（Small Talk / Bad Dates / British Chat）、English Stories |
| `/learningenglish/medium_course` | **Learning English Grammar（语法播客）**、**English in a Minute**、The Pronunciation Lounge、Phrasal/Conditionals with Georgie、The Grammar Gameshow、Ask BBC Learning English、Learners' Questions |

四个入口合计 **41 个节目**。同一节目出现在多个入口时会自动去重，不会重复抓取。想换范围直接改 `startUrls` 即可。

> **两类内容，抓取结果不同**：`features/` 下的播客（6 Minute English、The English We Speak 等）有可下载音频 + 完整文稿；`course/` 下的交互式课程（Towards Advanced、English You Need 等）**BBC 只提供文稿、没有可下载音频**，App 里会显示"无音频"，但仍可当精读材料看。这不是抓取失败。

想先试水再全量抓：

```bash
npm run crawl -- --limit=5          # 每个节目只抓 5 集
npm run crawl -- --series=real-easy-english
```

一步到位：

```bash
npm run build       # = courses + crawl + download
```

抓到一半中断没关系，**重跑会断点续传**（`content/state.json` 记录失败项，`content/audio/*.part` 是未下完的半截文件）。

### 先算一笔账：全量抓会很大

实测（Easy Courses，共 **8 个节目**）：

| 项目 | 实测值 |
| --- | --- |
| 6 Minute English（走 RSS） | 44 集 |
| Real Easy English（走 RSS） | 125 集 |
| 单集音频 | 约 5–12 MB |
| 走代理的下载速度 | 约 110 KB/s（一集约 60–110 秒） |

> 节目清单优先走 RSS（更全更稳），RSS 不可用时回退到解析页面列表。6 Minute English、Real Easy English 等都已在页脚暴露 RSS，会自动识别。

所以**强烈建议先小规模试水**：

```bash
npm run crawl -- --series=real-easy-english --limit=5
npm run download
npm run dist && npm run serve
```

确认在手机上能听、能看文稿，再决定要不要全量抓。`--limit` 提高后重跑，`crawl` 会保留已下载的记录，不会重复下载。

### 第 4 步：生成离线包并在手机上安装

```bash
npm start           # = 打包 + 启动本地服务器
```

终端会打印类似：

```
已启动：http://localhost:8080
手机与电脑连同一个 WiFi 时，用手机浏览器打开：
  http://192.168.1.23:8080
```

用手机浏览器打开那个 `192.168.x.x` 地址：

- **Android Chrome**：右上角菜单 → 「添加到主屏幕 / 安装应用」
- **iPhone Safari**：底部分享按钮 → 「添加到主屏幕」

桌面出现图标，点开就是全屏 App。**安装成功后就可以关掉电脑了**，所有内容已经在手机里。

> iPhone 首次打开时如果没看到内容，进入 App 后下拉刷新一次即可（Service Worker 需要几秒生效）。

---

## 三、App 里能做什么

- **课程目录**：按 BBC 官方的难度分组（Very Easy / Easy / Easy Grammar…），带完成进度条
- **播放器**：倍速 0.6×–2.0×、快退/快进 5 秒、A-B 循环（精听神器）、睡眠定时、自动连播
- **文稿**：逐句显示，点任意单词 → 加入生词本 / 朗读该句 / 复制；开启"跟随"播放时自动滚动
- **生词本**：自动记录出处句子，可导出 CSV 直接导入 Anki / 欧路词典
- **进度记忆**：听到哪记住哪，换手机不会丢（存在浏览器本地）
- **离线缓存**：设置页一键把所有音频写进手机缓存，之后断网也能听

---

## 四、命令一览

| 命令 | 作用 |
| --- | --- |
| `npm run probe` | 诊断单个页面能否解析出音频/文稿，并保存原始 HTML |
| `npm run courses` | 解析 Easy Courses 目录页 → `content/index.json` |
| `npm run crawl` | 抓每一集的音频直链与文稿 |
| `npm run download` | 下载音频文件（支持断点续传） |
| `npm run build` | 以上三步一次跑完 |
| `npm run dist` | 把 `app/` + `content/` 合成离线包 `dist/` |
| `npm run serve` | 启动本地服务器（支持音频拖动所需的 Range 请求） |
| `npm start` | `dist` + `serve` |
| **`npm run check`** | **自检：数据、音频文件、离线包是否真的可用（见下）** |
| `npm run clear-cache` | 清空 `.cache`（下次强制重新抓取，改了解析规则后用） |

`crawl` 支持的开关：`--limit=N`（每节目最多 N 集）、`--series=slug1,slug2`（只抓指定节目）。

### 怎么验证抓到的东西是真能用的

不用打开浏览器，一条命令：

```bash
npm run check
```

它会依次检查并给出中文结论（有问题时退出码为 1）：

| 检查项 | 说明 |
| --- | --- |
| 0. 环境 | Node 版本、代理是否配置、HTML 缓存数量 |
| 1. 抓取数据 | 课程/节目/单集各有多少 |
| 2. 单集字段 | 有多少集拿到了音频直链、多少集拿到了文稿 |
| 3. 各节目可用性 | **每个节目标注"完整 / 有音频缺文稿 / 仅文字 / 空"** |
| 4. 音频文件 | 磁盘上实际有几个、**校验 MP3 文件头是否真的可播**、平均体积、有没有半截 `.part`、index 里声明有但磁盘缺失的 |
| 5. 失败记录 | `content/state.json` 里的失败项（重跑 `download` 会重试） |
| 6. 离线包 | `dist/` 是否比 `content/` 旧、图标是否生成（缺图标就没法装到主屏幕） |

**最该看的是第 3 和第 4 项**：
- 第 3 项标"空"的节目，说明 BBC 那边既没音频也没文稿，直接跳过别浪费时间。
- 第 4 项会挑出"下载了但其实不是 MP3"的文件（比如抓成了 HTML 错误页）。

如果想人工复核某一集，直接看 JSON：

```bash
node -e "const d=require('./content/index.json');const e=d.courses.flatMap(c=>c.series).flatMap(s=>s.episodes)[0];console.log(e.title,e.date,e.audioUrl,e.audioFile,(e.transcript||[]).length)"
```

最后一步的验证是**真的用耳朵听**：`npm start` 后在手机浏览器打开，点一集播放，拖动进度条、试试倍速和 A-B 循环。

---

## 五、打包成安卓 APK

需要先装一次 [Android Studio](https://developer.android.com/studio)（用于最终编译签名）。

```bash
npm run apk:install     # 安装 Capacitor（需要能访问 npm）
npm run dist            # 生成离线包
npm run apk:add         # 创建 android 工程（只需一次）
npm run apk:sync        # 每次重新抓取后都要跑，把最新内容同步进安卓工程
npm run apk:open        # 打开 Android Studio
```

在 Android Studio 里：`Build → Build Bundle(s) / APK(s) → Build APK(s)`，得到 `app-debug.apk`，传到手机安装即可。

> `capacitor.config.json` 已配好 `webDir: dist`。改完 `config.json` 的应用名后，记得同步改 `capacitor.config.json` 里的 `appId`。

---

## 六、目录结构

```
.
├── config.json              # 抓取配置（起始网址、代理、并发、限速）
├── src/
│   ├── fetch.mjs            # CLI 入口
│   └── lib/
│       ├── http.mjs         # 限流 / 重试 / 磁盘缓存 / 代理
│       ├── html.mjs         # 零依赖 HTML 工具
│       ├── audio.mjs        # 音频直链提取（5 种策略 + BBC 媒体选择器）
│       └── parse.mjs        # 目录页 / RSS / 节目页 / 单集页解析
├── app/                     # PWA 前端（纯静态，零依赖）
├── tools/
│   ├── serve.mjs            # 本地静态服务器（支持 Range）
│   ├── build-dist.mjs       # 生成离线包
│   └── make-icons.mjs       # 生成 PNG 图标
├── content/                 # 【抓取产物】index.json + audio/
└── dist/                    # 【最终离线包】
```

---

## 七、常见问题

**Q：提示请求失败 / 连不上**
国内直连 `bbc.co.uk` 基本不通。在 `config.json` 填 `proxy`，然后重跑。

**Q：抓到了节目，但音频是空的**
本工具已内置 5 种提取策略（og:audio、`<audio>` 标签、页面直链、JSON-LD、BBC 官方媒体选择器）。

实测结论：**音频型节目（如 Real Easy English）走的是页面上的官方下载直链，100% 能抓到**；而**纯视频型节目**（如 Tenses with Georgie）只有视频播放器，BBC 没提供可下载的音频，这类节目会显示为"无音频"，但文稿仍可阅读。这是 BBC 的内容策略，不是抓取失败。

想确认某一集，跑：

```bash
npm run probe -- <某一集的网址>
```

看 `音频来源` 一行和 `.cache/dump/` 里的 HTML。

**Q：下载音频超时**
单集约 12MB，代理慢的话一集要 100 秒。默认超时已设为 10 分钟（`config.json` 的 `audioTimeoutMs`）。中断后重跑 `npm run download` 会续传，不用从头来。

**Q：文稿抓不全**
优先走 RSS（含完整 description），其次抓页面 transcript 区块，最后按整页文本切分。缺文稿不影响听，只是少了对照。

**Q：手机上显示"没有学习包"**
说明 `content/index.json` 没生成或没同步到 `dist/`。重新跑 `npm run dist`。

**Q：iPhone 上音频不能拖动**
本项目用 `fetch → Blob → objectURL` 播放，已规避 iOS 的 Range 限制。若仍异常，在设置页点「清除离线缓存」后重新进入。

**Q：页面重定向到 /persian/ 之类的语言段**
BBC 会按出口 IP 重定向语言目录。本工具已用重定向后的最终 URL 作为解析基准，不影响抓取结果。

**Q：抓太慢 / 怕被 BBC 限流**
调 `config.json` 的 `concurrency`（默认 3）和 `minDelayMs`（默认 700）。默认设置是克制的，别调太激进。

**Q：想换抓取范围**
改 `config.json` 的 `startUrls` 即可，入门/中级/高级和首页精选默认都已包含。只想抓某一个难度就只留那一行：

```json
"startUrls": ["https://www.bbc.co.uk/learningenglish/medium_course"]
```

改完跑 `npm run courses` 重新生成目录（已抓过的单集和音频不会被清掉）。

---

## 八、版权与合规

- 音频与文稿的**版权归 BBC 所有**。本工具仅做**个人离线学习**用途，把内容缓存在你自己的设备上。
- **请勿**把抓取到的音频、文稿重新上传到任何公开平台，或用于商业用途。
- 内容用于学习后，建议回到 BBC 官网支持官方渠道。
- 抓取行为已内置限流（默认 700ms 间隔、并发 3），请保持克制。
