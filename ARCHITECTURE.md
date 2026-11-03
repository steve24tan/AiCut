# 本地工作台架构 · v0.4

## 目标与选择

v0.4 的 src/import-command.mjs 为现有本地 Agent 会话提供流式文件导入、均分与自定义时间点；未知时长通过可选 ffprobe 读取或明确提供 --duration，不猜测。导入与分段为独立服务请求，部分失败保留可检查的片段 ID。GET /api/shots/:id 提供现有版本详情；GET /api/projects/:id/stamp 返回轻量片段元数据。网页仅在空闲且无未保存编辑／弹窗时接收外部变更，再通过正常保存流程刷新，避免覆盖当前输入。

v0.3 增加了本地任务队列。schema v3 的 jobs 保存片段／项目 ID、provider、status、source_revision、不可变 snapshot、result、error 和时间戳。v2 升级前生成 schema-v2-before-v3.sqlite；片段级唯一索引阻止重复 queued/running 任务。

src/jobs.mjs 管理领取、完成、取消和采用；src/runner.mjs 串行启动 CLI，输入走 stdin，shell=false，限制超时和输出，并支持取消。Claude 禁用工具／MCP；Codex read-only；不绕过权限。API 不接受任意命令路径。

采用须匹配 source_revision，事务保存旧文字 take，再更新 Prompt／状态，不改备注及素材。SQLite 备份包含任务快照／结果；原始日志为辅助文件，不在标准备份中。服务重启不自动重新派工。

public/jobs.js 提供每段推送、状态轮询、历史预览及采用；cli.mjs 为现有会话提供 JSON 命令桥。自动派工是新进程；已有会话显式领取。接口与范围见 [CLI_BRIDGE.md](CLI_BRIDGE.md)。新增路由 GET /api/cli、GET /api/jobs、POST /api/shots/:id/jobs、GET /api/jobs/:id、POST /api/jobs/:id/claim、complete、cancel、apply；仅 manual 任务允许外部领取／完成。

本地单用户的「项目 → 片段 → 草稿／修改要求 → 素材版本」工作流。用户在订阅工具里生成素材并手动导回。核心工作台离线运行；可选 CLI 作业通过本机已登录的 Claude Code／Codex 处理文字修改请求，不直接连接模型 API 或生成视频。

参考来源（2026-11-03 文档核对，未安装这些上游项目）：

