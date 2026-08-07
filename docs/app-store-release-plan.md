# Bellwire App Store 上架计划

更新时间：2026-08-08

发布状态：1.0.0（build 9）已在 App Store；Cloudflare Auth 迁移版 1.0.1（build 13）已归档、生产签名、导出并安装到真机，等待 App Store Connect Issuer ID 或已登录的 Xcode 账户完成上传。

## Cloudflare Auth 迁移版

- Bundle ID：`app.bellwire`
- 版本：1.0.1（build 13）
- API：`https://api.bellwire.app`
- Auth：`https://auth.bellwire.app`
- IPA SHA-256：`2f2363da2d891c30d2012730da3240ce17aa22f32648b90a96eac8ec43513b46`
- 私有交付记录：`ios-release-1.0.1-build13/release-manifest.json`

只做本地制品核对，不读取 Apple 凭证：

```bash
npm run ios:release -- \
  --ipa "/secure/Bellwire-1.0.1-13.ipa" \
  --version 1.0.1 \
  --build 13 \
  --sha256 2f2363da2d891c30d2012730da3240ce17aa22f32648b90a96eac8ec43513b46 \
  --local-only
```

验证并上传。Issuer ID 只通过当前进程环境传入，工具会在 `~/.appstoreconnect/private_keys` 中尝试已有 `AuthKey_*.p8`，不会打印或持久化私钥：

```bash
APP_STORE_CONNECT_ISSUER_ID="<issuer-id>" \
npm run ios:release -- \
  --ipa "/secure/Bellwire-1.0.1-13.ipa" \
  --version 1.0.1 \
  --build 13 \
  --sha256 2f2363da2d891c30d2012730da3240ce17aa22f32648b90a96eac8ec43513b46 \
  --upload
```

流程顺序固定为：本地 Bundle/版本/端点/SHA 核对 → App Store Connect API 鉴权 → Apple Validate → Upload → 等待 Apple Processing。没有显式 `--upload` 时绝不会上传。

## 发布目标

- 首发版本：1.0.0（build 9）
- Bundle ID：`app.bellwire`
- 最低系统：iOS 17.0
- 首发地区：除中国大陆外的可用国家和地区
- 定价：免费
- 分类建议：Developer Tools（主）/ Productivity（次）

## 当前状态

- [x] Release 工程可归档
- [x] Sign in with Apple 已接入
- [x] 拒绝通知权限后 App 仍可使用
- [x] App 内提供永久删除账户与数据
- [x] 提供无需外部 Agent 的审核示例项目
- [x] 官网隐私政策、服务条款、支持、账户删除页面已实现
- [x] Privacy Manifest 与 UserDefaults required-reason 已加入
- [x] 声明仅使用豁免加密（HTTPS / Apple 系统加密）
- [x] Worker 源配置已切换为 production APNs
- [x] Apple Distribution 证书、App Store profile 与 1.0.0 (5) IPA 已生成
- [x] 将 Worker 与官网变更部署到生产
- [x] 接入 Sign in with Apple token 撤销（删除账户时同步撤销 Apple 授权）
- [x] App Store Connect 创建 App 记录并设置销售地区
- [x] 完成 App Privacy、年龄分级、出口合规与内容版权问卷
- [x] 制作并上传 6.7 英寸 iPhone 截图
- [x] 上传并选择 1.0.0（9）
- [x] 将 Build 9 加入 Bellwire Internal TestFlight
- [x] 生成并核对 Cloudflare Auth 迁移版 1.0.1（13）App Store IPA
- [x] 将 1.0.1（13）安装到配对真机
- [ ] 使用 App Store Connect Issuer ID 验证并上传 1.0.1（13）
- [ ] 解锁真机并打开 1.0.1（13），完成新 Auth session 与 production APNs 验收
- [ ] 将 Bellwire Pro 订阅组、月度和年度订阅加入同一审核草稿
- [ ] 提交审核
- [ ] 使用 TestFlight / App Store 构建在真机验证 production APNs
- [ ] 跟进 Apple 审核结果与可能的 Resolution Center 回复

## App Store 元数据草案

### 名称与副标题

- Name: Bellwire
- Subtitle: Project signals for your iPhone

### Promotional text

Connect AI Agents to native project cards, durable event history, and timely iPhone notifications.

### Description

Bellwire brings the state of every project to your iPhone.

Ask Codex, Claude Code, or another Agent to connect a project. Your Agent configures the live cards and event notifications that matter for that codebase—deployments, revenue, incidents, long-running jobs, and more.

Key features:

- Native SwiftUI project cards and event history
- System notifications for important project events
- One-time pairing codes for Agent setup
- Scoped, revocable credentials for every project
- Sensitive-field filtering for notification text
- English and Simplified Chinese
- Light and dark appearance

Bellwire remains usable when notifications are disabled. You can view projects, cards, and event history in the app at any time.

### Keywords

`developer tools,ai agent,notifications,projects,monitoring,deployments,codex,automation`

### URLs

- Marketing URL: `https://bellwire.app`
- Support URL: `https://bellwire.app/support`
- Privacy Policy URL: `https://bellwire.app/privacy`
- Account deletion: `https://bellwire.app/account-deletion`

## 审核备注草案

Bellwire uses Sign in with Apple, so no shared username or password is required. The reviewer can use the Apple test account available on the review device.

After signing in:

1. Notification permission is optional; choose either Allow or Don’t Allow.
2. On Home, tap “Try a Hosted demo.”
3. Bellwire creates an explicitly Hosted sample project with three live Surfaces for revenue, production-service health, and a monthly goal, plus payment, recovery, and deployment Events. The sample Surfaces, Events, and delivery state are stored by Bellwire Cloud; this demo does not claim Private delivery.
4. Open the event and project to review the core experience.
5. Account deletion is available at Settings → Account → Delete account.

The production backend is available at `https://api.bellwire.app/health`. No external hardware or paid subscription is required.

## 提交前验收

1. 新 Apple 测试账户首次登录成功。
2. 选择“不允许通知”仍能进入 Home、创建 Demo、浏览项目与事件。
3. 选择“允许通知”后，即使 Demo 创建早于首次设备注册，生产 APNs 仍能收到一次示例事件。
4. Demo 二次点击不会重复创建项目、三个 Event、三个 Surface 或通知投递。
5. 删除单个项目后相关事件、Surface 与 token 清除。
6. 删除账户后回到登录页，旧 session 无法继续访问 API。
7. 删除账户后，Sign in with Apple 的 refresh/access token 同步撤销。
8. 四个官网合规 URL 均返回 200，移动端无横向溢出。
9. 归档内包含 `PrivacyInfo.xcprivacy`，版本为 1.0.0（5）。
10. App Store Connect 地区明确排除 China mainland。
11. 截图与文案不展示测试数据、密钥或个人信息。
