# APP 扫码协议服务 📱

协议运行在服务器，APP 扫码连接后完成微信授权，无需手填服务地址或令牌

## 部署 ⚙️

准备 Docker Compose、Node.js 22 和 cloudflared，在本目录运行：

```bash
node init.mjs
npm ci
docker compose up -d --build core
node dev.mjs --public
```

打开本机管理页面 `http://127.0.0.1:18768/dev/pair`

- **连接服务器**：APP 打开 **设置 → 微信授权 → 扫码连接服务器**，扫描管理页二维码，核对地址后点 **信任并连接**
- **微信授权**：APP 点 **生成二维码**，在另一台设备上展示二维码，用微信摄像头扫码并确认
- **绑定码**：120 秒有效，仅可使用一次，过期后刷新管理页
- **撤销绑定**：在 APP 点 **断开连接**，或在管理页撤销设备
- **账号数据**：协议数据保存在 `yyb-data` 卷，直接运行的网关绑定数据保存在 `.local/`，更新时保留

临时隧道经 Cloudflare 中转并终止 HTTPS，地址变化后需重新绑定。学校登录仍在 APP 内完成

已有协议程序时，也可直接运行 `node dev.mjs --public --core-executable <程序绝对路径>`，不需要 Docker

## 已有 HTTPS 域名 🌐

在 `.env` 增加 `YYB_PUBLIC_ORIGIN=https://你的域名`，运行 `docker compose up -d --build`

将该域名反向代理到 `127.0.0.1:18767`，读取超时至少 75 秒，不缓存响应，Nginx 示例见 `nginx-location.conf`。管理页仍使用本机 `18768` 端口，不经公网代理

云服务器通过 SSH 转发访问管理页：

```bash
ssh -N -L 18768:127.0.0.1:18768 <user>@<server-ip>
```

容器运行时保留 `yyb-data` 和 `yyb-bindings` 两个卷。设备凭据自动生成、按设备撤销，不能用其他设备的绑定读取账号或扫码会话

## 本地测试 🧪

```bash
npm test
```

已有协议服务时，设置 `YYB_CORE_URL` 和 `YYB_CORE_TOKEN` 后运行 `node dev.mjs --public`。`.env` 只用于服务端配置，不需要填入 APP

协议核心来自 [YYB-Go-Enhanced](https://github.com/525815266/YYB-Go-Enhanced)，固定版本为 `8a9497397abc7bf736be462f2e293f2bc6d4d0c0`，其许可与第三方依赖许可需单独核对，不继承本项目的许可
