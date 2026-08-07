# Bellwire UI 重构总纲

版本：`0.1`

日期：`2026-08-03`

状态：`DESIGN IN PROGRESS`

本文是 Bellwire 原生 iOS UI 重构的视觉与交互依据。它取代 [Lovable UI Mapping](../lovable-ui-mapping.md) 中的旧视觉方向，但不取代其中关于真实数据、业务逻辑复用和原生导航映射的约束。

角色的结构、性格、动作、Private-first 表达和使用边界继续以 [Mascot Character Bible](./mascot-character-bible.md) 为准。

## 1. 重构结论

Bellwire 的新 UI 使用一套统一的 **Signal Indigo + Amber Yellow** 视觉系统：

- 深靛蓝负责专业感、可信度和技术产品底盘。
- 琥珀黄负责 Bellwire 品牌、选中状态、未读和需要用户关注的动作。
- 绿色、红色、紫色和警告黄只表达真实语义，不参与页面装饰。
- 项目 Logo、事件标题和下一步动作始终比品牌装饰更重要。
- 吉祥物负责品牌记忆和少量状态引导，不进入普通业务列表和严肃场景。
- 页面保持原生 iOS 行为，不模拟网页 Dashboard、浏览器布局或概念机框。

一句话设计目标：

> 一个安静但有生命感的 Agent 信号中心，让用户在三秒内知道发生了什么、什么需要处理、什么仍在运行。

## 2. 当前状态审计

### 2.1 保留

- `Home / Projects / Events / Settings` 四 Tab 信息架构。
- `NavigationStack`、原生 `TabView`、Sheet、Menu、Alert 和系统 Safe Area。
- `AppModel`、`APIClient`、认证、Keychain、APNs、Private Direct 和 Hosted 数据路径。
- `loadDashboard()` 作为 Home、Projects、Events 的主要真实数据来源。
- 项目 Logo 优先，以及本地缓存和首字母降级逻辑。
- Loading、Empty、Error、权限拒绝、复制完成和异步操作反馈。
- 44 pt 最小触控区域、Dynamic Type、VoiceOver 和 Reduce Motion。
- 项目与事件详情中的敏感字段隐藏、Delivery 状态和诊断入口。

### 2.2 退休

- 暖纸色、棕灰色和米色高端模板感。
- New York / Serif 作为所有页面大标题。
- 大面积环境渐变、琥珀 Glow 和装饰性光晕。
- `20-32 pt` 大圆角在所有容器上重复使用。
- 多张同权重卡片连续堆叠。
- 仅依靠彩色圆点表达运行、未读或成功。
- 项目列表、事件列表和设置列表被额外大卡片包裹。
- 吉祥物在普通内容页面重复出现，或被当成项目 Logo 的替代品。
- 为展示效果而虚构状态、数字、按钮或后端能力。

### 2.3 不改动的产品事实

- APNs `accepted` 不是设备已经显示通知。
- Private 与 Hosted 必须使用文字明确区分。
- `delivered` 只能在存在设备侧证据时使用。
- 连接码已生成不代表 Agent 已经完成连接。
- UI 不新增 Rotate endpoint、虚假法律链接或不存在的操作。

## 3. 设计原则

### 3.1 State first

每个页面先回答当前状态，再显示解释和操作。顺序是：

1. 发生了什么。
2. 是否需要用户处理。
3. 下一步是什么。
4. 技术细节在哪里查看。

### 3.2 Source first

项目 Logo、项目名称和事件来源拥有最高视觉优先级。Bellwire 的黄色和吉祥物只说明产品层状态，不能盖过事件来源。

### 3.3 One feature surface

同一屏幕首屏最多一个真正抬高的 Feature Surface。其余内容优先使用留白、轻量分组和单向 Hairline。

### 3.4 Text before dots

状态优先使用 `Running`、`Failed`、`Needs attention`、`2 unread` 等明确文字。独立彩色圆点不作为主要状态语言。

### 3.5 Native before spectacle

使用 SwiftUI 原生导航、按钮、菜单、Sheet、刷新和触觉反馈。视觉表达不能牺牲 Dynamic Type、VoiceOver、触控区域或滚动稳定性。

