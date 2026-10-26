# 方案二：会话重放部署 🌐

本文供 AI 部署代理执行，可选择服务器、本地 Linux 或 GitHub Actions，完成 **首次采集 → HTTP 取码 → 学校授权 → 晚安成电签到 → 随机定时执行**

## 1. 获取代码与部署参数 📦

- **仓库**：https://github.com/MilLoong/UESTC-NightSign-Server.git
- **工作目录**：仓库内 `session-replay/`
- **向使用者确认**：目标机器及访问方式、本人学校会话、首次采集用的微信环境、GCJ-02 经纬度及自动签到开关
- **运行环境**：Python 3.12，可使用本目录 Docker 部署，也可在 GitHub Actions runner 运行，日常无需常驻微信
- **默认时间**：每天北京时间 `21:20–22:40` 随机一次

没有远程服务器时，可选择本地部署或 GitHub Actions，本地模式需保持开机联网，Actions 模式无需自己的设备常驻

## 2. 模块分工 🧩

- `login_replay/protocol.py`：MMTLS、AES-GCM、压缩数据与 Protobuf 解码
- `login_replay/state.py`：状态文件权限、应用身份与保存响应的完整性校验
- `login_replay/transport.py`：向固定微信目的地发送一次请求，仅对连接级错误做有限重试
- `login_replay/__main__.py`：离线检查、在线取码、重复 code 指纹账本及可选私密输出
- `login_replay/checkin.py`：签到入口，复用取码模块完成当天状态/时段/范围校验、换票、单次提交与回查
- `Dockerfile`、`compose.yaml`：受限权限的服务器运行环境
- `../wechat-runtime/checkin.mjs`：同语义的 JS 参考实现

本目录同时提供取码工具和签到入口。首次采集可复用上游 MIT 项目的采集工具（见第 3 节），学校 `SESSION` 由使用者提供。

## 3. 准备首次采集与私密状态 🔑

1. 准备本人已登录的微信及目标小程序 `wxaa78bf2905f01cee`
2. 首次采集可复用上游 MIT 项目 fanrea/uestc-checkin-actions-public 的 Windows 采集工具：`tools/windows/trace_login_request.py` 触发并抓取登录请求，`tools/windows/prepare_pure_login_state.py` 生成 `version=1` 状态（字段与本目录一致）；也可按实际微信版本自行适配原生调用与偏移
3. 采集适配组合为 Windows 微信 `4.1.15.56`、WMPF `25799`，其他版本需重新适配，不将 Windows 偏移直接用于 Linux
4. 生成 `version=1` 状态，包含 `appId`、`httpRequest`、`capturedHttpResponse`、`mmtlsSecret`、`businessResponseKey`、`businessResponseAad`、`capturedCodeHash`
5. 安全传输至部署目录 `private/login-state.json`，另行准备本人学校 `SESSION`
6. 使用状态校验模块检查应用身份和保存响应的解密结果，再继续部署

状态和采集目录均按凭证保护，Base64 不是加密。捕获状态没有自动过期检查，建议采集后尽快使用；失效时重新采集。学校 `SESSION` 过期时更新本人会话，不默认存在密码登录或自动续期能力

## 4. 部署取码容器 🐳

从本目录执行，先安全放入状态文件：

```sh
mkdir -p private/data
chmod 700 private private/data
sudo chown 10001:10001 private/login-state.json private/data
sudo chmod 600 private/login-state.json
docker compose build
docker compose run --rm replay
```

- 容器 UID 为 `10001`，状态文件和可写数据目录必须具有相应权限
- 默认命令只检查保存响应，不进行在线请求
- 传输外层为 HTTP 80，内部报文通过 MMTLS 加密
- 构建上下文排除私密文件，不将凭证打入镜像

显式在线取码：

```sh
docker compose run --rm replay \
  --state /run/secrets/login-state.json --online
```

在线 CLI 不带 `--code-file` 时丢弃原始 code，仅记录指纹。需要交给业务层时，优先在同一进程中调用取码函数并保留重复检测，不解析普通日志获取凭证

## 5. 接通学校业务 🌙

本目录已提供签到入口 `login_replay/checkin.py`，复用已拆分的协议和取码模块：

1. 加载本人学校 `SESSION`、位置配置和状态文件，不向其他服务传输学校 Cookie
2. 查询当天签到状态、有效时段及本人允许范围，已签到或不符合条件则停止
3. 调用学校逆地址接口获取配置坐标对应地址
4. 通过重放获取新 code，自动检查是否为采集时旧值或已领取值
5. 请求 `https://jzsz.uestc.edu.cn/platform-app/api/auth/checkin-ticket`，提交 `{code}` 并使用 `platform: mp-weixin`
6. 携带 `X-Checkin-Ticket`、学校 Cookie 及 `platform: h5`，向 `/daily-checkin/api/student-checkin-record/checkin` 提交位置及客户端字段
7. 查询当天状态，确认 `CHECKED_IN`，而不是仅检查 HTTP 200

