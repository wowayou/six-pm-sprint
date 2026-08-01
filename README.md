# 六点夺秒

一款手机优先、45 秒一局的单指网页游戏：玩家沿下班时钟自动奔跑，每次轻触都会反向，需要躲开“临时加会”“再改一下”等危险区并尽量收集工资币。

**在线试玩：<https://wowayou.github.io/six-pm-sprint/>**

## 立即试玩

```bash
npm run dev
```

打开 <http://127.0.0.1:4173>。无需安装依赖。

## 核心特性

- 单击、触摸、空格或方向键均可操作
- 基于日期种子的每日同图挑战
- 今日 / 昨日 / 随机练习三种地图，切换后地址栏同步更新，可直接分享
- `?seed=...&target=...&ghost=...` 好友战绩与幽灵挑战链接
- 分享链接会压缩携带真实掉头时序，好友可追逐你的幽灵路线
- 分段积分移动模型，让同一回放在不同帧率设备上保持一致
- 本地最佳成绩、今日记录和累计统计
- Web Audio 即时音效、震动反馈、粒子与近失连击
- 原生分享；不支持时自动复制挑战文案和链接
- 一键生成 1080 × 1440 PNG 战绩卡
- PWA 离线缓存、响应式布局和减少动态效果适配
- iOS / Android 安装图标齐备（含 maskable 与 apple-touch-icon）
- 纯原生 HTML/CSS/JavaScript，无依赖、无追踪、无广告

## 质量检查

```bash
npm run check
```

回合关卡由随机种子生成，因此额外提供一个公平性证明脚本：玩家速度固定、唯一输入是掉头，所以可以穷举全部生存轨迹，逐帧推进可达状态集合，若集合被清空则说明该地图存在必死局。

```bash
npm run audit:fairness          # 默认校验未来 60 天 + 120 个合成种子
npm run audit:fairness 300 90   # 自定义合成种子数与天数
```

`npm test` 里另有一条低成本的结构性守卫（跑道始终留有可站立的连续区间），完整证明则交给上面的脚本。

## 图标

`assets/` 下的 PNG 图标由 `assets/icon.svg` 生成（iOS 不支持 manifest 中的 SVG 图标，必须提供 PNG）：

```bash
python3 scripts/build-icons.py   # 需要 Pillow 与 numpy，仅开发期使用
```

生成后请一并提交 PNG。线上站点本身仍然零依赖。

## 离线与更新策略

Service Worker 把资源分成两类：

- **App shell**（`index.html` / `styles.css` / `src/*.js` / manifest）走**网络优先**，断网才回退缓存
- **图标等静态资源**走缓存优先

shell 必须整体更新：`src/game.js` 在模块顶层就要取 `index.html` 里的 DOM 节点，旧 HTML 配新 JS 会直接抛 `TypeError`、整个舞台起不来。而且缓存里跑旧 `engine.js` 的人会生成**另一张"今日地图"**，破坏所有人同图这个前提。所以 shell 宁可每次多花约 100ms 也要保证版本一致。

GitHub Pages 下发 `max-age=600`，因此 shell 请求带 `cache: "no-cache"` 强制重新验证——有 ETag，实际换回的是 304。

`tests/service-worker.test.js` 在 stub 过的 ServiceWorkerGlobalScope 里加载 `sw.js` 验证以上行为，其中一条会检查 `index.html` 引用的每个脚本和样式表都在 shell 列表里——新增 `<script>` 但忘了登记会直接测试失败。

## GitHub Pages

仓库包含 `.github/workflows/pages.yml`。推送到 `main` 后，在仓库 Settings → Pages 中将 Source 设为 **GitHub Actions**，工作流会自动发布静态站点。

## 操作说明

- 轻触或按空格：立即改变绕行方向
- `Esc` / `P`：暂停与继续（切走窗口也会自动暂停）
- 红色虚线：危险预警
- 红色实线：碰到即结束
- 黄色 `¥`：工资币，连续收集会提高分数
- 青色菱形：免加会券，可抵消一次碰撞

## 隐私

所有成绩仅保存在浏览器 `localStorage`，不上传个人数据。

## 地图模式

开始面板下方可以切换地图：

- **今日**：默认，全世界同一张图，按上海时区零点滚动
- **昨日**：补昨天没打完的那局，好友之间仍可比较
- **随机练习**：每次点击生成一张全新的图，用来纯练手

切到非今日地图时地址栏会带上 `?seed=...`，直接复制就能把同一张图发给别人。每张图的最佳成绩单独记录，按最近游玩时间保留最近 20 张。

## 许可

[MIT](LICENSE)
