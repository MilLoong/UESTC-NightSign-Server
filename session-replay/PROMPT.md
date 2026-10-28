# 会话重放部署 Prompt 🌐

复制代码块内容 交给 AI，按仓库内的 部署手册 执行

```text
请将 https://github.com/MilLoong/UESTC-NightSign-Server.git 的 session-replay 方案部署到我选择的服务器、本地 Linux 或 GitHub Actions。先确认部署方式，再自行获取代码，阅读 session-replay/README.md，完成首次采集、私密状态准备、HTTP 取码、学校认证、晚安成电签到和定时任务，不要求我预先手动克隆仓库。

以当前仓库为实现入口，复用 login_replay 内的协议、状态、传输和签到模块，不另行克隆其他项目替代实现。首次采集使用本仓库内置的 capture/windows（python -m capture.windows.collect 取状态，python -m capture.windows.get_cookie 导出学校 SESSION），签到入口为 python -m login_replay.checkin；本方案的日常运行不要依赖常驻微信。

向我集中确认目标机器、首次采集用的微信环境、本人学校会话及 GCJ-02 坐标。由我完成扫码和必要授权，其余部署由你执行。采集按实际版本适配，Windows 微信 4.1.15.56、WMPF 25799 为适配组合，不将 Windows 偏移用于 Linux。

准备 version=1 状态文件，通过受保护通道传输并设置私密权限。先检查保存响应的解密结果，再在线取新 code 并兑换学校 ticket。保留原始 code 和重复指纹检查，凭证仅在内存或受限私密文件中流转，不从普通日志提取。

完成当天状态、实际签到时段、本人允许范围和逆地址查询，再携带票据提交 daily-checkin 并查询当天记录。先执行仅授权模式，再按我的授权启用真实提交。使用本人提供的位置资料，不伪造实时传感器诊断。

定时每天按北京时间 21:20–22:40 随机一次，提交前重新检查学校时段，不补跑错过的任务。服务器或本地模式配置进程锁、当天账本和系统定时器；Actions 模式自行编写工作流，配置 Secrets、最小权限、超时和 concurrency，处理调度延迟及临时 runner 的跨运行状态持久化。不要同时启用两处调度，结果不明确时仅查询，不自动重复提交。签到入口与取码 CLI 分开使用，不要把取码 CLI 当作签到任务。

状态失效时停止并提示重新采集，学校 SESSION 过期时更新本人会话，不假定无限有效或自动续期。保护密钥、Cookie、code、ticket 和位置资料，不写入仓库或普通日志，保留 MIT 许可。

最终给出实际业务入口、私密配置路径、服务名称、下一次执行时间、日志查看、停用、更新及恢复命令。不要只给建议或部署计划，要在可访问的目标环境中实际完成配置。

询问是否启用 Server酱通知，启用时按 NOTIFICATIONS.md 在签到配置同目录准备私密 notify.json，由我提供 SendKey，不写入仓库或日志。Actions 模式使用 Secret 注入，不上传密钥到缓存或产物。正式任务仅推送脱敏结果，通知失败不重发签到。
```