私密配置示例（`private/checkin-config.json`，`state`/`ledger` 等相对路径按配置文件所在目录解析）：

```json
{
  "state": "login-state.json",
  "session": "<本人学校 SESSION，不含 SESSION= 前缀>",
  "location": {"latitude": 30.75, "longitude": 103.93, "coordinateSystemCode": "gcj02"},
  "userAgent": "UESTC-NightSign-Server/1.0",
  "ledger": "data/attempts.sqlite"
}
```

先执行仅授权模式，再按使用者授权显式提交：

```sh
python -m login_replay.checkin --config private/checkin-config.json --verify
python -m login_replay.checkin --config private/checkin-config.json --submit
```

Docker 部署时把配置作为只读文件挂入容器，并复用镜像里的 Python 入口：

```sh
docker compose run --rm --entrypoint python replay \
  -m login_replay.checkin --config /run/secrets/checkin-config.json --verify
```

此时配置中的 `state` 写 `/run/secrets/login-state.json`，`ledger` 写 `/data/attempts.sqlite`。

定位资料由使用者提供，不伪造实时定位诊断。方案二没有微信运行时，学校 `SESSION` 无法自动重建，失效后更新配置即可

指纹账本为 `private/data/codes.sqlite`，签到入口另设当天提交账本和进程锁。网络超时或结果不明确时先查询当天状态，不自动重试签到，也不复用旧 code

## 6. 配置随机定时执行 ⏰

安装 systemd service 和 timer 时，把执行命令换成本方案的签到入口（`python -m login_replay.checkin --config ... --submit`），不要继续调用微信容器

- **时间基准**：北京时间
- **基准**：每天 `21:20`
- **随机延迟**：`0–80 分钟`，每轮重新随机
- **窗口**：`21:20–22:40`，提交前再次检查学校实际时段
- **补跑**：`Persistent=false`，不在错过时间或截止后补交
- **防重**：当天状态检查、进程锁和提交账本共同保护

完成后通过 `systemctl list-timers` 确认下一次执行时间，提供真实 unit 名称及停用命令，不自动启用配置尚未完整的签到任务

### GitHub Actions 部署分支 ☁️

选择 Actions 时，工作流需自行编写（仓库不内置 `.github/workflows/`），不安装 systemd 定时器

- 首次采集仍在兼容的微信环境完成，将状态、学校会话和位置配置存入 GitHub Actions Secrets，不提交到源码或构建产物
- 设置手动触发和定时触发，默认关闭真实提交，明确启用后运行签到业务入口
- 配置默认分支、最小权限、超时及 `concurrency`，避免定时、手动运行和重新运行相互重叠
- 定时触发后按北京时间选择窗口内目标时刻，若启动已迟于目标则直接检查当前窗口，超过允许范围则跳过，不继续额外等待
- Actions 调度可能延迟，随机执行不能保证精确触发，提交前必须再次检查学校时段及当天状态
- runner 为临时环境，本地指纹及提交账本不会自动跨运行保留，需设计持久化方案；严格保证提交结果不明确时不重复提交，不能只依赖 `concurrency`
- 不在日志、缓存或 artifact 中保存原始 code、ticket、会话密钥或完整位置；持久化仅保留必要指纹和提交状态
- 参考 [GitHub 定时触发说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) 完成调度配置，避免与服务器任务同时启用

## 7. 运维与交付 🔧

- 学校会话过期时更新本人 `SESSION`，微信重放状态失效时重新采集
- 取码失败先区分：连接级错误已自动重试 1 次；HTTP/协议拒绝说明捕获状态已失效，需要重新采集
- 停止微信进程与退出账号不是同一操作，日常运行不需要常驻微信，但仍依赖服务端接受会话
- 日志只记录阶段、状态和错误码，不输出密钥、Cookie、code、ticket 或完整位置
- 保留现有部署及私密数据备份，更新时不覆盖当天防重复账本
- 交付业务入口、配置样例、启动及停止方式、定时器、日志路径与恢复步骤
- 修改协议或业务逻辑后执行 `python -m unittest discover -s tests -v`

## 8. 许可 📄

协议模块与合成测试夹具使用的版权和许可见 [MIT 许可](LICENSE.upstream)
