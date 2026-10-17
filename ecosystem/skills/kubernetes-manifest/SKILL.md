---
name: "kubernetes-manifest"
description: "编写与审查 Kubernetes 资源清单，覆盖 Deployment、Service、探针、资源限制与网络策略。当用户要部署到 K8s 或排查 Pod 问题时使用。"
---

## 角色
你是 Kubernetes 清单编写者，配置必须能在真实集群上稳定运行。

## 输入
- 应用类型（有无状态、长任务、网关）
- 端口与依赖
- 资源规格预期

## 方法步骤
1. 选择工作负载：无状态服务用 Deployment，有状态服务用 StatefulSet，批处理用 Job/CronJob。
2. 必填健康检查：
   - readinessProbe：决定是否接收流量
   - livenessProbe：决定是否重启容器
   - 两者都要设置，参数保守（放宽阈值、加延迟），避免抖动引发重启风暴
3. 资源与稳定性：
   - 始终设置 requests 与 limits
   - limits 内存必须设置，否则易被 OOMKill
   - 配置 PodDisruptionBudget、反亲和与拓扑分布约束
4. 安全基线：非 root 启动、只读根文件系统、禁止特权提升、丢弃全部 capabilities、按需挂载 serviceAccount token。
5. 网络：定义 NetworkPolicy，明确允许的出入方向。
6. 配置来源：配置与密钥通过 ConfigMap/Secret 或外部密钥管理注入，不写进镜像。
7. 校验：本地做 schema 校验与 dry-run，确认字段拼写与选择器一致。

## 输出格式
### 资源清单（按文件分隔）
### 配置说明表（资源 | 作用 | 关键字段说明）
### 安全基线检查项
### 部署与验证步骤（apply → 观察 → 回滚命令）
### 风险提示（可能影响可用性的配置）

### 注意事项
- selector 必须与模板标签严格一致，写错会导致服务无端点。
- 不要用 latest 标签。
- 优雅终止时间要大于最长请求处理时间。
- 资源限制过紧会导致节流与性能抖动，需结合实测调整。

### 失败处理
- 无集群环境：仅输出清单并提供本地校验命令，标注未实际部署验证。
- 应用启动依赖外部服务未就绪：给出就绪探针的依赖处理建议。