### 3.6 Mascot with evidence

吉祥物只有在场景属于角色使用矩阵，并且产品状态有真实证据时才出现。角色动作不能比系统事实更乐观。

## 4. 信息架构

### 4.1 主导航

| Tab | 用户问题 | 首要内容 |
| --- | --- | --- |
| Home | 今天发生了什么 | 待处理、运行中、最近更新 |
| Projects | 哪些来源已经连接 | 项目身份、路径、状态、最近更新 |
| Events | 所有事件按时间如何变化 | 筛选、未读、失败、历史 |
| Settings | 账户与投递如何配置 | 账户、Agent 连接、通知、设备、隐私 |

### 4.2 次级流程

- `Connect an Agent` 从 Projects 进入，不增加第五个 Tab。
- Project Detail 从 Home、Projects 和 Event Detail 进入。
- Event Detail 从 Home、Events 和通知 Deep Link 进入。
- Binding Code 使用 Bottom Sheet，展示真实 `BindingResponse`。
- Hosted 批准、删除、购买和隐私确认保持独立严肃流程。

## 5. 主题系统

### 5.1 Dark mode 主视觉

| Token | 色值 | 用途 |
| --- | --- | --- |
| `background` | `#0B0F25` | 页面底色 |
| `navigation` | `#10152C` | Tab Bar、Navigation Bar |
| `surface1` | `#131832` | 主要分组和 Feature Surface |
| `surface2` | `#1A2040` | 次级控件、嵌套技术区 |
| `surface3` | `#22294D` | Pressed、Raised、Track |
| `border` | `#2B3358` | Hairline、容器边界 |
| `textPrimary` | `#F7F8FF` | 标题和主要内容 |
| `textBody` | `#D6D9E8` | 正文 |
| `textSecondary` | `#949BB8` | 元数据和辅助说明 |
| `textDisabled` | `#5F6682` | 仅用于不可用内容 |
| `tabInactive` | `#7D86A8` | 未选中 Tab，AA 对比度 |
| `signal` | `#F5A11A` | 品牌、选中、未读、关注动作 |
| `signalLight` | `#FFC45C` | 小面积高光 |
| `signalDark` | `#D97908` | Pressed、深色层次 |

### 5.2 Light mode 配套

Light mode 继续存在，但不再使用暖纸色。它使用偏冷的蓝白中性色，并与 Dark mode 共享同一语义系统。

| Token | 色值 | 用途 |
| --- | --- | --- |
| `background` | `#F6F7FB` | 页面底色 |
| `navigation` | `#FFFFFF` | Tab Bar、Navigation Bar |
| `surface1` | `#FFFFFF` | 主要 Surface |
| `surface2` | `#EEF0F7` | 次级 Surface |
| `surface3` | `#E1E5F0` | Pressed、Track |
| `border` | `#D5DAE8` | Hairline |
| `textPrimary` | `#171A2E` | 标题和主要内容 |
| `textBody` | `#3F4661` | 正文 |
| `textSecondary` | `#68708A` | 元数据 |
| `signalFill` | `#F5A11A` | 主按钮和实心选中状态 |
| `signalInk` | `#A85A00` | 浅底上的黄色文字和图标 |
| `signalForeground` | `#0B0F25` | 黄色填充上的文字 |

### 5.3 语义色

| 状态 | Dark | 使用规则 |
| --- | --- | --- |
| Success | `#35C98B` | 已完成、健康、真实成功 |
| Error | `#FF626B` | 失败、阻断、危险 |
| Warning | `#F6C453` | 排队、退化、接近限制 |
| Info | `#6484FF` | 中性系统信息 |
| Running | `#9B7CFF` | 正在执行、进度和计时 |

语义色默认用于文字、图标和 `8-12%` Tint。除错误和明确 Feature Surface 外，不使用整张彩色卡片。

### 5.4 黄色使用预算

黄色只允许用于：

- 当前 Tab。
- 未读数字角标。
- Primary CTA。
- `Needs attention` 及其明确操作。
- Bellwire 品牌标记和吉祥物。
- 一屏最多一个关键数字。

黄色不用于普通项目 Logo、所有 Section Title、每条事件图标或所有按钮。

## 6. 字体系统

