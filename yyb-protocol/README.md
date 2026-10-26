# 应用宝协议部署指南 📱

供部署 Agent 执行，完成环境准备、扫码授权、学校登录态配置、晚安成电签到及定时任务

**部署 Prompt**：[打开并复制](PROMPT.md)

## 部署要求 ⚙️

- **目标小程序**：成电智慧学工，`appId` 为 `wxaa78bf2905f01cee`
- **学校登录**：本人微信已在成电智慧学工绑定学校身份时，`checkin.mjs` / `verify.mjs` 会自动用 `YYB code -> check-bind -> SESSION` 获取并刷新学校会话，无需单独进行 CAS 登录，也无需预先填写 `session`
- **环境检查**：先确认目标系统、CPU 架构、Node.js、端口及已有任务，保留授权数据、私密配置和当天账本
- **用户输入**：集中确认部署位置、微信学校身份绑定情况及 GCJ-02 坐标，扫码和必要的身份认证交给用户，其余安装和配置由 Agent 执行
- **部署入口**：自行获取本仓库并执行本文件步骤，不要求用户提前克隆或手动逐条运行命令

## 本机运行 ⚙️

需要在 APP 内生成二维码、扫码并自动保存账号时，使用 [APP 扫码协议服务](mobile/README.md)

准备 Node.js 20 或更新版本，以及适配目标系统架构的 [YYB-Go-Enhanced](https://github.com/525815266/YYB-Go-Enhanced) `0.2.33` 服务程序，核对来源和校验值

1. 在本目录打开 PowerShell，启动服务：

   ```powershell
   .\Start-Local.ps1 -Executable '<服务程序的绝对路径>'
   ```

   服务仅监听 `127.0.0.1:18766`，协议令牌、账号状态和日志保存在私有目录 `.local/`，不要提交到仓库或开放公网访问

2. 生成二维码，用手机微信扫码并确认授权：

   ```powershell
   node .\qr.mjs create
   ```

   打开输出路径对应的二维码图片，扫码后检查状态并保存账号：

   ```powershell
   node .\qr.mjs poll
   node .\qr.mjs confirm
   ```

3. 将 `config.example.json` 复制为 `.local/verify-config.json`，自行填写：

   - `settings.endpoint`：本机默认使用 `http://127.0.0.1:18766`
   - `settings.token`：填写 `.local/yyb.env` 中的 `YYB_PROTOCOL_TOKEN`
   - `settings.ref`：填写 `.local/account.json` 中的账号 `id`，使用字符串格式
   - `session`：可选，留空即可。程序在会话缺失或失效时自动 `check-bind` 获取，成功后写回该文件作为缓存（只写本机私密配置，不输出到日志）

   学校会话获取与恢复（已内置，无需手工执行）：

   - 调用 `getYybCode(settings)` 获取目标小程序的新 `code`
   - 向学校 `/platform-app/api/auth/check-bind` 发送 `POST`，设置 `platform: mp-weixin`，请求体为 `{ "code": "本次新获取的 code", "sn": "" }`，不携带旧学校 Cookie
   - 确认响应成功、`data.bind === true` 且 `data.sessionId` 有效，将其作为 `session` 写回私密配置
   - 兑换 `checkin-ticket` 时重新获取一个 `code`，不能重复使用已用于 `check-bind` 的值
   - 遇到明确的会话失效（HTTP 401 / 业务码 4001）时自动重建会话并重试一次查询，不因认证失败或请求超时自动重发签到提交
   - 学校返回未绑定时停止流程，请用户进入成电智慧学工完成学校身份绑定后重试

4. 验证学校签票，不提交签到：

   ```powershell
   node .\verify.mjs .\.local\verify-config.json
   ```

   成功时仅输出状态、目标 `appId`、凭证长度及 `checkinSubmitted: false`，不输出 `code`、`ticket` 或学校会话

## 签到与定时任务 ⏰

- Linux 部署时使用协议服务参数 `-host 127.0.0.1 -port 18766 -resource-root <私密资源目录> -env-file <私密环境文件>`，设置 `YYB_AUTH_DRIVER=sqlite`、`YYB_PROTOCOL_TOKEN` 和 `YYB_ENABLE_PC_LOGIN=false`，使用独立服务用户并配置重启策略
- `qr.mjs` 从 `.local/yyb.env` 读取协议令牌，Linux 环境也需准备该文件，不直接运行 Windows 启动脚本

- 在私密配置中增加 `location` 对象，填写本人实际位置的 `longitude`、`latitude`，并设置 `coordinateSystemCode` 为 `gcj02`
- 运行完整前置验证及签到：

  ```powershell
  node .\checkin.mjs .\.local\verify-config.json --verify
  node .\checkin.mjs .\.local\verify-config.json --submit
  ```

  签到入口复用方案一的时段、范围、当天记录和重复提交保护，提交结果不明确时只查询，不自动重发

- Linux 定时部署：仓库放在 `/opt/UESTC-NightSign-Server`，准备 Node.js 20 或更新版本及已授权的应用宝协议服务
- 创建专用用户 `uestc-nightsign`，允许其读取仓库，将私密配置放入 `/var/lib/uestc-yyb/config.json`，使该用户拥有目录和配置，权限分别为 `0700`、`0600`
- 将本目录的 `uestc-yyb-checkin.service` 和 `uestc-yyb-checkin.timer` 复制到 `/etc/systemd/system/`，根据实际环境核对路径后启用：

  ```bash
  sudo systemctl daemon-reload
  sudo systemctl enable --now uestc-yyb-checkin.timer
  systemctl list-timers uestc-yyb-checkin.timer
  journalctl -u uestc-yyb-checkin.service
  ```

  每天北京时间 `21:20–22:40` 随机触发，不补跑错过的任务，执行时仍检查学校返回的实际时段

- 进程异常退出可能遗留私密目录内的 `checkin.lock`，先确认没有任务仍在运行，再移除锁文件，不要删除当天尝试记录后盲目重试
- CAS 仅作为需要独立学校认证时的可选方案，可参考 [UESTC-EAMS-Helper-Python](https://github.com/MilLoong/UESTC-EAMS-Helper-Python) 的统一认证、二次认证和 Cookie 缓存逻辑，适配学工平台的 `service`、换票流程及登录成功判断，不能直接复用教务系统的业务会话
- Windows 本地部署由 Agent 配置任务计划程序，实现相同随机区间和单实例约束，执行期间保持电脑开机和网络可用
- 按用户授权启用真实提交及定时任务，保留原有方案作为回滚路径，不同时运行两套签到任务
- 部署完成后提供实际配置路径、服务名称、下一次执行时间，以及日志查看、停用、更新和回滚命令，不只输出计划