- [Clapshot](https://github.com/elonen/clapshot)：自托管媒体、SQLite 与文件素材分离、视频审阅和评论。参考它的存储边界；当前只实现片段备注，没有时间点画笔标注。
- [StoryBored](https://github.com/storybored-app/storybored)：项目／镜头卡片、多个 take、采用版本和确认状态。它是小型项目，只参考交互，不将它当成熟依赖。
- [Wonder Unit Storyboarder](https://github.com/wonderunit/storyboarder)：分镜组织和逐段检查的操作方式。
- [Node.js SQLite 文档](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)：使用当前 Node 24 自带 SQLite，减少 Windows 首次安装依赖。存储集中封装在 `src/store.mjs`，以后需要替换驱动时不影响界面模型。

成熟通用部分采用 SQLite 事务、不可变素材、流式写入、HTTP Range、乐观并发和一致备份；无需为单人本地应用引入完整的协作审片平台。

## 组件

```mermaid
flowchart LR
    U[Chrome / Edge] --> UI[public: HTML / CSS / JS]
    UI -->|JSON: 项目、草稿、排序| API[server.mjs: 本地 HTTP 服务]
    UI -->|二进制流: 手动导入素材| API
    API --> Store[src/store.mjs: 业务约束与事务]
    Store --> DB[(data/workbench.sqlite)]
    API --> Media[data/media: 原始素材副本]
    Media -->|支持 Range 的预览| U
    DB --> Backup[scripts/backup.mjs]
    Media --> Backup
    Backup --> Disk[backups: 数据库快照与素材]
```

服务只绑定 `127.0.0.1`。静态资源与 API 同源，无 CDN、外部字体或第三方运行依赖。Node 24+ 是唯一运行环境依赖。

## 数据模型

```mermaid
erDiagram
    PROJECT ||--o{ SHOT : contains
    SHOT ||--o{ TAKE : preserves
    TAKE o|--o| MEDIA : references
    PROJECT {
        string id PK
        string title
        string created_at
    }
    SHOT {
        string id PK
        string project_id FK
        int position
        string title
        string prompt
        string notes
        string status
        string active_take_id
        int revision
    }
    TAKE {
        string id PK
        string shot_id FK
        int number
        string prompt
        string notes
        string media_id
        string created_at
    }
    MEDIA {
        string id PK
        string filename
        string stored_name
        string mime
        int bytes
        string sha256
    }
```

- `shot.prompt/notes` 是下一版草稿，可以随时修改。
- `take.prompt/notes` 是创建版本当时的快照，服务不暴露修改接口。
- `active_take_id` 仅控制采用版预览。服务校验该版本必须属于同一片段，不用它反写草稿。
- take 的版本号按片段递增，与片段显示顺序无关。重排不会改变片段 UUID 或素材归属。
- 素材以 UUID 命名，原文件名仅用于显示。SHA-256 记录导入文件指纹；目前不按指纹去重。
- `todo / revise / review / approved` 对应待生成／待微调／待检查／已确认。新导入或文字快照进入待检查。

## 写入与恢复约束

草稿保存携带 `revision`，服务比较后更新为 `revision+1`。旧页面返回 HTTP 409，不静默覆盖。前端每片段串行提交，650ms 防抖；项目切换、排序和导入前先保存所有草稿。保存失败阻止依赖保存的操作，复制请求仍能从页面取回内容。

素材导入分两步：

1. 二进制流写入 `media/<UUID>.part`，计数和计算指纹；完成后同盘重命名。
2. 事务重新核对草稿 revision，建立素材记录、只读 take 和采用版指针。事务失败则清理本次未引用的文件。

进程异常退出可能留下 `.part` 或已重命名但未入库的孤立文件；它们不参与预览。初始版不自动删除，后续可加入显式可审阅的孤立素材清单。SQLite WAL 处理数据库事务的崩溃一致性。不是文件系统／数据库跨介质的原子事务。

备份先用 SQLite Backup API 创建一致数据库快照，再复制只增不删的素材。恢复需要整套目录。未来加入删除或垃圾回收前，必须重新设计备份与锁定协议。

## 本地接口

| 方法 | 路径 | 行为 |
|---|---|---|
| GET / POST | `/api/projects` | 列出／创建项目 |
| GET | `/api/projects/:id` | 项目及片段、版本详情 |
| POST | `/api/projects/:id/shots` | 添加空片段 |
| PUT | `/api/projects/:id/order` | 提交完整片段 ID 顺序 |
| PATCH | `/api/shots/:id` | 按 revision 修改草稿、状态或采用版 |
| POST | `/api/shots/:id/snapshot` | 保存当前文字为只读版本 |
| POST | `/api/shots/:id/split` | 按当前采用视频范围与 cuts_ms 创建多段，需要 revision |
| POST | `/api/shots/:id/trim` | 将 start_ms / end_ms 保存为新版本，需要 revision |
| POST | `/api/shots/:id/takes?filename=...` | 二进制素材导入；`X-Shot-Revision` 指定草稿版本 |
| GET / HEAD | `/media/:id` | 流式读取／Range 字节读取 |

写请求要求 `X-Workbench: 1`。检查 Host 与 Origin，禁止跨站网页写入。静态路径只开放明确列出的三个文件，素材只允许通过数据库 UUID 查找。此边界用于本机单人模式，不是多用户认证系统。

## 文件职责

```text
server.mjs             HTTP 路由、来源检查、流式素材导入和预览
src/store.mjs          SQLite 表、事务、业务校验、乐观并发
public/index.html      工作台结构与卡片模板
public/style.css       响应式布局、卡片和状态视觉
public/app.js          项目、编辑、自动保存、导入、复制请求
scripts/backup.mjs     数据库快照和素材备份
scripts/browser-smoke.mjs  本机 Chrome 验证脚本
tests/workbench.test.mjs   数据持久化与 HTTP 集成检查
start.cmd              Windows 启动入口
```

## 后续扩展顺序

1. 用真实 5–10 段素材验证修改、回填与重启后的检索。
2. 增加 Prompt 变更记录及两个版本并排播放；沿用 take，不覆盖历史。
3. 时间范围分段已实现；后续再接 FFmpeg 导出和 PySceneDetect 镜头检测。自动检测结果必须可手动改边界。
4. 需要文件夹监听时，用 manifest／片段 UUID 归属，不靠易变的显示编号猜测。
5. 大项目再评估缩略图、转码队列、异步 DB 驱动／Worker。初始版无速度或容量基准承诺。

现有生产工具可通过独立适配器导入；初始版不直接改写外部项目或渲染器。

## v0.2 时间范围与升级

schema v2 为 takes 增加 start_ms、end_ms、duration_ms 三个整数毫秒字段，null 表示原整条文件。分段、调整范围都创建不可变 take，多个 take 共用同一 media。原 take 不变。客户端提交浏览器读取的时长，服务端校验顺序与范围；未独立解码验证真实媒体时长。

分段事务先移动后续卡片位置，将第一段存入原卡片的新 take，再创建其余卡片和范围。失败时整笔回滚。各段继承 Prompt，只有第一段继承备注。调整单段范围不自动修改邻段，可能产生间隙或重叠。

旧 v1 首次升级前用 VACUUM INTO 生成 schema-v1-before-v2.sqlite（已存在则不覆盖），随后在事务中加字段并更新 user_version。更高版本数据库会被拒绝。完整备份仍需素材目录，不要用旧代码打开新版数据。

public/segments.js 负责分段对话框、均分／播放位置边界、范围编辑、单段循环和导航；public/segments.css 提供样式。播放依据 [currentTime](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentTime) 定位，结合 [requestVideoFrameCallback](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback) 与 timeupdate 限制预览。它不是帧精确导出。