- Display、页面标题、Section、正文和按钮统一使用 SF Pro 系统字体。
- 页面大标题使用 `.largeTitle` 或 `32-34 pt / Semibold-Bold`，不使用 Serif。
- Section 标题使用 Sentence case，`17-20 pt / Semibold`；不再全大写和大字距。
- 正文使用 `.body`、`.subheadline` 和 `.caption` 语义样式。
- 时间、百分比、绑定码、Endpoint、ID、Event Type 使用 SF Mono 或 Monospaced Digit。
- 不在同一页面混用编辑感衬线、技术 Mono 和营销式大字三套语气。

## 7. 尺寸与布局

### 7.1 基础尺寸

| 类型 | 规则 |
| --- | --- |
| 页面水平边距 | `20 pt`，紧凑设备允许 `16 pt` |
| Section 间距 | `24-28 pt` |
| 内容行间距 | `10-14 pt` |
| 列表行高度 | `64-76 pt` |
| Feature Surface 圆角 | `16-18 pt` |
| 普通控件圆角 | `12-14 pt` |
| 小型 Badge 圆角 | `6-8 pt` |
| 最小触控区域 | `44 × 44 pt` |
| Hairline | `1 px` 或系统 Separator |

### 7.2 Surface 层级

1. 页面底色不加装饰 Glow。
2. 只有摘要、待处理或当前 Live Surface 可以使用 `surface1`。
3. 列表优先直接放在页面上，使用单向 Divider。
4. 嵌套技术区域使用 `surface2`，不再叠第三层卡片。
5. 阴影只用于 Sheet、浮层和确实离开页面平面的内容。

## 8. 公共组件

### 8.1 品牌与身份

- `MascotMark`：专门的小尺寸三冠羽头部标记，只代表 Bellwire。
- `ProjectAvatarView`：项目 Logo、远程缓存和首字母降级。
- `ProjectIdentityRow`：Logo、名称、路径和最后更新。

`MascotMark` 进入生产前必须单独验证深靛蓝背景上的喙、眼和冠羽对比度；当前 AI 位图不能直接用作正式资产。

### 8.2 状态与摘要

- `SignalDigestRail`：今日更新、待处理和运行中。
- `StatusText`：文字状态，可配小图标，但不依赖圆点。
- `UnreadCountBadge`：只显示真实数字。
- `PriorityRow`：一个明确问题、一句说明、一个操作。
- `LiveSurfaceFeature`：每屏最多一个主 Live Surface。

### 8.3 内容列表

- `EventRow`：Logo、事件标题、项目名、状态文字、时间。
- `ProjectRow`：Logo、项目名、Private/Hosted、最近状态、未读数字。
- `SettingsRow`：标题、说明、真实状态和可选 Accessory。
- 列表组不额外套大阴影卡片；Section 使用留白和 Divider 建立结构。

### 8.4 操作

- Primary：黄色填充、深靛蓝文字，一屏最多一个。
- Secondary：`surface2` + Border + 主文字。
- Tertiary：纯文字或图标按钮。
- Destructive：红色语义，不使用品牌黄。
- 异步操作立即显示动词变化和进度，例如 `Generating code…`、`Pausing…`。

### 8.5 状态组件

- Loading：与真实最终布局同形的 Skeleton，不使用居中大 Spinner。
- Empty：说明为空的具体原因，并给出一个可执行下一步。
- Error：保留已加载内容时优先 Inline Banner；阻断页面时给出诊断和重试。
- Offline：与服务端错误区分，只在当前模型有证据时使用。

## 9. 吉祥物与 UI 的结合

### 9.1 出现位置

| 场景 | 形式 |
| --- | --- |
| Welcome | `88-104 pt` Hero |
| 通知权限预说明 | `56-72 pt` Listening |
| Home 有内容 | 默认不出现；可选 `24-32 pt` 品牌 Mark |
| Home 真空状态 | `56-72 pt` All Quiet |
| Projects 真空状态 | `56-72 pt` All Quiet |
| Connect an Agent | `48-64 pt` Connecting / Testing |
| 连接确认 | 一次性 `Connected Verified` |
| 普通列表与详情 | 不出现 |
| Settings、购买、删除、隐私 | 不出现 |

