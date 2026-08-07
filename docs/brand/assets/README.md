# Bellwire V1 角色与 Icon 资产

> 状态：`V1.1 STATE PREVIEW`，用于当前 App 与真机状态评审；不是正式矢量生产母版。

## 文件

| 文件 | 用途 |
| --- | --- |
| `mascot-signal-bird-chroma-source.png` | 生成时的绿幕源图，只用于可追溯和重新抠图，不进入 App |
| `mascot-signal-bird-master.png` | 1254 × 1254 透明 V1 母图；所有应用内尺寸从这张图派生 |
| `mascot-states/*-chroma-source.png` | 以原始母图为唯一身份锚点生成的五个状态绿幕源图 |
| `mascot-states/*-master.png` | Listening、Connecting、Accepted、Verified、Issue 的 1254 × 1254 透明状态母图 |
| `bellwire-app-icon-source.png` | 1254 × 1254 无透明通道的 V1 Icon 源图 |
| `../../../ios/Bellwire/Bellwire/Assets.xcassets/MascotSignalBird.imageset/` | 128 / 256 / 384 px iOS 导出 |
| `../../../ios/Bellwire/Bellwire/Assets.xcassets/Mascot*.imageset/` | 各状态的 128 / 256 / 384 px iOS 导出 |
| `../../../ios/Bellwire/Bellwire/Assets.xcassets/AppIcon.appiconset/BellwireIcon.png` | 1024 × 1024 iOS App Icon 导出 |

## 生成描述

角色母图围绕同一条结构合同生成：原创 Bellwire 冠羽鸟、柔和哑光编辑插画、朝右三分之四视角、只显示一只眼、琥珀色头背、暖奶油色胸腹、石墨色长喙和固定翼纹；永远且只能有三根独立冠羽，三根之间保留清楚负空间。完整站立、安静专注、不加文字、铃铛、圆圈、光点、拖线、卡片或道具。生成时使用纯绿色背景，随后抠图为透明母图。

App Icon 使用同一角色身份：深靛蓝纯色背景，头部和上半身特写，朝右 listening 状态，恰好三根冠羽全部位于安全区；不加文字、铃铛、通知角标、连接线、外框或预制系统圆角。

## 使用边界

- 不从其他 UI 生图中裁切新角色。状态图只以 `mascot-signal-bird-master.png` 为身份锚点生成，并保留生成绿幕源图、透明母图和应用导出三级可追溯链。
- V1.1 使用可辨认的静态姿态区分 Listening、Connecting、Accepted、Verified 和 Issue；Idle / All Quiet 继续使用原始母图。右侧功能插画整体镜像朝左看内容，品牌 Icon 始终朝右。
- 角色是装饰层，不读取业务内容、不独立成为点击目标，状态必须有等价文字。
- 当前动效由首次轻落地、约 6.2 秒的低振幅呼吸、状态微动作和接触阴影组成；所有动画在 Reduce Motion 下静止，并在 App 不活跃时暂停。
- 这些状态位图仍是方向评审资产。下一步仍需制作可编辑矢量 model sheet 和部件分层，再实现冠羽等局部动作；正式发布前需补做角色小尺寸、深浅色背景和 180 / 120 / 60 / 29 px Icon 验收。
