# 方案一：微信运行时部署 🖥️

本文供 AI 部署代理执行，目标是在服务器或本地 Linux 环境完成 **微信登录 → 学校授权 → 晚安成电签到 → 随机定时执行**

## 1. 获取代码与部署参数 📦

- **仓库**：https://github.com/MilLoong/UESTC-NightSign-Server.git
- **工作目录**：仓库内 `wechat-runtime/`
- **向使用者确认**：目标机器及访问方式、本人账号、GCJ-02 经纬度、是否启用自动签到
- **默认时间**：每天北京时间 `21:20–22:40` 随机执行，提交前仍检查学校实际开放时段
- **保留现有环境**：检查容器、端口、数据卷和定时器，已有部署优先复用，修改前备份

没有远程服务器时，在保持开机联网的本地 Linux 环境执行相同步骤

## 2. 准备微信与调试环境 ⚙️

1. 检查 Linux x86_64、Docker Compose、内存和磁盘，按资源限制部署
2. 阅读 `compose.yaml`，检查外部卷 `uestc-wx-config-ab` 和 `uestc-wx-debug`
3. 已有卷先核对客户端和调试组件，新环境先创建并初始化卷，不把空卷当作已安装环境
4. 基础镜像使用 `gloridust/wechat-on-cloud:1.4.9`，客户端适配组合为 Linux 微信 `4.1.13.23`、WMPF `25665`
5. 微信安装包核对架构和 SHA256：`b7d0f8d53e9f648bc2c77a6096a04100d008f2d9f0d3988a2a4859b5992aca0a`
6. 准备版本匹配的调试组件及依赖，调试工作目录为 `/work`，通过 `node --import tsx src/index.ts` 启动调试桥
7. 让使用者扫码登录微信，打开“成电智慧学工”，确认目标 appId 为 `wxaa78bf2905f01cee`，进入“晚安成电”

镜像不等于完整客户端和调试器安装包。当前 Compose 使用外部数据卷，AI 必须完成对应卷初始化和缺失组件准备，不能仅执行 `up` 就结束部署

不要同时运行两套使用同一微信数据卷的容器，不使用特权容器、不挂载宿主机 docker.sock、不开放公网 CDP/VNC，不自行创建 Swap

## 3. 安装签到入口 🔑

- `cdp.mjs`：按 appId 选择上下文并调用真实 `wx.login()`
- `checkin.mjs`：读取微信学校会话，查询状态和范围，换取票据并提交签到
- `login.mjs`：独立取码命令，使用 Node.js 22 原生 `WebSocket`
- `checkin.mjs` 使用 `ws`，确保调试环境中的 Node.js 支持 `fetch`，并可解析该依赖

将 `cdp.mjs`、`checkin.mjs` 和私密配置部署到调试容器的 `/work/night-sign/`，配置从 `config.example.json` 复制为 `config.json`，经纬度替换为使用者提供的 GCJ-02 坐标

配置文件权限为 `0600`，目录为 `0700`，凭证及 `attempts.json` 不提交到仓库。不要把示例坐标直接用于其他使用者

现有 systemd 模板使用容器名 `uestc-wx-debug-ab`。若通过 Compose 创建了不同名称的容器，先修改服务中的容器名，再安装服务

## 4. 接通学校签到 🌙

链路由 `checkin.mjs` 执行：

1. 从目标小程序上下文获取学校 `sessionId`，仅在内存中作为 `SESSION` 使用
2. 查询当天状态，已签到则跳过
3. 查询有效时段和本人允许签到范围，检查配置坐标
4. 调用学校逆地址接口生成地址
5. 获取新 `code`，请求 `/platform-app/api/auth/checkin-ticket` 换取 `ticket`
6. 携带 `X-Checkin-Ticket` 请求 `/daily-checkin/api/student-checkin-record/checkin`
7. 查询当天记录，确认 `CHECKED_IN`

先执行仅授权命令，再按使用者授权启用提交：

```sh
docker exec -w /work/night-sign uestc-wx-debug-ab node checkin.mjs --verify
docker exec -w /work/night-sign uestc-wx-debug-ab node checkin.mjs --submit
```

实际定位信息由使用者提供，不伪造实时传感器诊断。提交前写入当天尝试账本，结果不明确时只查询，不自动重复提交

## 5. 安装随机定时任务 ⏰

核对服务中的容器名及命令路径后，将本目录的两个 unit 文件安装到 `/etc/systemd/system/`

```sh
systemd-analyze verify uestc-nightsign.service uestc-nightsign.timer
sudo install -m 644 uestc-nightsign.service /etc/systemd/system/
sudo install -m 644 uestc-nightsign.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now uestc-nightsign.timer
systemctl list-timers uestc-nightsign.timer --all
```

定时器以 北京时间 `21:20` 为基准，加 `0–80 分钟` 随机延迟，每轮重新随机，`Persistent=false` 不补跑错过的任务。重新加载定时器可能在当天再次触发检查，但当天状态及账本必须阻止重复提交

## 6. 运维与交付 🔧

```sh
journalctl -u uestc-nightsign.service -n 30 --no-pager
systemctl disable --now uestc-nightsign.timer
systemctl enable --now uestc-nightsign.timer
node --test cdp.test.mjs checkin.test.mjs
```

- **重启恢复**：明确配置微信和调试桥的进程托管，设备重启后恢复运行，登录过期时提示人工扫码
- **版本升级**：备份卷后再升级，按 WMPF 版本核对调试器，失败时恢复原客户端和卷
- **凭证保护**：日志只输出状态及错误码，不输出 `SESSION`、`code`、`ticket` 和完整位置资料
- **最终交付**：配置路径、容器及服务名、下次执行时间、日志查看方式、停用和回滚命令