### 9.2 视觉边界

- 同一屏幕最多一只。
- 有项目 Logo 时，吉祥物不进入同一内容单元。
- 不携带信封、事件卡、手机、线缆或任何业务内容。
- 不使用无归属圆圈、波纹、轨道线、火花和粒子。
- 三根冠羽必须分别可见；两根、四根、融合或遮挡都不合格。
- 深色模式不随意改变角色本体颜色。正式 `MascotMark` 需要单独的暗底对比验证和矢量母版。

## 10. 逐屏设计蓝图

### 10.1 Welcome

- 品牌 Hero 与一句明确价值主张。
- 一个真实、紧凑的事件预览，不堆三张等权重卡片。
- 原生 Sign in with Apple。
- 角色是唯一大面积暖色焦点。

### 10.2 Notification onboarding

- 先说明会通知什么、用户能控制什么。
- 三类通知使用语义图标，不重复角色。
- 请求系统权限前允许 Listening 姿态；系统弹窗和拒绝结果不卖萌。

### 10.3 Home

- Header：日期、问候、未读入口。
- `SignalDigestRail`：今日更新、待处理、运行中。
- `Needs attention`：最多一个明确 Priority Row。
- `Running now`：最多一个 Feature Surface。
- `Recent updates`：三到六条扁平 Event Row。
- 有真实内容时完整角色退场。

### 10.4 Projects

- Header：连接数和筛选。
- 项目列表优先显示项目 Logo、Private/Hosted、最近事件和文字状态。
- `Connect an Agent` 是列表尾部或工具栏动作，不做独立第五 Tab。
- 零项目时允许 `MascotAllQuiet`。

### 10.5 Connect an Agent

- 步骤使用真实动词：Generate code、Give to Agent、Verify。
- 绑定码大而清楚，使用 SF Mono，不把每一位做成按钮。
- 复制、等待、过期和验证必须是独立状态。
- 角色只看向当前步骤，不触碰绑定码或线缆。

### 10.6 Events

- 原生筛选：All、Unread、Failed。
- 按日期分组，显示未读数量和明确状态文字。
- 不使用每行彩色圆点；失败使用 `Failed` 标签或红色文字。
- 项目 Logo、事件标题和时间优先。

### 10.7 Project Detail

- 项目身份、Private/Hosted 和 Active/Paused 在首屏可见。
- Delivery Health、Live Surfaces、Recent Events 和 Technical Details 分层展示。
- Pause/Resume、Export 和复制 Endpoint 提供立即反馈。
- 不出现吉祥物。

### 10.8 Event Detail

- Event Type、业务标题、项目来源和精确时间优先。
- Structured Fields、Delivery、Technical Details 使用渐进披露。
- 敏感字段默认隐藏；Reveal 和 Copy 不使用黄色大按钮。
- 不出现吉祥物。

### 10.9 Settings

- Account、Agent connections、Notifications、Devices、Privacy、Appearance 分组。
- 状态显示真实值，不做展示型假 Toggle。
- Binding、系统通知设置和 Sign out 使用原生行为。
- 购买、恢复、删除、隐私场景不出现吉祥物。

## 11. 动效和反馈

- 页面首次进入只做一次 `opacity + y 6 pt` 的轻量层级进入。
- 内容进入顺序最多三段，不让用户等待动画后才能操作。
- 按压使用 `0.98`，不使用弹跳或橡皮感。
- 状态变化使用 `150-250 ms`；连接确认可使用一次 `340 ms` 阻尼回弹。
- Loading、复制、暂停、生成绑定码等操作立即改变文案并显示进度。
- Reduce Motion 时移除位移、旋转、分段延迟和脉冲，保留即时状态文字。
- 不使用无限呼吸、发光、漂浮、循环眨眼或环境粒子。

## 12. 无障碍与适配

- Body Text 目标 AA，主要正文尽量达到 AAA。
- 状态不能只靠颜色、冠羽角度或图标传达。
- Dynamic Type 达到辅助功能字号后，指标 Rail 可以换行或改为纵向。
- 项目名、事件标题和按钮允许合理换行，不压缩为不可读小字。
- VoiceOver 朗读业务状态，不描述吉祥物动作。
- 所有页面检查 320 pt 紧凑宽度、393 pt 基准宽度和大字号。
- iPad 延续同一信息层级，不简单把 iPhone 卡片无限拉宽。

