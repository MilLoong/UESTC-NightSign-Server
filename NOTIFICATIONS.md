# Server酱通知 🔔

三种方案均支持 Server酱 Turbo，正式签到任务结束后推送成功、已签到、失败或结果不确定，`--verify` 不发送通知。推送失败不会改变签到结果，也不会重发签到请求

## 配置 ⚙️

在 [Server酱 Turbo](https://sct.ftqq.com/) 绑定微信并获取 SendKey，创建私密文件 `notify.json`：

```json
{"enabled": true, "sendKey": "<你的 SendKey>"}
```

- **方案一**：放在容器内 `/work/night-sign/notify.json`，与 `checkin.mjs` 同目录
- **方案二**：放在 `--config` 指定配置文件的同目录，容器部署时将文件一同挂载
- **方案三**：放在传入 `checkin.mjs` 的配置文件同目录
- **权限**：目录 `0700`、文件 `0600`，不要把密钥放进命令历史或日志。`notify.json` 已被 Git 忽略
- **停用**：设置 `enabled` 为 `false`，或移走配置文件。未配置时不影响签到
- **GitHub Actions**：将密钥存入仓库 Secret，由工作流在运行时生成私密配置，不上传到缓存或构建产物

方案一可在实际运行目录执行 `node notify.mjs` 发送“通知通道测试（未执行签到）”，不会访问学校签到接口。API 返回 `accepted` 代表推送服务已受理，仍需确认微信收到消息

通知不包含学号、姓名、位置、学校会话或票据。不自动重试推送，避免重复消息。服务器停机或任务未触发时无法自行通知，漏执行提醒需另设独立监控
