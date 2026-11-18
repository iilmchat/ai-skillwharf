# Kubernetes (Enterprise, без `/dev/kvm`)

Базовые манифесты для Stage 2 (`Sprint 25`). Они заменяют Compose one-shot
`db-migrate` на Kubernetes Job (KI-037) и запускают `sandbox-worker` под
gVisor (`runsc`) на узлах без аппаратной виртуализации.

## Состав манифестов

| Файл | Назначение |
| --- | --- |
| `deploy/k8s/runtimeclass-gvisor.yaml` | `RuntimeClass gvisor` с `handler: runsc`. |
| `deploy/k8s/job-db-migrate.yaml` | Job `prisma migrate deploy`, `backoffLimit: 3`, `ttlSecondsAfterFinished: 600`. |
| `deploy/k8s/deployment-sandbox-worker.yaml` | Deployment с `runtimeClassName: gvisor`, read-only rootfs и `capabilities.drop: ALL`. |
| `deploy/k8s/networkpolicy-deny-egress.yaml` | Запрет прямого egress для `api`, `llm-worker`, `sandbox-worker`; разрешены DNS и `egress-proxy`. |

## Подготовка

1. Установите `runsc` на узлы и зарегистрируйте его в `containerd` как
   `runtime_type = "io.containerd.runsc.v1"`. Убедитесь, что `kubectl get nodes`
   показывает узлы, готовые принимать поды с `runtimeClassName: gvisor`.
2. Создайте namespace и секрет. Настоящие значения держите в секрет-менеджере,
   а не в репозитории:

   ```bash
   kubectl create namespace skillwharf
   kubectl -n skillwharf create secret generic skillwharf-secrets \
     --from-literal=DATABASE_URL="$DATABASE_URL"
   ```

3. Опубликуйте образы `ai-skillwharf-db-migrate:latest` и
   `ai-skillwharf-sandbox-worker:latest` в registry, доступном кластеру.
   В манифестах стоит `imagePullPolicy: IfNotPresent`; для удалённого registry
   замените его на `Always` и добавьте `imagePullSecrets`.

## Порядок развёртывания

```bash
kubectl apply -f deploy/k8s/runtimeclass-gvisor.yaml
kubectl apply -n skillwharf -f deploy/k8s/job-db-migrate.yaml
kubectl -n skillwharf wait --for=condition=complete job/db-migrate --timeout=300s

kubectl apply -n skillwharf -f deploy/k8s/deployment-sandbox-worker.yaml
kubectl apply -n skillwharf -f deploy/k8s/networkpolicy-deny-egress.yaml
```

Миграции должны завершиться **до** раскатки приложений. Job с `backoffLimit: 3`
не запускает параллельных реплик Prisma и не оставляет работающие поды после успеха
(`ttlSecondsAfterFinished`). В Compose прежний one-shot `db-migrate` остаётся:
K8s и Compose — разные среды.

## Проверка gVisor

```bash
kubectl get runtimeclass gvisor
kubectl -n skillwharf get pod -l app=sandbox-worker -o jsonpath='{.items[0].spec.runtimeClassName}'
kubectl -n skillwharf logs -l app=sandbox-worker --tail=20
```

В логах `sandbox-worker` должна быть строка `listening on :4000`; SECcomp
профиль остаётся опциональным (`SANDBOX_SECCOMP_PROFILE` внутри worker).
gVisor не требует `/dev/kvm`: системные вызовы обрабатывает userspace-ядро
`runsc`. Если узел с KVM и нужен Firecracker, используйте отдельный
`RuntimeClass` — этот манифест для gVisor.

## NetworkPolicy

Политика требует CNI с поддержкой `NetworkPolicy` (Calico, Cilium и др.).
Разрешены только:

- DNS через `kube-dns` в `kube-system` (TCP/UDP 53);
- соединения к подам с меткой `app: egress-proxy` в namespace `skillwharf`.

Все прочие исходящие соединения из `api`, `llm-worker` и `sandbox-worker`
запрещены. Если egress-прокси развёрнут под другой меткой, обновите
`podSelector` в манифесте.

## Ограничение sandbox-provider

В Compose worker монтирует `/var/run/docker.sock`. В K8s `hostPath` с
Docker-сокетом не используется: это фактически root-доступ к узлу и обход
gVisor. Текущий Deployment — база: перед продакшеном подключите удалённый
sandbox-provider (отдельный раннер с собственным `RuntimeClass`) и направьте
запросы worker к нему. Пока провайдера нет, контейнеры навыков в K8s не
запускаются — используйте Compose для пилота.