## 13. SwiftUI 重构顺序

### Phase 0：设计锁定

1. 主题与 Token。
2. 四个核心 Tab。
3. Welcome、连接流程和真实空状态。
4. 角色 Model Sheet 与 App Icon。

### Phase 1：设计系统

1. `Theme.swift`：替换色板和字体角色。
2. `Components.swift`：Digest、Priority、Status Text、List Row、Button 和 State 组件。
3. 保留现有组件的真实状态与无障碍行为。

### Phase 2：核心导航

1. Home。
2. Projects。
3. Events。
4. Settings。

每个页面分别验证 Loading、Populated、Empty 和 Error。

### Phase 3：任务流程

1. Welcome 与通知权限。
2. Connect an Agent 与 Binding Sheet。
3. Project Detail。
4. Event Detail。

### Phase 4：严肃场景与完成度

1. Hosted approval。
2. Paywall 与 Restore。
3. 删除、隐私和危险操作。
4. Dynamic Type、VoiceOver、Reduce Motion、Light/Dark。
5. App Store 截图与正式品牌资产。

## 14. 验收门槛

- [ ] 视觉主色统一为 Signal Indigo + Amber Yellow。
- [ ] 页面没有暖纸灰、重衬线和琥珀 Glow 遗留。
- [ ] 每屏最多一个 Feature Surface 和一个 Primary CTA。
- [ ] 普通列表没有多余大卡片外壳。
- [ ] 状态使用明确文字，独立彩色圆点不是唯一表达。
- [ ] 项目 Logo 优先级高于 Bellwire 品牌装饰。
- [ ] 吉祥物仅在允许场景出现，且三根冠羽一致。
- [ ] Private、Hosted、APNs Accepted 和 Delivered 文案准确。
- [ ] Loading、Empty、Error 和异步反馈完整。
- [ ] Dynamic Type、VoiceOver、Reduce Motion 和 44 pt 触控区域通过。
- [ ] 现有业务逻辑、Deep Link、认证、通知和数据路径没有被 UI 重构破坏。
- [ ] 每个阶段均通过 iOS Build 和截图回归测试。

## 15. 当前设计资产状态

| 资产 | 状态 |
| --- | --- |
| UI 重构总纲 | `LOCKED FOR V1 EXPLORATION` |
| Signal Indigo 色板 | `LOCKED FOR V1 EXPLORATION` |
| Home 概念图 | `DRAFT` |
| 四 Tab 整体设计板 | `IN PROGRESS` |
| Mascot Model Sheet | `SETUP_REQUIRED` |
| MascotMark 矢量资产 | `SETUP_REQUIRED` |
| MascotSignalBird 位图预览 | `V1 IN APP` |
| Mascot State Pose Set | `V1.1 IN APP` |
| App Icon | `V1 ON DEVICE PREVIEW` |
| SwiftUI 实现 | `V1 INTEGRATED IN CURRENT IA` |
| Mascot Motion System | `V1 INTEGRATED` |

V1 保留现有信息架构，只更新主题、角色触点和微动效：Welcome、通知权限说明、真正零项目状态与绑定码页面使用角色；已有内容的 Home、列表、详情、错误、付费和危险操作不添加角色。功能插画向内看内容，使用首次轻落地、低频呼吸、状态微动作、接触阴影和缓慢环境光建立生命感。当前位图用于真机方向评审，正式角色矢量母版和分层动作仍按角色圣经执行。

## 16. 变更规则

1. 设计图不能直接覆盖本文件的产品与状态约束。
2. 颜色、角色结构、IA 或严肃场景边界改变时，必须更新本文版本。
3. AI 生成 UI 只用于构图探索；最终间距、文字、状态和无障碍以 SwiftUI 实现与本文件为准。
4. 正式角色资产必须从统一矢量母版导出，不能从不同 UI 生图中裁切。
5. 旧 `event-canine` 版本只作为 Signal Indigo 色板和对比度参考，不作为当前布局或角色来源。
